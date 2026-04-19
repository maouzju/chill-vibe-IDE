import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { rm, stat } from 'node:fs/promises'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { IpcMainInvokeEvent, WebContents } from 'electron'

import { maxUiScale, minUiScale } from '../shared/default-state.js'
import { getAppDataDir } from '../server/app-paths.js'
import { initCrashLogger, log } from './crash-logger.js'
import { createDesktopBackend } from './backend.js'
import { resolveMessageLocalLinkTarget } from './message-local-link.js'
import {
  resolveDesktopDataDir,
  resolveDesktopRuntimeProfilePaths,
  resolveDesktopRuntimeKind,
  resolveDesktopWorkingDirectory,
} from './runtime-environment.js'
import { checkForUpdate, downloadUpdate, installUpdate } from './updater.js'
import {
  attachmentProtocolScheme,
  getRendererLoadTarget,
} from './runtime-target.js'
import {
  getWindowIconPathForPlatform,
  getTitleBarStyleForPlatform,
  shouldUseCustomWindowFrameForPlatform,
  shouldRemoveMenuForPlatform,
} from './window-options.js'
import { flashWindowOnce, focusPrimaryWindow, presentWindow } from './window-lifecycle.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const projectRoot = path.resolve(moduleDir, '../..')
const clientDistDir = path.resolve(moduleDir, '../client')

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3')
}

app.disableHardwareAcceleration()
const devClientUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
const quitFlushDelayMs = 750
const quitFlushTimeoutMs = 5000
const devRendererBootstrapDelayMs = 750
const bypassSingleInstanceLock = process.env.CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK === '1'
const desktopWorkingDirectory = resolveDesktopWorkingDirectory({ isDev, moduleDir })
const desktopRuntimeProfilePaths = resolveDesktopRuntimeProfilePaths({ isDev, projectRoot })
const desktopRuntimeKind = resolveDesktopRuntimeKind({ isDev })
const clearUserDataArg = '--clear-user-data'
const shouldClearUserDataOnLaunch = process.argv.includes(clearUserDataArg)
const allowSharedDataDirOverride =
  process.env.CHILL_VIBE_ALLOW_SHARED_DATA_DIR === '1' ||
  process.argv.includes('--allow-shared-data-dir')
const shouldKeepValidationWindowHidden = process.env.CHILL_VIBE_HEADLESS_RUNTIME_TESTS === '1'

const audioProtocolScheme = 'chill-vibe-audio'

protocol.registerSchemesAsPrivileged([
  { scheme: attachmentProtocolScheme, privileges: { supportFetchAPI: true, secure: true } },
  { scheme: audioProtocolScheme, privileges: { supportFetchAPI: true, secure: true, stream: true } },
])

if (desktopRuntimeProfilePaths) {
  app.setPath('userData', desktopRuntimeProfilePaths.userData)
  app.setPath('sessionData', desktopRuntimeProfilePaths.sessionData)
}

const desktopBackend = createDesktopBackend()
const streamSubscriptions = new Map<string, { webContentsId: number; unsubscribe: () => void }>()
const hasSingleInstanceLock = bypassSingleInstanceLock ? true : app.requestSingleInstanceLock()

let quitTimer: NodeJS.Timeout | null = null
let quitAfterFlushPending = false

function configureDesktopEnvironment() {
  if (desktopWorkingDirectory) {
    process.chdir(desktopWorkingDirectory)
  }

  process.env.CHILL_VIBE_RUNTIME_KIND = desktopRuntimeKind
  process.env.CHILL_VIBE_DATA_DIR = resolveDesktopDataDir({
    isDev,
    projectRoot,
    userDataPath: app.getPath('userData'),
    configuredDataDir: process.env.CHILL_VIBE_DATA_DIR,
    allowConfiguredOverride: allowSharedDataDirOverride,
  })

  if (!('CHILL_VIBE_DEFAULT_WORKSPACE' in process.env)) {
    process.env.CHILL_VIBE_DEFAULT_WORKSPACE = isDev ? projectRoot : ''
  }
}

