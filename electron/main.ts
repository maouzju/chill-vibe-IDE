import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { IpcMainInvokeEvent } from 'electron'

import { maxUiScale, minUiScale } from '../shared/default-state.js'
import { getAppDataDir } from '../server/app-paths.js'
import { initCrashLogger, log } from './crash-logger.js'
import { createDesktopBackend } from './backend.js'
import {
  resolveMessageLocalLinkTarget,
  revealMessageLocalLinkTarget,
} from './message-local-link.js'
import { localImageProtocolScheme } from '../shared/local-image-protocol.js'
import { resolveLocalImageRequestTarget } from './local-image-protocol.js'
import {
  resolveDesktopDataDir,
  resolveDesktopRuntimeProfilePaths,
  resolveDesktopRuntimeKind,
  resolveDesktopWorkingDirectory,
  resolveHardwareAccelerationEnabled,
} from './runtime-environment.js'
import { attachFrameStallWatchdog } from './frame-stall-watchdog.js'
import { summarizeUnresponsiveCallStack } from './unresponsive-forensics.js'
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

const shouldEnableHardwareAcceleration = resolveHardwareAccelerationEnabled({
  platform: process.platform,
  enableOverride: process.env.CHILL_VIBE_ENABLE_HARDWARE_ACCELERATION,
  disableOverride: process.env.CHILL_VIBE_DISABLE_HARDWARE_ACCELERATION,
})
if (!shouldEnableHardwareAcceleration) {
  app.disableHardwareAcceleration()
}
const devClientUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
const quitFlushDelayMs = 750
const quitFlushTimeoutMs = 5000
const devRendererBootstrapDelayMs = 750
const bypassSingleInstanceLock = process.env.CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK === '1'
const desktopWorkingDirectory = resolveDesktopWorkingDirectory({ isDev, moduleDir })
const desktopRuntimeProfilePaths = resolveDesktopRuntimeProfilePaths({
  isDev,
  projectRoot,
  configuredProfileRoot: process.env.CHILL_VIBE_RUNTIME_PROFILE_ROOT,
})
const desktopRuntimeKind = resolveDesktopRuntimeKind({ isDev })
const clearUserDataArg = '--clear-user-data'
const shouldClearUserDataOnLaunch = process.argv.includes(clearUserDataArg)
const allowSharedDataDirOverride =
  process.env.CHILL_VIBE_ALLOW_SHARED_DATA_DIR === '1' ||
  process.argv.includes('--allow-shared-data-dir')
const shouldKeepValidationWindowHidden = process.env.CHILL_VIBE_HEADLESS_RUNTIME_TESTS === '1'
const shouldUseOffscreenValidationRendering =
  process.env.CHILL_VIBE_OFFSCREEN_RUNTIME_TESTS === '1'

const audioProtocolScheme = 'chill-vibe-audio'

// Chromium 120+ can misjudge a fully visible window as natively occluded on
// Windows and stop producing frames entirely — JS/events/layout keep running
// against a dead picture (proven by forensics dump 2026-07-02T13-52-09: nine
// 1s heartbeat samples returned the same rAF timestamp until a foreground
// change revived rendering). Disable the miscalculating feature outright.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

protocol.registerSchemesAsPrivileged([
  { scheme: attachmentProtocolScheme, privileges: { supportFetchAPI: true, secure: true } },
  { scheme: audioProtocolScheme, privileges: { supportFetchAPI: true, secure: true, stream: true } },
  { scheme: localImageProtocolScheme, privileges: { supportFetchAPI: true, secure: true } },
])

if (desktopRuntimeProfilePaths) {
  app.setPath('userData', desktopRuntimeProfilePaths.userData)
  app.setPath('sessionData', desktopRuntimeProfilePaths.sessionData)
}

const desktopBackend = createDesktopBackend({
  onUnsolicitedStream: (notification) => {
    // A pooled Claude process woke itself (background task finished). Tell
    // every renderer so the owning card can subscribe to the new stream.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('chat:unsolicited-stream', notification)
      }
    }
  },
  dispatchRemoteCommand: (command) => {
    // 手机监工的写命令：广播给渲染窗口，由渲染进程复用电脑端 handler 执行。
    // 返回 false（无可用窗口）时 HTTP 层回 503。
    let delivered = false
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isCrashed()) {
        win.webContents.send('remote:command', command)
        delivered = true
      }
    }
    return delivered
  },
})
const streamSubscriptions = new Map<string, { webContentsId: number; unsubscribe: () => void }>()
const fileWatchSubscriptions = new Map<string, { webContentsId: number }>()
const hasSingleInstanceLock = bypassSingleInstanceLock ? true : app.requestSingleInstanceLock()

let quitTimer: NodeJS.Timeout | null = null
let quitAfterFlushPending = false

