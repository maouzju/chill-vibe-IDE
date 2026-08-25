import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
  utilityProcess,
} from 'electron'
import { spawn } from 'node:child_process'
import { createServer as createPipeServer } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { IpcMainInvokeEvent } from 'electron'

import { maxUiScale, minUiScale } from '../shared/default-state.js'
import { appSettingsSchema } from '../shared/schema.js'
import { getAppDataDir } from '../server/app-paths.js'
import { isFileWatchArmed } from '../server/file-watcher.js'
import { initCrashLogger, log } from './crash-logger.js'
// 类型-only：`backend.js` 一旦被真的 import，整棵 server/ 树（60 文件 / 28385 行）
// 又会回到主进程，这次改造就白做了。verbatimModuleSyntax 保证它不产生任何 require。
import type { DesktopBackend } from './backend.js'
import {
  createBackendHost,
  type AsyncifiedBackend,
  type BackendHostChild,
} from './backend-host.js'
import { backendRpcChannels } from './backend-rpc-protocol.js'
import { runBackendSideEffect, toAmbientAudioBuffer } from './backend-call-guards.js'
import { routeFileWatchEvent } from './file-watch-routing.js'
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
import { loadRendererWithRetry } from './renderer-load-retry.js'
import {
  classifyPreviousRun,
  parseRunSentinel,
  serializeRunSentinel,
} from './crash-relaunch-policy.js'
import {
  guardHistoryPath,
  guardPipePath,
  guardSentinelPath,
} from './crash-relaunch-guard.js'
import { createChatStreamBatcher } from './chat-stream-batcher.js'
import { createChatStreamSubscriptionRegistry } from './chat-stream-subscriptions.js'
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
  type WindowCloseBehavior,
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

// Declared before the backend because the file-watch event channel below is the
// only consumer that resolves a subscriptionId back to its renderer.
const fileWatchSubscriptions = new Map<
  string,
  { webContentsId: number; sender: Electron.WebContents }
>()

// 同理：聊天流的路由表（subscriptionId -> 渲染进程）留在主进程，后端那边只认
// subscriptionId。deps 里的 desktopBackend / sendChatStreamEventSafely 都只在
// 订阅真正发生时才被读取，所以声明顺序不构成 TDZ 问题。
const chatStreamSubscriptions = createChatStreamSubscriptionRegistry<Electron.WebContents>({
  subscribe: (streamId, subscriptionId) =>
    desktopBackend.subscribeChatStream(streamId, subscriptionId),
  unsubscribe: (subscriptionId) => {
    runBackendSideEffect(
      () => desktopBackend.unsubscribeChatStream(subscriptionId),
      (error) => log.warn('[main] Failed to unsubscribe a chat stream.', error),
    )
  },
  deliver: (sender, payload) => {
    sendChatStreamEventSafely(sender, payload)
  },
})

// 广播给每个还活着的渲染窗口，返回是否至少送到一个。返回值直接决定 HTTP 503/202，
// 所以这两条通道是**请求**（要回复），不是事件。
function broadcastToLiveRenderers(channel: string, payload: unknown) {
  let delivered = false
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isCrashed()) {
      win.webContents.send(channel, payload)
      delivered = true
    }
  }
  return delivered
}

const backendEntryPath = path.join(moduleDir, 'utility-host.js')