function loadWindowUrl(win: BrowserWindow, url: string, attempts = 0) {
  void win.loadURL(url)
    .then(async () => {
      if (isDev) {
        try {
          const didBootstrap = await win.webContents.executeJavaScript(
            `
              new Promise((resolve) => {
                window.setTimeout(async () => {
                  try {
                    const root = document.getElementById('root')
                    if (!root || root.childElementCount > 0) {
                      resolve(false)
                      return
                    }

                    await import(${JSON.stringify(`/src/main.tsx?cv-dev-boot=${Date.now()}`)})
                    resolve(true)
                  } catch (error) {
                    console.error('[chill-vibe] Dev bootstrap import failed.', error)
                    resolve(false)
                  }
                }, ${devRendererBootstrapDelayMs})
              })
            `,
          )

          if (didBootstrap) {
            log.warn('[main] Re-ran dev renderer bootstrap after detecting an empty root shell.')
          }
        } catch (error) {
          log.warn('[main] Failed to verify dev renderer bootstrap state.', error)
        }
      }

      if (!shouldKeepValidationWindowHidden) {
        presentWindow(win)
      }
    })
    .catch((err: unknown) => {
      log.warn('[main] Failed to load window URL, attempt', attempts, err)
      if (attempts < 40) {
        setTimeout(() => loadWindowUrl(win, url, attempts + 1), 500)
      }
    })
}

function scheduleQuitAfterFlush() {
  if (quitAfterFlushPending) {
    return
  }

  quitAfterFlushPending = true
  quitTimer = setTimeout(() => {
    quitTimer = null
    log.warn('[main] Pending state flush timed out; continuing quit.', {
      windowCount: BrowserWindow.getAllWindows().length,
    })
    app.quit()
  }, quitFlushTimeoutMs)

  void (async () => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('app:flush-state-before-quit')
        }
      }

      await new Promise((resolve) => setTimeout(resolve, quitFlushDelayMs))
      await desktopBackend.flushStateWrites()
    } catch (error) {
      log.warn('[main] Failed to flush pending state before quit.', error)
    } finally {
      if (quitTimer) {
        clearTimeout(quitTimer)
        quitTimer = null
      }
    }

    app.quit()
  })()
}

function getRelaunchArgs(extraArgs: string[] = []) {
  const baseArgs = process.argv.slice(1).filter((value) => value !== clearUserDataArg)
  return [...baseArgs, ...extraArgs]
}

function relaunchToClearUserData() {
  app.relaunch({
    args: getRelaunchArgs([clearUserDataArg]),
  })
  setTimeout(() => app.quit(), 150)
}

async function clearUserDataOnLaunchIfNeeded() {
  if (!shouldClearUserDataOnLaunch) {
    return
  }

  const dataDir = getAppDataDir()
  await rm(dataDir, { recursive: true, force: true })
}

function cleanupSubscriptionsForContents(webContents: WebContents) {
  for (const [subscriptionId, entry] of streamSubscriptions.entries()) {
    if (entry.webContentsId !== webContents.id) {
      continue
    }

    entry.unsubscribe()
    streamSubscriptions.delete(subscriptionId)
  }
}

function getEventWindow(event: IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender)
    ?? BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows()[0]
}

const clampUiZoomFactor = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maxUiScale, Math.max(minUiScale, value))
    : 1

function broadcastWindowState(win: BrowserWindow) {
  if (!win.isDestroyed()) {
    win.webContents.send('window:maximized-changed', win.isMaximized())
  }
}