const sendChatStreamEventSafely = (
  sender: Electron.WebContents,
  payload: {
    subscriptionId: string
    event: string
    data: unknown
  },
) => {
  if (sender.isDestroyed() || sender.isCrashed()) {
    return false
  }

  try {
    sender.send('chat:stream-event', payload)
    return true
  } catch (error) {
    log.warn('[main] Failed to forward chat stream event to renderer.', error)
    return false
  }
}

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

function cleanupSubscriptionsForContentsId(webContentsId: number) {
  for (const [subscriptionId, entry] of streamSubscriptions.entries()) {
    if (entry.webContentsId !== webContentsId) {
      continue
    }

    entry.unsubscribe()
    streamSubscriptions.delete(subscriptionId)
  }

  for (const [subscriptionId, entry] of fileWatchSubscriptions.entries()) {
    if (entry.webContentsId !== webContentsId) {
      continue
    }

    desktopBackend.unwatchFile(subscriptionId)
    fileWatchSubscriptions.delete(subscriptionId)
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

  // The packaged app removes the menu, which silently removes every devtools
  // accelerator with it — leaving zero on-machine inspection paths when the
  // UI misbehaves. Restore F12 explicitly.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
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
    // The plain event never says WHAT is blocking the renderer's main thread.
    // collectJavaScriptCallStack() (Electron 34+) returns the blocked main
    // thread's JS stack without attaching a debugger — turning a dead-end
    // "unresponsive" into an actionable hot-path stack (dump 2026-07-07T14-50:
    // 5 panes × multiple streaming, page fully non-interactive, never recovered).
    const mainFrame = win.webContents.mainFrame
    const collect = mainFrame?.collectJavaScriptCallStack?.bind(mainFrame) as
      | (() => Promise<string>)
      | undefined
    if (collect) {
      collect()
        .then((rawCallStack: string) => {
          const summary = summarizeUnresponsiveCallStack({
            windowId: win.id,
            capturedAtIso: new Date().toISOString(),
            rawCallStack,
          })
          log.warn('[main] unresponsive renderer JS call stack captured.', summary)
        })
        .catch((error: unknown) => {
          log.warn('[main] failed to capture unresponsive renderer call stack.', {
            windowId: win.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
  })

  win.on('responsive', () => {
    // Previously there was no 'responsive' listener at all, so a recovery was
    // invisible in the logs — every unresponsive read as permanent. Record it so
    // triage can tell a transient hitch from a terminal freeze.
    log.warn('[main] BrowserWindow became responsive again.', { windowId: win.id })
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

function registerLocalImageProtocol() {
  protocol.handle(localImageProtocolScheme, async (request) => {
    const filePath = resolveLocalImageRequestTarget(request.url)

    if (!filePath) {
      return new Response('Image not found.', { status: 404 })
    }

    try {
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Image not found.', { status: 404 })
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

  // Stuck-pane forensics dumps land next to main.log so a single logs/ folder
  // carries everything needed to attribute a misroute recurrence in the wild.
  ipcMain.handle('diagnostics:write-forensics', async (_event, json: string) => {
    if (typeof json !== 'string' || json.length > 4 * 1024 * 1024) {
      return null
    }
    const dataDir = process.env.CHILL_VIBE_DATA_DIR ?? path.join(process.cwd(), '.chill-vibe')
    const logsDir = path.join(dataDir, 'logs')
    await mkdir(logsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(logsDir, `stuck-pane-forensics-${stamp}.json`)
    await writeFile(filePath, json, 'utf8')
    log.warn('[main] stuck-pane forensics dump written.', { filePath })
    return filePath
  })

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
  ipcMain.handle('desktop:run-environment-setup', (_event, request: unknown) =>
    desktopBackend.runEnvironmentSetup(request),
  )
  ipcMain.handle('desktop:fetch-ollama-status', () => desktopBackend.fetchOllamaStatus())
  ipcMain.handle('desktop:run-ollama-install', () => desktopBackend.runOllamaInstall())
  ipcMain.handle('desktop:run-ollama-pull', (_event, request: unknown) =>
    desktopBackend.runOllamaPull(request),
  )
  ipcMain.handle('desktop:judge-urge-with-ollama', (_event, request: unknown) =>
    desktopBackend.judgeUrgeWithOllama(request),
  )
  ipcMain.handle('desktop:fetch-onboarding-status', () => desktopBackend.fetchOnboardingStatus())
  ipcMain.handle('desktop:fetch-git-status', (_event, workspacePath) =>
    desktopBackend.fetchGitStatus(workspacePath),
  )
  ipcMain.handle('desktop:fetch-git-status-preview', (_event, workspacePath) =>
    desktopBackend.fetchGitStatusPreview(workspacePath),
  )
  ipcMain.handle('desktop:set-git-stage', (_event, request) => desktopBackend.setGitStage(request))
  ipcMain.handle('desktop:discard-git-changes', (_event, request) =>
    desktopBackend.discardGitChanges(request),
  )
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
  ipcMain.handle('desktop:fork-provider-session', (_event, request) =>
    desktopBackend.forkProviderSession(request),
  )
  ipcMain.handle('desktop:get-native-turn-completion', (_event, request) =>
    desktopBackend.getNativeTurnCompletion(request),
  )
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
    const sender = event.sender
    const unsubscribe = desktopBackend.subscribeChatStream(streamId, (payload) => {
      sendChatStreamEventSafely(sender, {
        subscriptionId,
        event: payload.event,
        data: payload.data,
      })
    })

    if (!unsubscribe) {
      sendChatStreamEventSafely(sender, {
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
  ipcMain.handle('desktop:read-nearest-tsconfig', (_event, request) =>
    desktopBackend.readNearestTsconfig(request),
  )
  ipcMain.handle('desktop:read-git-head-file', (_event, request) =>
    desktopBackend.readGitHeadFile(request),
  )
  ipcMain.handle('desktop:read-git-file-line-diff', (_event, request) =>
    desktopBackend.readGitFileLineDiff(request),
  )
  ipcMain.handle(
    'desktop:watch-file',
    (event, request: { workspacePath: string; relativePath: string; subscriptionId: string }) => {
      const sender = event.sender
      const { workspacePath, relativePath, subscriptionId } = request

      const subscribed = desktopBackend.watchFile(workspacePath, relativePath, subscriptionId, () => {
        if (sender.isDestroyed() || sender.isCrashed()) {
          return
        }

        try {
          sender.send('file:changed', { subscriptionId })
        } catch (error) {
          log.warn('[main] Failed to forward file change event to renderer.', error)
        }
      })

      if (subscribed) {
        fileWatchSubscriptions.set(subscriptionId, { webContentsId: sender.id })
      }

      return subscribed
    },
  )
  ipcMain.handle('desktop:unwatch-file', (_event, subscriptionId: string) => {
    desktopBackend.unwatchFile(subscriptionId)
    fileWatchSubscriptions.delete(subscriptionId)
  })

  // ── Remote Monitor IPC（手机远程监工）──────────────────────────────────────
  ipcMain.handle('desktop:remote-monitor-start', () => desktopBackend.startRemoteMonitor())
  ipcMain.handle('desktop:remote-monitor-stop', () => desktopBackend.stopRemoteMonitor())
  ipcMain.handle('desktop:remote-monitor-status', () => desktopBackend.fetchRemoteMonitorStatus())

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
  ipcMain.handle('desktop:copy-file-to-clipboard', (_event, request) =>
    desktopBackend.copyFileToClipboard(request),
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

      await revealMessageLocalLinkTarget(targetPath, {
        shellAdapter: shell,
        statPath: stat,
      })
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
  ipcMain.handle('desktop:record-proxy-stats-event', (_event, request: unknown) =>
    desktopBackend.recordProxyStatsEvent(request),
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
      offscreen: shouldUseOffscreenValidationRendering,
      // Throttling turns every occlusion misjudgment into a full rAF/timer
      // stall (investigation §2.2; forensics 2026-07-02T13-52-09). An IDE
      // with live streams must keep rendering like one.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (shouldUseOffscreenValidationRendering) {
    win.webContents.setFrameRate(15)
    // Offscreen rendering only models a visible compositor when paint frames
    // are consumed. Without a listener Chromium can backpressure the surface
    // for seconds, creating a test-only rAF stall unrelated to production.
    win.webContents.on('paint', () => {})
  }

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
  attachFrameStallWatchdog(win, (message, meta) => log.warn(message, meta))

  win.on('close', (event) => {
    if (process.platform === 'darwin' || quitAfterFlushPending) {
      return
    }

    event.preventDefault()
    scheduleQuitAfterFlush()
  })

  const webContentsId = win.webContents.id
  let didCleanupSubscriptionsForWindow = false
  const cleanupSubscriptionsForWindow = (event?: Electron.Event) => {
    if (event?.defaultPrevented) {
      return
    }

    if (didCleanupSubscriptionsForWindow) {
      return
    }

    didCleanupSubscriptionsForWindow = true
    cleanupSubscriptionsForContentsId(webContentsId)
  }

  win.on('close', cleanupSubscriptionsForWindow)
  win.on('closed', cleanupSubscriptionsForWindow)
  win.webContents.once('destroyed', cleanupSubscriptionsForWindow)
  win.webContents.once('render-process-gone', cleanupSubscriptionsForWindow)

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
  registerLocalImageProtocol()
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