const backendHost = createBackendHost<AsyncifiedBackend<DesktopBackend>>({
  fork: (): BackendHostChild => {
    // env 不显式传：默认继承主进程当前的 env 快照，而 fork 被排在
    // configureDesktopEnvironment() 之后，CHILL_VIBE_DATA_DIR 等正好都已就位。
    const child = utilityProcess.fork(backendEntryPath, [], {
      serviceName: 'chill-vibe-backend',
      stdio: 'inherit',
    })

    return {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => {
        child.on('message', (message) => listener(message))
      },
      onExit: (listener) => {
        child.on('exit', (code) => listener(code))
      },
      kill: () => {
        child.kill()
      },
    }
  },
  // 打包版这里是 null —— host 会跳过 chdir 并继承 fork 时的 cwd。绝不能退化成
  // 空字符串（那是把"不要 chdir"表达成了一个路径）。
  resolveInit: () => ({ workingDirectory: desktopWorkingDirectory }),
  onLog: (level, message, meta) => {
    log[level](message, meta)
  },
  onBackendLost: ({ exitCode, attempt, willRestart }) => {
    // 症状 — 后端独立退出而窗口还活着：每张卡永久停在 streaming、composer 锁死，
    //   而且没有任何报错，比今天的闪退更难查。
    // 根因 — 2026-08-12：ChatManager 的 backlog、全部 streamId、Claude 进程池都住
    //   在后端进程里，随它一起消失；重启后的新进程对这些 id 一无所知。
    // 为什么不新开一条渲染端通道 — "Stream not found." 是渲染进程已经会处理的信号
    //   （收到后把卡落回 idle），复用它零改动且与真实失效流走同一条路径。
    chatStreamSubscriptions.invalidateAll()

    // 文件监听同理：新进程没有这些 watcher，留着只会让退订打到不存在的 id 上。
    // 代价是重启后已打开的文件窗口不再收到外部改动通知，直到它重新挂载。
    fileWatchSubscriptions.clear()

    log.error('[main] Backend process lost; every stream id is now invalid.', {
      exitCode,
      attempt,
      willRestart,
    })
  },
})

// 同形状代理：108 个 handler 一行不用改。方法身份跨重启保持稳定，所以启动时闭包
// 捕获过它的地方在重启之后仍然指向活着的后端。
const desktopBackend = backendHost.proxy

// 后端只知道 subscriptionId，"哪个 webContents 收"这张路由表留在主进程（只有它
// 认识 WebContents）。registry 与三处清理逻辑跨进程后一行不用改。
backendHost.onEvent(backendRpcChannels.chatStreamEvent, (event) => {
  chatStreamSubscriptions.handleEvent(event)
})

// One process-level channel instead of a callback per subscription: the watcher
// only reports which subscription changed, and the renderer routing stays here
// in main. 决策本身收在 routeFileWatchEvent（含"退订必须早于删条目"这条约束）。
backendHost.onEvent(backendRpcChannels.fileWatchEvent, ({ subscriptionId }) => {
  routeFileWatchEvent(
    {
      lookup: (id) => fileWatchSubscriptions.get(id),
      isSenderDead: ({ sender }) => sender.isDestroyed() || sender.isCrashed(),
      unwatch: (id) => {
        runBackendSideEffect(
          () => desktopBackend.unwatchFile(id),
          (error) => log.warn('[main] Failed to unwatch a dead renderer file watch.', error),
        )
      },
      forget: (id) => {
        fileWatchSubscriptions.delete(id)
      },
      deliver: ({ sender }, id) => {
        sender.send('file:changed', { subscriptionId: id })
      },
      onDeliveryFailed: (_id, error) => {
        log.warn('[main] Failed to forward file change event to renderer.', error)
      },
    },
    subscriptionId,
  )
})

backendHost.onEvent(backendRpcChannels.unsolicitedStream, (notification) => {
  // A pooled Claude process woke itself (background task finished). Tell
  // every renderer so the owning card can subscribe to the new stream.
  broadcastToLiveRenderers('chat:unsolicited-stream', notification)
})

// 这两条是 host→main 的**请求**：布尔返回值直接决定 HTTP 503/202。忘了注册的话
// 手机远程监工与超管看板会静默全部报"无窗口"，而日志里一个字都没有。
backendHost.onRequest(backendRpcChannels.remoteCommand, (command) =>
  // 手机监工的写命令：广播给渲染窗口，由渲染进程复用电脑端 handler 执行。
  broadcastToLiveRenderers('remote:command', command),
)
backendHost.onRequest(backendRpcChannels.workspaceAdminCommand, (command) =>
  // 与手机监工同一条规矩：桥接服务自己绝不改 state，写命令广播给渲染进程复用
  // 电脑端 handler。
  broadcastToLiveRenderers('workspace-admin:command', command),
)
const hasSingleInstanceLock = bypassSingleInstanceLock ? true : app.requestSingleInstanceLock()