function attachWindowDiagnostics(win: BrowserWindow) {
  log.info('[main] BrowserWindow created.', {
    windowId: win.id,
  })

  win.on('close', () => {
    log.warn('[main] BrowserWindow close requested.', {
      windowId: win.id,
      visible: win.isVisible(),
      focused: win.isFocused(),
    })
  })

  win.on('closed', () => {
    log.warn('[main] BrowserWindow closed.', {
      windowId: win.id,
    })
  })

  win.on('unresponsive', () => {
    log.warn('[main] BrowserWindow became unresponsive.', { windowId: win.id })
  })

  win.webContents.on('did-finish-load', () => {
    log.info('[main] Renderer finished load.', {
      windowId: win.id,
      url: win.webContents.getURL(),
    })
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('[main] Renderer process gone.', {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    log.warn('[main] Renderer failed to load.', {
      windowId: win.id,
      errorCode,
      errorDescription,
      validatedUrl,
      isMainFrame,
    })
  })
}

async function registerAttachmentProtocol() {
  if (await protocol.isProtocolHandled(attachmentProtocolScheme)) {
    return
  }

  protocol.handle(attachmentProtocolScheme, async (request) => {
    try {
      const url = new URL(request.url)
      const attachmentId = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const filePath = await desktopBackend.resolveAttachmentPath(attachmentId)
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Attachment not found.', { status: 404 })
    }
  })
}

// audioProtocolScheme is declared at module top for registerSchemesAsPrivileged

function registerAudioProtocol() {
  protocol.handle(audioProtocolScheme, async (request) => {
    try {
      const url = new URL(request.url)
      const generator = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const filePath = await desktopBackend.ensureAmbientAudio(generator)
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Audio not found.', { status: 404 })
    }
  })
}

function registerDesktopHandlers() {
  ipcMain.handle('window:minimize', (event) => {
    const win = getEventWindow(event)
    win?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = getEventWindow(event)

    if (!win) {
      return false
    }

    if (win.isMaximized()) {
      win.unmaximize()
      return false
    }

    win.maximize()
    return true
  })
  ipcMain.handle('window:close', (event) => {
    getEventWindow(event)?.close()
  })
  ipcMain.handle('window:flash-once', (event) => flashWindowOnce(getEventWindow(event)))
  ipcMain.handle('window:set-zoom-factor', (event, zoomFactor: number) => {
    getEventWindow(event)?.webContents.setZoomFactor(clampUiZoomFactor(zoomFactor))
  })
  ipcMain.handle('window:is-maximized', (event) => getEventWindow(event)?.isMaximized() ?? false)

  ipcMain.handle('desktop:fetch-state', () => desktopBackend.fetchState())
  ipcMain.handle('desktop:load-session-history-entry', (_event, request) =>
    desktopBackend.loadSessionHistoryEntry(request),
  )
  ipcMain.handle('desktop:save-state', (_event, state) => desktopBackend.saveState(state))
  ipcMain.on('desktop:queue-state-save', (_event, state) => {
    desktopBackend.queueStateSave(state)
  })
  ipcMain.handle('desktop:sync-runtime-settings', (_event, settings) =>
    desktopBackend.syncRuntimeSettings(settings),
  )
  ipcMain.handle('desktop:reset-state', () => desktopBackend.resetState())
  ipcMain.handle('desktop:resolve-state-recovery-option', (_event, request) =>
    desktopBackend.resolveStateRecoveryOption(request),
  )
  ipcMain.handle('desktop:capture-renderer-crash', (_event, request) =>
    desktopBackend.captureRendererCrash(request),
  )
  ipcMain.handle('desktop:dismiss-recent-crash-recovery', () =>
    desktopBackend.dismissRecentCrashRecovery(),
  )
  ipcMain.handle('desktop:fetch-providers', () => desktopBackend.fetchProviders())
  ipcMain.handle('desktop:import-cc-switch-routing', (_event, request) =>
    desktopBackend.importCcSwitchRouting(request),
  )
  ipcMain.handle('desktop:fetch-setup-status', () => desktopBackend.fetchSetupStatus())
  ipcMain.handle('desktop:run-environment-setup', () => desktopBackend.runEnvironmentSetup())
  ipcMain.handle('desktop:fetch-onboarding-status', () => desktopBackend.fetchOnboardingStatus())
  ipcMain.handle('desktop:fetch-git-status', (_event, workspacePath) =>
    desktopBackend.fetchGitStatus(workspacePath),
  )
  ipcMain.handle('desktop:set-git-stage', (_event, request) => desktopBackend.setGitStage(request))
  ipcMain.handle('desktop:init-git-workspace', (_event, request) =>
    desktopBackend.initGitWorkspace(request),
  )
  ipcMain.handle('desktop:commit-git-changes', (_event, request) =>
    desktopBackend.commitGitChanges(request),
  )
  ipcMain.handle('desktop:pull-git-changes', (_event, request) =>
    desktopBackend.pullGitChanges(request),
  )
  ipcMain.handle('desktop:push-git-changes', (_event, request) =>
    desktopBackend.pushGitChanges(request),
  )
  ipcMain.handle('desktop:commit-all-git-changes', (_event, request) =>
    desktopBackend.commitAllGitChanges(request),
  )
  ipcMain.handle('desktop:fetch-git-log', (_event, request) =>
    desktopBackend.fetchGitLog(request),
  )
  ipcMain.handle('desktop:fetch-commit-diff', (_event, request) =>
    desktopBackend.fetchCommitDiff(request),
  )
  ipcMain.handle('desktop:fetch-slash-commands', (_event, request) =>
    desktopBackend.fetchSlashCommands(request),
  )
  ipcMain.handle('desktop:request-chat', (_event, request) => desktopBackend.requestChat(request))
  ipcMain.handle('desktop:upload-image-attachment', (_event, request) =>
    desktopBackend.uploadImageAttachment(request),
  )
  ipcMain.handle('desktop:stop-chat', (_event, streamId) => desktopBackend.stopChat(streamId))
  ipcMain.handle('desktop:list-external-history', (_event, request) =>
    desktopBackend.listExternalHistory(request),
  )
  ipcMain.handle('desktop:load-external-session', (_event, request) =>
    desktopBackend.loadExternalSession(request),
  )
  ipcMain.handle('desktop:subscribe-chat-stream', (event, streamId: string, subscriptionId: string) => {
    const unsubscribe = desktopBackend.subscribeChatStream(streamId, (payload) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('chat:stream-event', {
          subscriptionId,
          event: payload.event,
          data: payload.data,
        })
      }
    })

    if (!unsubscribe) {
      event.sender.send('chat:stream-event', {
        subscriptionId,
        event: 'error',
        data: { message: 'Stream not found.' },
      })
      return
    }

    streamSubscriptions.set(subscriptionId, {
      webContentsId: event.sender.id,
      unsubscribe,
    })
  })
  ipcMain.handle('desktop:unsubscribe-chat-stream', (_event, subscriptionId: string) => {
    streamSubscriptions.get(subscriptionId)?.unsubscribe()
    streamSubscriptions.delete(subscriptionId)
  })

  // ── Music IPC ──────────────────────────────────────────────────────────────
  ipcMain.handle('desktop:music-login-status', () => desktopBackend.fetchMusicLoginStatus())
  ipcMain.handle('desktop:music-qr-create', () => desktopBackend.createMusicQrLogin())
  ipcMain.handle('desktop:music-qr-check', (_event, key: string) =>
    desktopBackend.checkMusicQrLogin(key),
  )
  ipcMain.handle('desktop:music-logout', () => desktopBackend.musicLogout())
  ipcMain.handle('desktop:music-playlists', () => desktopBackend.fetchMusicPlaylists())
  ipcMain.handle('desktop:music-playlist-tracks', (_event, playlistId: number) =>
    desktopBackend.fetchMusicPlaylistTracks(playlistId),
  )
  ipcMain.handle('desktop:music-song-url', (_event, songId: number, quality?: string) =>
    desktopBackend.getMusicSongUrl(songId, quality),
  )
  ipcMain.handle('desktop:music-record-play', (_event, trackId: number) =>
    desktopBackend.recordMusicPlay(trackId),
  )
  ipcMain.handle('desktop:music-explore', (_event, query?: string) =>
    desktopBackend.fetchMusicExplorePlaylists(query),
  )

  // ── White Noise ───────────────────────────────────────────────────────
  ipcMain.handle('desktop:whitenoise-scenes', () =>
    desktopBackend.fetchWhiteNoiseScenes(),
  )
  ipcMain.handle('desktop:whitenoise-generate', (_event, prompt: string | null) =>
    desktopBackend.generateWhiteNoiseScene(prompt),
  )
  ipcMain.handle('desktop:whitenoise-delete', (_event, sceneId: string) =>
    desktopBackend.deleteWhiteNoiseScene(sceneId),
  )
  ipcMain.handle('desktop:whitenoise-ensure-audio', (_event, generator: string, url?: string) =>
    desktopBackend.ensureAmbientAudio(generator, url),
  )
  ipcMain.handle('desktop:whitenoise-read-audio', (_event, generator: string, url?: string) =>
    desktopBackend.readAmbientAudioBuffer(generator, url),
  )

  // ── File System ─────────────────────────────────────────────────────────
  ipcMain.handle('desktop:list-files', (_event, request) =>
    desktopBackend.listFiles(request),
  )
  ipcMain.handle('desktop:search-files', (_event, request) =>
    desktopBackend.searchFiles(request),
  )
  ipcMain.handle('desktop:create-file', (_event, request) =>
    desktopBackend.createFile(request),
  )
  ipcMain.handle('desktop:create-directory', (_event, request) =>
    desktopBackend.createDirectory(request),
  )
  ipcMain.handle('desktop:rename-entry', (_event, request) =>
    desktopBackend.renameEntry(request),
  )
  ipcMain.handle('desktop:move-entry', (_event, request) =>
    desktopBackend.moveEntry(request),
  )
  ipcMain.handle('desktop:delete-entry', (_event, request) =>
    desktopBackend.deleteEntry(request),
  )
  ipcMain.handle('desktop:read-file', (_event, request) =>
    desktopBackend.readFile(request),
  )
  ipcMain.handle('desktop:write-file', (_event, request) =>
    desktopBackend.writeFile(request),
  )
  ipcMain.handle(
    'desktop:open-message-local-link',
    async (_event, request: { href: string; workspacePath?: string }) => {
      const targetPath = resolveMessageLocalLinkTarget(request.href, request.workspacePath)

      if (!targetPath) {
        throw new Error('Only local file links can be opened in Explorer.')
      }

      const targetStats = await stat(targetPath).catch(() => null)

      if (!targetStats) {
        throw new Error(`Path not found: ${targetPath}`)
      }

      if (targetStats.isDirectory()) {
        const openError = await shell.openPath(targetPath)

        if (openError) {
          throw new Error(openError)
        }

        return
      }

      shell.showItemInFolder(targetPath)
    },
  )
  ipcMain.handle('desktop:open-external-link', async (_event, href: string) => {
    let target: URL

    try {
      target = new URL(href)
    } catch {
      throw new Error(`Invalid external URL: ${href}`)
    }

    if (!['http:', 'https:', 'mailto:'].includes(target.protocol)) {
      throw new Error(`Unsupported external link protocol: ${target.protocol}`)
    }

    await shell.openExternal(target.toString())
  })

  // ── Proxy Stats ──────────────────────────────────────────────────────────
  ipcMain.handle('desktop:fetch-proxy-stats', (_event, since?: number) =>
    desktopBackend.fetchProxyStats(since),
  )
  ipcMain.handle('desktop:reset-proxy-stats', () =>
    desktopBackend.resetProxyStats(),
  )

  // ── Weather ──────────────────────────────────────────────────────────────
  ipcMain.handle('desktop:fetch-weather', (_event, city?: string) =>
    desktopBackend.fetchWeather(city),
  )
  ipcMain.handle('desktop:search-cities', (_event, query: string) =>
    desktopBackend.searchCities(query),
  )

  // ── App Update ──────────────────────────────────────────────────────────
  ipcMain.handle('desktop:get-app-version', () => app.getVersion())
  ipcMain.handle('desktop:check-for-update', () => checkForUpdate())
  ipcMain.handle('desktop:download-update', async (event, assetUrl: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const installerPath = await downloadUpdate(assetUrl, (progress) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:download-progress', progress)
      }
    })
    return installerPath
  })
  ipcMain.handle('desktop:install-update', (_event, assetPath: string) => installUpdate(assetPath))
  ipcMain.handle('desktop:clear-user-data', async () => {
    relaunchToClearUserData()
  })
}

