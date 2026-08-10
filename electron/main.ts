import { app, BrowserWindow, crashReporter, dialog, ipcMain, net, protocol, shell } from 'electron'
import { readdir } from 'node:fs/promises'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { IpcMainInvokeEvent } from 'electron'

import { maxUiScale, minUiScale } from '../shared/default-state.js'
import { appSettingsSchema, automationBoardMirrorSchema } from '../shared/schema.js'
import {
  forgetAutomationBoardMirror,
  publishAutomationBoardMirror,
} from '../server/automation-board-session.js'
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
import {
  readAccessibilitySupportFlag,
  resolveAccessibilitySupportEnabled,
  writeAccessibilitySupportFlag,
} from './accessibility-support.js'
import { attachFrameStallWatchdog } from './frame-stall-watchdog.js'
import { createChatStreamBatcher } from './chat-stream-batcher.js'
import { summarizeUnresponsiveCallStack } from './unresponsive-forensics.js'
import {
  classifyUnresponsiveBlocking,
  resolveCrashDumpDirectory,
  selectNewCrashDumps,
  summarizeChildProcessMetrics,
} from './native-hang-forensics.js'
import {
  createUnresponsiveRecoveryController,
  resolveUnresponsiveRecoveryDelayMs,
} from './unresponsive-recovery.js'
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
import {
  flashWindowOnce,
  focusPrimaryWindow,
  presentWindow,
  resolveWindowCloseAction,
} from './window-lifecycle.js'

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

// Assistive input tools (WeChat voice-to-text, screen readers, dictation) can
// only reach the composer when Chromium exposes its renderer content to UI
// Automation. Measured on 2026-07-26: UiaProvider alone surfaces only the
// browser chrome (15 nodes, no Edit control) and force-renderer-accessibility
// alone surfaces nothing — both switches together are what produce a
// ControlType.Edit with ValuePattern. Repeated UIA queries never activated the
// tree lazily, so this has to be decided before the app is ready, which is why
// the state lives in a tiny sidecar instead of state.json (pitfalls #45/#55).
const accessibilitySupportDataDir = resolveDesktopDataDir({
  isDev,
  projectRoot,
  userDataPath: app.getPath('userData'),
  configuredDataDir: process.env.CHILL_VIBE_DATA_DIR,
  allowConfiguredOverride: allowSharedDataDirOverride,
})
const accessibilitySupportEnabled = resolveAccessibilitySupportEnabled({
  enableOverride: process.env.CHILL_VIBE_ENABLE_ACCESSIBILITY_SUPPORT,
  disableOverride: process.env.CHILL_VIBE_DISABLE_ACCESSIBILITY_SUPPORT,
  persistedFlag: readAccessibilitySupportFlag(accessibilitySupportDataDir),
})
if (accessibilitySupportEnabled) {
  app.commandLine.appendSwitch('enable-features', 'UiaProvider')
  app.commandLine.appendSwitch('force-renderer-accessibility')
}

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
  dispatchAutomationBoardCommand: (command) => {
    // 与手机监工同一条规矩：桥接服务自己绝不改 state，写命令广播给渲染进程
    // 复用电脑端 handler。返回 false（无可用窗口）时 HTTP 层回 503。
    let delivered = false
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isCrashed()) {
        win.webContents.send('automation-board:command', command)
        delivered = true
      }
    }
    return delivered
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
let minimizeToTaskbarOnCloseEnabled = false

// 16ms 对齐一帧：渲染进程本来就画不出比这更密的更新，所以合并窗口取到帧率上限，
// 既把跨进程往返压到最少，又不产生用户可感知的延迟。
const chatStreamFlushWindowMs = 16
const chatStreamSenders = new Map<number, Electron.WebContents>()