let quitTimer: NodeJS.Timeout | null = null
let quitAfterFlushPending = false
let closeBehavior: WindowCloseBehavior = 'quit'
let trayMenuLanguage = 'zh-CN'
let tray: Tray | null = null

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
// A hard kill leaves no trace inside the app: no exit hook runs, no minidump is
// written, and main.log simply stops. The only way to tell "killed" from "the
// user closed it" after the fact is to leave a marker on disk while running and
// clear it on the way out -- if the marker is still there next launch, nobody
// ran our shutdown path. See electron/crash-relaunch-policy.ts for the
// 2026-08-11 measurements behind this.
const runSentinelPath = () => path.join(getAppDataDir(), 'run-sentinel.json')

// process.uptime() is the only start time available without a WMI round-trip.
// It is captured relative to now, so it must be read early rather than lazily.
const currentRunStartedAtIso = new Date(
  Date.now() - Math.round(process.uptime() * 1000),
).toISOString()

function writeRunSentinel(cleanExit: boolean) {
  try {
    writeFileSync(
      runSentinelPath(),
      serializeRunSentinel({ pid: process.pid, startedAtIso: currentRunStartedAtIso, cleanExit }),
      'utf8',
    )
  } catch (error) {
    log.warn('[main] Failed to write the run sentinel.', error)
  }
}

function recordRunStartAndClassifyPreviousRun() {
  let previous: ReturnType<typeof parseRunSentinel> = null
  try {
    previous = parseRunSentinel(readFileSync(runSentinelPath(), 'utf8'))
  } catch {
    previous = null
  }

  // Reaching this point means we hold the single-instance lock, so whatever the
  // sentinel names is definitively not running any more.
  const verdict = classifyPreviousRun(previous, { alive: false })
  if (verdict === 'hard-kill') {
    log.error('[main] Previous run never reached its shutdown path -- it was killed from outside.', {
      previousPid: previous?.pid,
      previousStartedAtIso: previous?.startedAtIso,
    })
  } else {
    log.info('[main] Previous run classified.', { verdict })
  }

  writeRunSentinel(false)
}

// Nothing in user space can refuse TerminateProcess, so the app cannot survive
// being killed -- it can only come back. A separate process holds one end of a
// named pipe; the pipe closes the instant this process dies by any means, and
// the sentinel written above tells that process whether the death was ours.
// See electron/crash-relaunch-guard.ts for the controlled-kill measurements.
function startCrashRelaunchGuard() {
  // Dev restarts constantly and on purpose; resurrecting it would fight the
  // developer rather than help the user.
  if (isDev || process.platform !== 'win32') {
    return
  }

  if (process.env.CHILL_VIBE_DISABLE_CRASH_RECOVERY === '1') {
    log.info('[main] Crash relaunch guard disabled by environment.')
    return
  }

  try {
    const dataDir = getAppDataDir()
    const pipePath = guardPipePath(process.pid)
    const server = createPipeServer(() => {
      // The pipe carries no data. Only the fact that it is open matters.
    })
    server.on('error', (error) => {
      log.warn('[main] Relaunch guard pipe failed.', error)
    })
    server.listen(pipePath, () => {
      void spawnCrashRelaunchGuard(dataDir, pipePath)
    })
    // Keeping the server unreferenced means it never holds the event loop open
    // and so can never delay a legitimate shutdown.
    server.unref()
  } catch (error) {
    log.warn('[main] Failed to start the relaunch guard.', error)
  }
}