function createWindow() {
  const titleBarStyle = getTitleBarStyleForPlatform(process.platform)
  const useCustomWindowFrame = shouldUseCustomWindowFrameForPlatform(process.platform)
  const icon = getWindowIconPathForPlatform(process.platform, projectRoot, isDev)
  const shouldRemoveMenu = shouldRemoveMenuForPlatform(process.platform)
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    center: true,
    show: false,
    frame: !useCustomWindowFrame,
    ...(icon ? { icon } : {}),
    ...(titleBarStyle ? { titleBarStyle } : {}),
    webPreferences: {
      preload: path.join(moduleDir, 'preload.cjs'),
      backgroundThrottling: !shouldKeepValidationWindowHidden,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (shouldRemoveMenu) {
    win.removeMenu()
  }

  win.on('maximize', () => broadcastWindowState(win))
  win.on('unmaximize', () => broadcastWindowState(win))
  win.on('enter-full-screen', () => broadcastWindowState(win))
  win.on('leave-full-screen', () => broadcastWindowState(win))
  win.once('ready-to-show', () => {
    if (!shouldKeepValidationWindowHidden) {
      presentWindow(win)
    }
  })
  attachWindowDiagnostics(win)

  win.webContents.on('destroyed', () => {
    cleanupSubscriptionsForContents(win.webContents)
  })

  const target = getRendererLoadTarget({
    isDev,
    clientDistDir,
    devServerUrl: devClientUrl,
  })

  if (target.kind === 'url') {
    loadWindowUrl(win, target.value)
    return
  }

  void win.loadFile(target.value).then(() => {
    if (!shouldKeepValidationWindowHidden) {
      presentWindow(win)
    }
  })
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!focusPrimaryWindow(BrowserWindow.getAllWindows())) {
      createWindow()
    }
  })
}