// 症状：并发多路流式输出时整窗口卡死 1~19 秒，主进程 CPU 为 0 却挂在 IPC 上。
// 根因：2026-08-10 实测，卡顿的 890ms 内主进程做了 426 次 IPC / 6MB，平均每次仅 14KB ——
//       瓶颈是每个 delta 各走一次跨进程往返（≈480 次/秒，随并发路数线性叠加）。
// 被否决：截断大输出 —— 平均 14KB 证明没有「巨型单条」，截断伤可读性且治不了频率。
const chatStreamBatcher = createChatStreamBatcher({
  schedule: (callback) => {
    setTimeout(callback, chatStreamFlushWindowMs)
  },
  deliver: (senderKey, items) => {
    const sender = chatStreamSenders.get(senderKey)
    if (!sender || sender.isDestroyed() || sender.isCrashed()) {
      chatStreamSenders.delete(senderKey)
      return
    }

    try {
      sender.send('chat:stream-event', items)
    } catch (error) {
      log.warn('[main] Failed to forward chat stream events to renderer.', error)
    }
  },
})

const sendChatStreamEventSafely = (
  sender: Electron.WebContents,
  payload: {
    subscriptionId: string
    event: string
    data: unknown
  },
) => {
  if (sender.isDestroyed() || sender.isCrashed()) {
    chatStreamSenders.delete(sender.id)
    chatStreamBatcher.dropSender(sender.id)
    return false
  }

  chatStreamSenders.set(sender.id, sender)
  chatStreamBatcher.enqueue(sender.id, payload)
  return true
}

async function openExternalUrl(href: string) {
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

let crashDumpDirectory: string | null = null

// Every long-freeze investigation so far has ended at "the JS call stack was
// empty" — the renderer main thread is blocked outside app JS, and nothing on
// disk records what it was blocked in. A Crashpad minidump is the only artifact
// that carries that native stack, and the recovery path already terminates the
// stuck renderer, which produces one — but only while the crash reporter is
// running. Without this, every recovery destroyed the sole piece of evidence.
function configureCrashDumpCollection() {
  const dataDir = process.env.CHILL_VIBE_DATA_DIR ?? path.join(process.cwd(), '.chill-vibe')
  const directory = resolveCrashDumpDirectory(dataDir)
  // setPath must precede start(); afterwards Crashpad owns the location.
  app.setPath('crashDumps', directory)
  crashReporter.start({
    // Dumps stay on this machine. Nothing is sent anywhere.
    uploadToServer: false,
    compress: false,
    ignoreSystemCrashHandler: true,
  })
  crashDumpDirectory = directory
  log.info('[main] Crash dump collection enabled.', { crashDumpDirectory: directory })
}

// Crashpad finalises a minidump asynchronously after the process dies, so the
// directory is polled briefly rather than read once and declared empty.
async function reportFreshCrashDump(before: readonly string[]) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const fresh = selectNewCrashDumps(before, await listCrashDumpFiles())
    if (fresh.length > 0) {
      log.error('[main] Native hang minidump captured for the stuck renderer.', {
        crashDumpDirectory,
        dumps: fresh.map((entry) => path.join(crashDumpDirectory ?? '', 'reports', entry)),
      })
      return
    }
  }
  log.warn('[main] Forced renderer crash produced no minidump.', { crashDumpDirectory })
}