async function spawnCrashRelaunchGuard(dataDir: string, pipePath: string) {
  try {
    const guardScript = path.join(moduleDir, 'crash-relaunch-guard-main.mjs')
    const launcherPath = path.join(dataDir, 'relaunch-guard.cmd')
    const quote = (value: string) => `"${value.replace(/"/g, '')}"`

    // `start "" /b` is the whole point: taskkill /T walks the target's children,
    // so a guard spawned directly from here would be killed alongside the app it
    // exists to resurrect. Routing through a cmd that exits immediately leaves
    // the guard parented to a dead PID, outside any tree that names this process.
    const launcher = [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      [
        'start "" /b',
        quote(process.execPath),
        quote(guardScript),
        '--pipe',
        quote(pipePath),
        '--sentinel',
        quote(guardSentinelPath(dataDir)),
        '--history',
        quote(guardHistoryPath(dataDir)),
        '--exec',
        quote(process.execPath),
      ].join(' '),
      '',
    ].join('\r\n')

    await writeFile(launcherPath, launcher, 'utf8')

    const child = spawn(process.env.COMSPEC ?? 'cmd.exe', ['/c', launcherPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    log.info('[main] Crash relaunch guard started.', { pipePath })
  } catch (error) {
    log.warn('[main] Failed to spawn the relaunch guard.', error)
  }
}

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

// The dev URL and the packaged file path both load through here on purpose.
// They used to be separate: dev retried on failure, packaged was a bare
// `.then()` with no catch, and that asymmetry is what turned a single-instance
// handoff into a silent flash-quit. See electron/renderer-load-retry.ts.
async function loadRendererIntoWindow(
  win: BrowserWindow,
  target: { kind: 'url' | 'file'; value: string },
) {
  const result = await loadRendererWithRetry({
    load: () => (target.kind === 'url' ? win.loadURL(target.value) : win.loadFile(target.value)),
    isAbandoned: () => win.isDestroyed(),
    onAttemptFailed: (attempt, error) => {
      log.warn('[main] Failed to load renderer, attempt', attempt, error)
    },
  })

  if (!result.loaded) {
    // An abandoned window is the normal single-instance handoff, not a fault.
    if (!result.abandoned) {
      log.error('[main] Renderer never loaded.', {
        target: target.value,
        attempts: result.attempts,
      })
    }
    return
  }

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

  // The dev bootstrap probe above awaits, so the window may have gone away in
  // the meantime; presenting a destroyed window throws.
  if (win.isDestroyed()) {
    return
  }

  if (!shouldKeepValidationWindowHidden) {
    presentWindow(win)
  }
}

// 症状：勾了“关闭后最小化到任务栏”，点 X 只是把窗口缩起来，任务栏图标照旧，
//   用户认为设置根本没生效（2026-08-17 反馈）。
// 根因：只有 minimize 一档。托盘档要真正 hide 并让出任务栏格位，此时窗口在系统里
//   已经没有任何可见入口，托盘图标就是唯一的返回路径 —— 建不出来就必须放弃隐藏。
// 被否决的替代：常驻托盘图标 —— 没隐藏时白占一格通知区，且设置切换后还要同步销毁。
function resolveTrayIcon() {
  const iconPath = path.join(projectRoot, 'build', isDev ? 'icon-dev.png' : 'icon.png')
  const image = nativeImage.createFromPath(iconPath)

  if (image.isEmpty()) {
    return null
  }

  // 托盘格位是 16-24px，直接塞 256px 原图在部分 Windows 主题下会被裁成一角。
  return image.resize({ width: 16, height: 16 })
}

function restoreFromTray(win: BrowserWindow | null | undefined) {
  if (!win || win.isDestroyed()) {
    // 窗口都没了，留着图标只会指向一个不存在的目标。
    destroyTray()
    return false
  }

  win.setSkipTaskbar(false)

  // 顺序与 close 分支的“先建托盘再隐藏”对称：窗口隐藏期间托盘图标是唯一的返回入口，
  // 所以只有真的还原出来之后才能销毁它。反过来写的话，presentWindow 一旦失败，就是
  // 窗口不可见 + 任务栏无格位 + 托盘已销毁，应用成了用户再也叫不回来的后台进程。
  const presented = presentWindow(win)

  if (presented) {
    destroyTray()
  }

  return presented
}

function destroyTray() {
  if (!tray) {
    return
  }

  // isDestroyed 检查不是多余的：restoreFromTray、设置同步、will-quit 都会调到这里，
  // 对已销毁的 Tray 再 destroy() 会抛，而其中两个调用点就在 close 监听链路上。
  if (!tray.isDestroyed()) {
    tray.destroy()
  }

  tray = null
}

function ensureTray(win: BrowserWindow) {
  if (tray && !tray.isDestroyed()) {
    return true
  }

  // 整个构建过程都包在 try 里，不只是 new Tray()：菜单构建、图标解析、事件绑定
  // 任何一步抛出都会从 win.on('close') 里冒出去，而那时 preventDefault() 已经执行，
  // 结果就是窗口既没隐藏也没最小化，点 X 看起来毫无反应（2026-08-17 实测踩到）。
  try {
    const icon = resolveTrayIcon()

    if (!icon) {
      log.warn('[main] Tray icon asset missing; refusing to hide the window with no way back.')
      return false
    }

    const isEnglish = trayMenuLanguage.startsWith('en')
    const nextTray = new Tray(icon)

    nextTray.setToolTip('Chill Vibe')
    nextTray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: isEnglish ? 'Show Chill Vibe' : '显示 Chill Vibe',
          click: () => {
            restoreFromTray(win)
          },
        },
        { type: 'separator' },
        {
          label: isEnglish ? 'Quit' : '退出',
          click: () => {
            // 走刷盘退出而不是 app.exit：托盘里点退出同样不该丢掉未保存的会话状态。
            destroyTray()
            scheduleQuitAfterFlush()
          },
        },
      ]),
    )
    nextTray.on('click', () => {
      restoreFromTray(win)
    })
    nextTray.on('double-click', () => {
      restoreFromTray(win)
    })

    tray = nextTray
    return true
  } catch (error) {
    log.warn('[main] Failed to create the tray icon.', error)
    destroyTray()
    return false
  }
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
      // 退出握手：flush 与 dispose 都是跨进程 RPC，必须**在**杀掉子进程之前 settle。
      // proxy-stats-store 的 `process.on('exit')` flushSync 只有在子进程自己走完
      // 退出路径时才跑得到，所以顺序是 flush → dispose → shutdown，全程受 will-quit
      // 之前这段 5s 预算保护。
      await desktopBackend.dispose()
    } catch (error) {
      log.warn('[main] Failed to flush pending state before quit.', error)
    } finally {
      if (quitTimer) {
        clearTimeout(quitTimer)
        quitTimer = null
      }
      backendHost.shutdown()
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
  chatStreamSubscriptions.unsubscribeOwner(webContentsId)

  for (const [subscriptionId, entry] of fileWatchSubscriptions.entries()) {
    if (entry.webContentsId !== webContentsId) {
      continue
    }

    runBackendSideEffect(
      () => desktopBackend.unwatchFile(subscriptionId),
      (error) => log.warn('[main] Failed to unwatch a file for a closed renderer.', error),
    )
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
  // 工作区列的实时会话镜像：渲染进程是 state 的唯一主人，所以镜像只能由它
  // 推上来（读盘快照在流式期间被刻意节流，对超管会话太旧）。
  // 症状（跨进程后）：超管会话的 MCP 工具恒返回空数据，且完全不报错。
  // 根因：2026-08-12 核实，镜像是 server/automation-board-session.ts:42 的模块级
  // Map；主进程曾直接 import 写它，而读它的超管桥接跑在 backend 那一侧 ——
  // 后端搬进 utilityProcess 后就是两份模块副本、两个 Map，写一份读另一份。
  // 为什么不能换写法：主进程这里只能留 IPC 收发，schema 校验与截断都必须紧贴
  // 存储侧（backend），否则新增调用方就能绕过（pitfall 183/258）。
  ipcMain.handle('workspace-admin:publish-mirror', (_event, payload: unknown) =>
    desktopBackend.publishWorkspaceSessionMirror(payload),
  )
  ipcMain.handle('workspace-admin:forget-mirror', (_event, columnId: unknown) =>
    // 返回而不是丢弃：跨进程后这是一个 Promise，丢掉它就等于把后端的失败变成一条
    // 无人处理的 rejection，而渲染端会以为镜像已经清掉了。
    desktopBackend.forgetWorkspaceSessionMirror(columnId),
  )
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
  ipcMain.handle('desktop:delete-internal-session-history', (_event, request) =>
    desktopBackend.deleteInternalSessionHistory(request),
  )
  ipcMain.handle('desktop:save-state', (_event, state) => desktopBackend.saveState(state))
  ipcMain.on('desktop:queue-state-save', (_event, state) => {
    // `ipcMain.on` has no reply channel, so anything thrown here escapes as an
    // uncaughtException and terminates the app with no shutdown log — exactly
    // how a single malformed wake-timer queue entry made the window vanish
    // every ~20 seconds on 2026-07-26. A rejected save must never be fatal.
    //
    // 后端搬进 utilityProcess 之后这里必须走 runBackendSideEffect：同步 try/catch
    // 对 rejected Promise 一行都命中不到（会成为死代码），而代理层自己仍可能同步
    // 抛（端口已关 / 载荷不可克隆）。两种形态由同一个出口兜住。
    runBackendSideEffect(
      () => desktopBackend.queueStateSave(state),
      (error) => {
        log.error('[main] Queued state save failed; keeping the app alive.', {
          error: error.message,
        })
      },
    )
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
  // 混合 handler，刻意拆两半：窗口关闭行为是主进程状态（Electron-only），
  // schema 校验紧贴调用点，剩下的转发给后端。必须 await —— 渲染端要靠这次 invoke
  // 的 settle 确认新模型已经生效，否则下一次发送仍走旧运行时设置（pitfall 137）。
  ipcMain.handle('desktop:sync-runtime-settings', async (_event, settings) => {
    const parsed = appSettingsSchema.parse(settings)
    closeBehavior = parsed.closeBehavior
    trayMenuLanguage = parsed.language

    // 用户把托盘档改回其他行为时，窗口此刻一定是可见的（不然改不了设置），
    // 留着图标只会白占一格通知区。
    if (closeBehavior !== 'tray') {
      destroyTray()
    }

    await desktopBackend.syncRuntimeSettings(parsed)
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
    // 登记发生在 registry 内部、且严格早于后端 subscribe：ChatManager.subscribe
    // 同步重放 backlog，事件在 subscribe 返回之前就打到事件通道上了。
    // "流不存在" 现在由可序列化的 { subscribed: false } 决定，registry 负责回发
    // 那条 error 并且不留下任何幽灵条目。
    // 返回而不是丢弃：跨进程后 subscribe 是异步的，丢掉它渲染端就拿不到 onError，
    // 而且端口断开 / RPC 超时会变成一条无人处理的 rejection。
    return chatStreamSubscriptions.subscribe(
      streamId,
      subscriptionId,
      event.sender.id,
      event.sender,
    )
  })
  ipcMain.handle('desktop:unsubscribe-chat-stream', (_event, subscriptionId: string) => {
    chatStreamSubscriptions.unsubscribe(subscriptionId)
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
    async (event, request: { workspacePath: string; relativePath: string; subscriptionId: string }) => {
      const sender = event.sender
      const { workspacePath, relativePath, subscriptionId } = request

      const result = await desktopBackend.watchFile(workspacePath, relativePath, subscriptionId)

      // 必须走 isFileWatchArmed 而不是 `if (result)`：后端搬进 utilityProcess 后
      // 这里拿到的是 Promise/解包后的对象，任何"看真值"的判断都恒真，登记一个
      // 从未武装的订阅 = 渲染进程以为在监听、实际永远收不到变化（静默错误）。
      if (isFileWatchArmed(result)) {
        fileWatchSubscriptions.set(subscriptionId, { webContentsId: sender.id, sender })
      }

      return result
    },
  )
  ipcMain.handle('desktop:unwatch-file', async (_event, subscriptionId: string) => {
    fileWatchSubscriptions.delete(subscriptionId)
    await desktopBackend.unwatchFile(subscriptionId)
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
  // 唯一的二进制返回值：结构化克隆只搬字节、不保原型，跨进程后到手的是普通
  // Uint8Array。在这里显式还原成 Buffer，下游（IPC 序列化、渲染端）语义不变。
  ipcMain.handle('desktop:whitenoise-read-audio', async (_event, generator: string, url?: string) =>
    toAmbientAudioBuffer(await desktopBackend.readAmbientAudioBuffer(generator, url)),
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
  // 混合 handler，刻意拆两半：目录解析 + mkdir/写 workspace.json 属于后端
  // （sticky-note-store 有模块级 workspaceQueues 写序列化 Map，主进程再 import
  // 一次就是第二份），`shell.openPath` 是 Electron-only 只能留在主进程。
  ipcMain.handle('desktop:reveal-sticky-note-location', async (_event, workspacePath: string) => {
    const targetPath = await desktopBackend.ensureStickyNoteWorkspaceDirectory(workspacePath)
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
      closeBehavior,
      quitAfterFlushPending,
    })

    if (closeAction === 'allow-close') {
      return
    }

    event.preventDefault()

    // 症状：开启“关闭后最小化”后，关闭窗口仍会杀掉正在运行的 Agent。
    // 根因：旧关闭监听无条件进入刷盘退出；2026-08-09 新设置改为主进程即时决策。
    // minimize 档刻意保留任务栏入口，托盘档才让出格位，正式退出流程始终放行。
    if (closeAction === 'minimize') {
      win.minimize()
      return
    }

    if (closeAction === 'hide-to-tray') {
      // 顺序不能反：托盘图标是隐藏后唯一的返回入口，建不出来就退回最小化，
      // 否则窗口会变成一个用户再也叫不出来的后台进程。
      if (!ensureTray(win)) {
        win.minimize()
        return
      }

      win.hide()
      win.setSkipTaskbar(true)
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

  void loadRendererIntoWindow(win, target).catch((error: unknown) => {
    log.error('[main] Unexpected renderer load failure.', error)
  })
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 藏进托盘后再点桌面快捷方式走的就是这条路：窗口还活着但既不可见也不在任务栏，
    // 单纯 focus 是叫不回来的，必须把任务栏格位和可见性一起还原。
    const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())

    if (existing) {
      restoreFromTray(existing)
      return
    }

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
  recordRunStartAndClassifyPreviousRun()
  startCrashRelaunchGuard()
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
  // fork 必须排在 configureDesktopEnvironment() **之后**：子进程只拿 fork 时刻的
  // env 快照，而 CHILL_VIBE_DATA_DIR / CHILL_VIBE_RUNTIME_KIND 都是在那里才写进
  // process.env 的。早一步 fork = 后端另开一份 profile，用户视角是"历史全没了"。
  // 也必须排在 clearUserDataOnLaunchIfNeeded() 之后，否则后端刚建的文件会被删掉。
  await backendHost.ensureBackend()
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

  // Written here rather than in 'quit': this is the last point that is
  // guaranteed to run on every ordinary shutdown, and marking it late keeps the
  // window in which a genuine kill would be misread as a clean exit as small as
  // possible.
  writeRunSentinel(true)

  if (quitTimer) {
    clearTimeout(quitTimer)
    quitTimer = null
  }

  // 托盘图标是 GDI 资源，进程退出前不销毁会在通知区留下一个点不动的幽灵图标。
  destroyTray()
  chatStreamSubscriptions.unsubscribeAll()
  // 兜底：正常退出走 scheduleQuitAfterFlush 的 flush → dispose → shutdown。
  // will-quit 无法 await，所以这里只做幂等的进程收尾，不再发新的 RPC。
  backendHost.shutdown()
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