ipcMain.handle('dialog:openFolder', async (event: IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(
    win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
    {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder',
    },
  )

  return result.canceled ? null : (result.filePaths[0] ?? null)
})

app.whenReady().then(async () => {
  configureDesktopEnvironment()
  await clearUserDataOnLaunchIfNeeded()
  initCrashLogger()
  app.on('child-process-gone', (_event, details) => {
    log.error('[main] Child process gone.', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName,
    })
  })
  registerDesktopHandlers()
  await registerAttachmentProtocol()
  registerAudioProtocol()
  createWindow()

  app.on('activate', () => {
    if (!focusPrimaryWindow(BrowserWindow.getAllWindows())) {
      createWindow()
    }
  })
})

app.on('before-quit', (event) => {
  log.warn('[main] before-quit.', {
    quitAfterFlushPending,
    windowCount: BrowserWindow.getAllWindows().length,
  })

  if (quitAfterFlushPending) {
    return
  }

  event.preventDefault()
  scheduleQuitAfterFlush()
})

app.on('will-quit', () => {
  log.warn('[main] will-quit.', {
    windowCount: BrowserWindow.getAllWindows().length,
  })

  if (quitTimer) {
    clearTimeout(quitTimer)
    quitTimer = null
  }

  for (const entry of streamSubscriptions.values()) {
    entry.unsubscribe()
  }
  streamSubscriptions.clear()
  void desktopBackend.dispose()
})

app.on('window-all-closed', () => {
  log.warn('[main] window-all-closed.', {
    platform: process.platform,
  })

  if (process.platform === 'darwin') return

  scheduleQuitAfterFlush()
})

app.on('quit', (_event, exitCode) => {
  log.warn('[main] quit.', {
    exitCode,
  })
})