async function listCrashDumpFiles(): Promise<string[]> {
  if (!crashDumpDirectory) {
    return []
  }
  try {
    // Crashpad nests the finished minidumps under `reports`.
    const entries = await readdir(path.join(crashDumpDirectory, 'reports'))
    return entries.filter((entry) => entry.endsWith('.dmp')).sort()
  } catch {
    return []
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

async function flushStateBeforeUpdate() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app:flush-state-before-quit')
    }
  }

  await new Promise((resolve) => setTimeout(resolve, quitFlushDelayMs))

  let timeout: NodeJS.Timeout | null = null
  try {
    await Promise.race([
      desktopBackend.flushStateWrites(),
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Pending state flush timed out before update install.')),
          quitFlushTimeoutMs,
        )
      }),
    ])
  } catch (error) {
    log.warn('[main] Failed to flush pending state before update install.', error)
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
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

type WindowInputSnapshot = {
  atIso: string
  inputType: string
  inputKey: string
  code: string
  modifiers: string[]
}

let lastWindowInputSnapshot: WindowInputSnapshot | null = null
let pendingWindowCloseSource: 'renderer-ipc' | 'native-window' = 'native-window'

function attachWindowDiagnostics(win: BrowserWindow) {
  let forcedRendererRestartPending: {
    rendererProcessId: number
    requestedAtIso: string
  } | null = null
  let crashDumpsBeforeForcedCrash: string[] = []
  const unresponsiveRecovery = createUnresponsiveRecoveryController({
    delayMs: resolveUnresponsiveRecoveryDelayMs(
      process.env.CHILL_VIBE_UNRESPONSIVE_RECOVERY_MS,
    ),
    onRecover: ({ startedAtMs, recoveredAtMs, durationMs }) => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        return
      }

      if (forcedRendererRestartPending) {
        return
      }

      const rendererProcessId = win.webContents.getOSProcessId()
      forcedRendererRestartPending = {
        rendererProcessId,
        requestedAtIso: new Date().toISOString(),
      }
      log.error('[main] BrowserWindow stayed unresponsive; terminating stuck renderer.', {
        windowId: win.id,
        rendererProcessId,
        startedAtIso: new Date(startedAtMs).toISOString(),
        recoveredAtIso: new Date(recoveredAtMs).toISOString(),
        durationMs,
        lastInput: lastWindowInputSnapshot,
      })
      try {
        // A normal reload is delivered through the already-stuck renderer and
        // can queue forever (2026-07-26: four reload attempts retained the same
        // PID 45156). Kill only the renderer process; the Electron main process,
        // local backend, ChatManager backlog and provider CLIs remain alive.
        win.webContents.forcefullyCrashRenderer()
      } catch (error) {
        forcedRendererRestartPending = null
        log.error('[main] Failed to terminate stuck renderer.', {
          windowId: win.id,
          rendererProcessId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })

  log.info('[main] BrowserWindow created.', {
    windowId: win.id,
  })

  // The packaged app removes the menu, which silently removes every devtools
  // accelerator with it — leaving zero on-machine inspection paths when the
  // UI misbehaves. Restore F12 explicitly.
  win.webContents.on('before-input-event', (_event, input) => {
    lastWindowInputSnapshot = {
      atIso: new Date().toISOString(),
      inputType: input.type,
      inputKey: input.key,
      code: input.code,
      modifiers: input.modifiers,
    }
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
    }
  })

  win.on('close', () => {
    log.warn('[main] BrowserWindow close requested.', {
      windowId: win.id,
      visible: win.isVisible(),
      focused: win.isFocused(),
      closeSource: pendingWindowCloseSource,
      lastInput: lastWindowInputSnapshot,
    })
    pendingWindowCloseSource = 'native-window'
  })

  win.on('closed', () => {
    forcedRendererRestartPending = null
    unresponsiveRecovery.dispose()
    log.warn('[main] BrowserWindow closed.', {
      windowId: win.id,
    })
  })

  win.on('unresponsive', () => {
    // Across 22 recorded freezes the 5 minutes before each one contain nothing
    // but resource heartbeats, so there is no record of what the app was doing.
    // lastInput used to appear only on the later reload line; carrying it here
    // makes the freeze event itself self-contained.
    log.warn('[main] BrowserWindow became unresponsive.', {
      windowId: win.id,
      lastInput: lastWindowInputSnapshot,
    })
    unresponsiveRecovery.markUnresponsive()
    // The plain event never says WHAT is blocking the renderer's main thread.
    // collectJavaScriptCallStack() (Electron 34+) returns the blocked main
    // thread's JS stack without attaching a debugger — turning a dead-end
    // "unresponsive" into an actionable hot-path stack (dump 2026-07-07T14-50:
    // 5 panes × multiple streaming, page fully non-interactive, never recovered).
    const mainFrame = win.webContents.mainFrame
    const collect = mainFrame?.collectJavaScriptCallStack?.bind(mainFrame) as
      | (() => Promise<string>)
      | undefined
    // Snapshot the existing dumps now, so the minidump produced by the upcoming
    // forced crash can be told apart from stale ones left by earlier freezes.
    void listCrashDumpFiles().then((entries) => {
      crashDumpsBeforeForcedCrash = entries
    })

    // A saturated GPU process means the block sits below the renderer, where no
    // renderer-side JS explanation could ever account for it. That distinction
    // was never recorded, so every freeze read identically in the logs.
    const processMetrics = summarizeChildProcessMetrics({
      rendererProcessId: win.webContents.getOSProcessId(),
      metrics: app.getAppMetrics(),
    })

    if (collect) {
      collect()
        .then((rawCallStack: string) => {
          const summary = summarizeUnresponsiveCallStack({
            windowId: win.id,
            capturedAtIso: new Date().toISOString(),
            rawCallStack,
          })
          const verdict = classifyUnresponsiveBlocking({
            jsStackAvailable: summary.available,
            crashDumpDirectory: crashDumpDirectory ?? '',
          })
          log.warn('[main] unresponsive renderer JS call stack captured.', {
            ...summary,
            ...verdict,
            ...processMetrics,
          })
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
    unresponsiveRecovery.markResponsive()
    // Previously there was no 'responsive' listener at all, so a recovery was
    // invisible in the logs — every unresponsive read as permanent. Record it so
    // triage can tell a transient hitch from a terminal freeze.
    log.warn('[main] BrowserWindow became responsive again.', { windowId: win.id })
  })

  win.webContents.on('did-finish-load', () => {
    log.info('[main] Renderer finished load.', {
      windowId: win.id,
      rendererProcessId: win.webContents.getOSProcessId(),
      url: win.webContents.getURL(),
    })
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    const forcedRestart = forcedRendererRestartPending
    log.error('[main] Renderer process gone.', {
      windowId: win.id,
      reason: details.reason,
      exitCode: details.exitCode,
      forcedRecovery: Boolean(forcedRestart),
      rendererProcessId: forcedRestart?.rendererProcessId,
    })

    if (forcedRestart && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      forcedRendererRestartPending = null
      log.warn('[main] Restarting renderer after forced unresponsive recovery.', {
        windowId: win.id,
        previousRendererProcessId: forcedRestart.rendererProcessId,
        requestedAtIso: forcedRestart.requestedAtIso,
      })
      // Name the exact minidump this freeze produced. It carries the native
      // stack the empty JS call stack could never provide, and a bug report can
      // now point at one file instead of "it froze again".
      void reportFreshCrashDump(crashDumpsBeforeForcedCrash)
      win.webContents.reloadIgnoringCache()
    }
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
  // 自动化看板的实时镜像：渲染进程是 board state 的唯一主人，所以镜像只能由它
  // 推上来（读盘快照在流式期间被刻意节流，对监工太旧）。截断在 session 模块里
  // 统一执行，这里只做 schema 校验。
  ipcMain.handle('automation-board:publish-mirror', (_event, payload: unknown) => {
    const parsed = automationBoardMirrorSchema.safeParse(payload)
    if (parsed.success) {
      publishAutomationBoardMirror(parsed.data)
    }
    return parsed.success
  })
  ipcMain.handle('automation-board:forget-mirror', (_event, boardCardId: unknown) => {
    if (typeof boardCardId === 'string' && boardCardId.trim()) {
      forgetAutomationBoardMirror(boardCardId)
    }
  })
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
    const win = getEventWindow(event)
    pendingWindowCloseSource = 'renderer-ipc'
    win?.close()
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
  ipcMain.handle('desktop:load-compacted-card-history', (_event, request) =>
    desktopBackend.loadCompactedCardHistory(request),
  )
  ipcMain.handle('desktop:save-closed-workspace-snapshot', (_event, snapshot) =>
    desktopBackend.saveClosedWorkspaceSnapshot(snapshot),
  )
  ipcMain.handle('desktop:load-closed-workspace-snapshot', (_event, request) =>
    desktopBackend.loadClosedWorkspaceSnapshot(request),
  )
  ipcMain.handle('desktop:list-internal-session-history', (_event, request) =>
    desktopBackend.listInternalSessionHistory(request),
  )
  ipcMain.handle('desktop:hide-internal-session-history', (_event, request) =>
    desktopBackend.hideInternalSessionHistory(request),
  )
  ipcMain.handle('desktop:save-state', (_event, state) => desktopBackend.saveState(state))
  ipcMain.on('desktop:queue-state-save', (_event, state) => {
    // `ipcMain.on` has no reply channel, so anything thrown here escapes as an
    // uncaughtException and terminates the app with no shutdown log — exactly
    // how a single malformed wake-timer queue entry made the window vanish
    // every ~20 seconds on 2026-07-26. A rejected save must never be fatal.
    try {
      desktopBackend.queueStateSave(state)
    } catch (error) {
      log.error('[main] Queued state save failed; keeping the app alive.', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
  // Chromium switches cannot change at runtime, so this only records the choice
  // for the next launch. The renderer surfaces the restart requirement.
  ipcMain.handle('desktop:set-accessibility-support', (_event, enabled: unknown) => {
    const nextEnabled = enabled === true
    try {
      writeAccessibilitySupportFlag(accessibilitySupportDataDir, nextEnabled)
    } catch (error) {
      log.warn('[main] Failed to persist accessibility support flag.', error)
      return { enabled: accessibilitySupportEnabled, restartRequired: false }
    }
    return { enabled: nextEnabled, restartRequired: nextEnabled !== accessibilitySupportEnabled }
  })
  ipcMain.handle('desktop:sync-runtime-settings', (_event, settings) => {
    const parsed = appSettingsSchema.parse(settings)
    minimizeToTaskbarOnCloseEnabled = parsed.minimizeToTaskbarOnCloseEnabled
    desktopBackend.syncRuntimeSettings(parsed)
  })
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
  ipcMain.handle('desktop:fetch-codex-management-policy', () =>
    desktopBackend.fetchCodexManagementPolicy(),
  )
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
  ipcMain.handle('desktop:list-sticky-notes', (_event, request) =>
    desktopBackend.listStickyNotes(request),
  )
  ipcMain.handle('desktop:load-sticky-note', (_event, request) =>
    desktopBackend.loadStickyNote(request),
  )
  ipcMain.handle('desktop:save-sticky-note', (_event, request) =>
    desktopBackend.saveStickyNote(request),
  )
  ipcMain.handle('desktop:search-sticky-notes', (_event, request) =>
    desktopBackend.searchStickyNotes(request),
  )
  ipcMain.handle('desktop:load-sticky-note-version', (_event, request) =>
    desktopBackend.loadStickyNoteVersion(request),
  )
  ipcMain.handle('desktop:restore-sticky-note-version', (_event, request) =>
    desktopBackend.restoreStickyNoteVersion(request),
  )
  ipcMain.handle('desktop:reveal-sticky-note-location', async (_event, workspacePath: string) => {
    const { ensureStickyNoteWorkspaceDirectory } = await import('../server/sticky-note-store.js')
    const targetPath = await ensureStickyNoteWorkspaceDirectory(workspacePath)
    const openError = await shell.openPath(targetPath)
    if (openError) throw new Error(openError)
  })

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
    await openExternalUrl(href)
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
  ipcMain.handle('desktop:install-update', async (_event, assetPath: string) => {
    await flushStateBeforeUpdate()
    await installUpdate(assetPath)
  })
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

  // 症状：2026-08-04 实测微信文章的 target=_blank 会创建一个只有菜单栏的白色应用窗口。
  // 根因：Electron 默认把 renderer 的 window.open 当成新的 BrowserWindow；外链本应交给系统浏览器。
  // 不允许应用内子窗口，避免再次引入空窗口和继承主窗口权限的安全风险。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url).catch((error) => {
      log.warn('[main] Blocked renderer-created window.', { url, error })
    })
    return { action: 'deny' }
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
    const closeAction = resolveWindowCloseAction({
      platform: process.platform,
      minimizeToTaskbarOnCloseEnabled,
      quitAfterFlushPending,
    })

    if (closeAction === 'allow-close') {
      return
    }

    event.preventDefault()

    // 症状：开启“关闭后最小化”后，关闭窗口仍会杀掉正在运行的 Agent。
    // 根因：旧关闭监听无条件进入刷盘退出；2026-08-09 新设置改为主进程即时决策。
    // 不用 hide/托盘，用户明确要求保留任务栏入口，且正式退出流程必须继续放行。
    if (closeAction === 'minimize') {
      win.minimize()
      return
    }

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
  if (accessibilitySupportEnabled) {
    // Keeps app.isAccessibilitySupportEnabled() truthful and opts macOS in too;
    // on Windows the command-line switches above are what actually expose the
    // renderer tree.
    app.setAccessibilitySupportEnabled(true)
  }
  await clearUserDataOnLaunchIfNeeded()
  initCrashLogger()
  configureCrashDumpCollection()
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
