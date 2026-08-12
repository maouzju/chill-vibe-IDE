// utilityProcess 侧的后端宿主：收 RPC 请求 → 调真正的 backend 方法 → 回结果或
// 封送后的错误；backend 的推送型 deps 回调改为向主进程发消息。
//
// 这个文件在 utility 进程里以 **ESM** 被加载（`dist/electron/package.json` 是
// `{"type":"module"}`），2026-08-12 已用真实打包产物实测 asar 内 ESM 可被
// `utilityProcess.fork` 直接加载，**无需 asarUnpack**（见
// scripts/bench-main-thread-isolation/probe-asar-esm.js）。
//
// 编排全部收在 createBackendUtilityHost 这个可注入的工厂里，底部只有一段
// `process.parentPort` 存在时才执行的接线（pitfall 211 的 direct-entry guard）：
// 这样单测可以用假 transport 驱动真实编排，而不是对源码文本做正则断言
// （pitfall 248）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  backendRpcChannels,
  createBackendRpcEvent,
  createBackendRpcFailure,
  createBackendRpcFatal,
  createBackendRpcHostRequest,
  createBackendRpcIdFactory,
  createBackendRpcResponse,
  isBackendRpcHostResponse,
  isBackendRpcInit,
  isBackendRpcRequest,
  type BackendRpcMessage,
  type BackendRpcRequest,
} from './backend-rpc-protocol.js'

export type UtilityHostTransport = {
  postMessage: (message: BackendRpcMessage) => void
  onMessage: (listener: (message: unknown) => void) => void
}

// 后端的推送型依赖。载荷类型刻意留成 unknown：宿主只负责搬运，形状的真相在
// electron/backend.ts，在这里复述一遍只会多一个会漂移的副本。
export type UtilityHostBackendDeps = {
  onChatStreamEvent: (event: unknown) => void
  onFileWatchEvent: (event: unknown) => void
  onUnsolicitedStream: (notification: unknown) => void
  dispatchRemoteCommand: (command: unknown) => Promise<boolean>
  dispatchWorkspaceAdminCommand: (command: unknown) => Promise<boolean>
}

export type UtilityHostBackend = Record<string, unknown>

export type UtilityHostOptions = {
  transport: UtilityHostTransport
  loadBackend: (deps: UtilityHostBackendDeps) => UtilityHostBackend | Promise<UtilityHostBackend>
  directoryExists?: (directory: string) => boolean
  chdir?: (directory: string) => void
  applyEnv?: (env: Record<string, string>) => void
  logFatal?: (scope: string, error: unknown) => void
  // 主进程不回应时的收敛时间。这个返回值直接决定手机监工 / 超管桥接回 503 还是
  // 202，所以宁可到点判 false，也不能让 HTTP 请求永远挂着。
  hostRequestTimeoutMs?: number
}

const defaultHostRequestTimeoutMs = 10_000

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error))

export const createBackendUtilityHost = (options: UtilityHostOptions) => {
  const {
    transport,
    loadBackend,
    directoryExists = (directory: string) => fs.existsSync(directory),
    chdir = (directory: string) => {
      process.chdir(directory)
    },
    applyEnv = (env: Record<string, string>) => {
      Object.assign(process.env, env)
    },
    logFatal,
    hostRequestTimeoutMs = defaultHostRequestTimeoutMs,
  } = options

  const nextHostRequestId = createBackendRpcIdFactory()
  const pendingHostRequests = new Map<number, (value: unknown) => void>()
  const bufferedRequests: BackendRpcRequest[] = []

  let initState: 'pending' | 'ready' | 'failed' = 'pending'
  let initError: Error | null = null
  let backendPromise: Promise<UtilityHostBackend> | null = null

  const reportFatal = (scope: string, error: unknown) => {
    logFatal?.(scope, error)
    try {
      transport.postMessage(createBackendRpcFatal(scope, error))
    } catch {
      // 端口已经没了。日志侧已经落过一次，这里不能再抛，否则连收尾都做不完。
    }
  }

  const callHost = (channel: string, payload: unknown) =>
    new Promise<boolean>((resolve) => {
      const id = nextHostRequestId()
      const timer = setTimeout(() => {
        pendingHostRequests.delete(id)
        resolve(false)
      }, hostRequestTimeoutMs)
      timer.unref?.()

      pendingHostRequests.set(id, (value) => {
        clearTimeout(timer)
        resolve(value === true)
      })

      try {
        transport.postMessage(createBackendRpcHostRequest(id, channel, payload))
      } catch (error) {
        clearTimeout(timer)
        pendingHostRequests.delete(id)
        logFatal?.('host-request', error)
        resolve(false)
      }
    })

  const postEvent = (channel: string, payload: unknown) => {
    try {
      transport.postMessage(createBackendRpcEvent(channel, payload))
    } catch (error) {
      // 流事件实测 ≈480 次/秒。一条投递失败不能把整个后端拖垮，但也不能静默：
      // 静默失败正是这次改造要消灭的失败模式。
      logFatal?.(`event:${channel}`, error)
    }
  }

  const backendDeps: UtilityHostBackendDeps = {
    onChatStreamEvent: (event) => postEvent(backendRpcChannels.chatStreamEvent, event),
    onFileWatchEvent: (event) => postEvent(backendRpcChannels.fileWatchEvent, event),
    onUnsolicitedStream: (notification) =>
      postEvent(backendRpcChannels.unsolicitedStream, notification),
    dispatchRemoteCommand: (command) => callHost(backendRpcChannels.remoteCommand, command),
    dispatchWorkspaceAdminCommand: (command) =>
      callHost(backendRpcChannels.workspaceAdminCommand, command),
  }

  const ensureBackend = () => {
    if (!backendPromise) {
      const pending = (async () => await loadBackend(backendDeps))()
      pending.catch(() => {
        // 加载失败不该把宿主钉死：清空缓存让下一次调用重试，同时这次调用照常
        // 收到失败响应。
        if (backendPromise === pending) {
          backendPromise = null
        }
      })
      backendPromise = pending
    }

    return backendPromise
  }

  const invoke = async (request: BackendRpcRequest) => {
    try {
      const backend = await ensureBackend()
      const method = backend[request.method]

      if (typeof method !== 'function') {
        throw new Error(`Unknown backend method "${request.method}".`)
      }

      const value = await (method as (...args: unknown[]) => unknown).apply(backend, request.args)
      transport.postMessage(createBackendRpcResponse(request.id, value))
    } catch (error) {
      transport.postMessage(createBackendRpcFailure(request.id, error))
    }
  }

  const handleRequest = (request: BackendRpcRequest) => {
    if (initState === 'pending') {
      // 端口是 FIFO 的，所以正常情况下 init 一定先到；缓冲只是为了让"顺序万一
      // 变了"退化成延迟，而不是退化成用错的 cwd 跑业务逻辑（= 数据目录漂移）。
      bufferedRequests.push(request)
      return
    }

    if (initState === 'failed') {
      transport.postMessage(
        createBackendRpcFailure(request.id, initError ?? new Error('The backend never started.')),
      )
      return
    }

    void invoke(request)
  }

  const failInit = (scope: string, error: Error) => {
    initState = 'failed'
    initError = error
    reportFatal(scope, error)

    const drained = bufferedRequests.splice(0, bufferedRequests.length)
    for (const request of drained) {
      transport.postMessage(createBackendRpcFailure(request.id, error))
    }
  }

  const handleInit = (workingDirectory: string | null, env?: Record<string, string>) => {
    if (initState !== 'pending') {
      return
    }

    if (env) {
      applyEnv(env)
    }

    // 症状 — 数据目录静默漂移，用户视角是"历史全没了"。
    // 根因 — 2026-08-12：主进程的 `process.chdir()`（main.ts:271）不传给子进程，
    //   而 server 有 6 处依赖 `process.cwd()`，其中 server/app-paths.ts:12 是
    //   getAppDataDir 的兜底。
    // 为什么不用 fork 的 cwd 选项 — 同日实测：cwd 指向不存在的路径时子进程
    //   **静默死亡**（不抛异常、无 exit 事件、postMessage 石沉大海）；进程内
    //   chdir 失败会抛可捕获的错误，是唯一能变成明确报错的写法。
    if (workingDirectory) {
      if (!directoryExists(workingDirectory)) {
        failInit(
          'init',
          new Error(`The backend working directory does not exist: ${workingDirectory}`),
        )
        return
      }

      try {
        chdir(workingDirectory)
      } catch (error) {
        failInit(
          'init',
          new Error(
            `Failed to enter the backend working directory "${workingDirectory}": ${toError(error).message}`,
          ),
        )
        return
      }
    }

    initState = 'ready'

    const drained = bufferedRequests.splice(0, bufferedRequests.length)
    for (const request of drained) {
      void invoke(request)
    }
  }

  transport.onMessage((message) => {
    if (isBackendRpcInit(message)) {
      handleInit(message.workingDirectory, message.env)
      return
    }

    if (isBackendRpcRequest(message)) {
      handleRequest(message)
      return
    }

    if (isBackendRpcHostResponse(message)) {
      const settle = pendingHostRequests.get(message.id)
      if (!settle) {
        return
      }

      pendingHostRequests.delete(message.id)
      settle(message.ok ? message.value : false)
    }
  })

  return {
    isReady: () => initState === 'ready',
    getInitError: () => initError,
    reportFatal,
  }
}

// ── 自带崩溃日志 ───────────────────────────────────────────────────────────────
//
// 症状 — 一次未捕获错误让后端进程静默死亡，而窗口还活着：所有操作永久挂起、
//   日志里一个字都没有，比现在的闪退更难查。
// 根因 — electron/crash-logger.ts 依赖 `electron-log/main` + `app.isPackaged`，
//   utility 进程里没有 `app`，那套完全用不了。
// 为什么不转发给主进程了事 — 端口本身可能已经断了（那正是最需要日志的时刻），
//   所以必须先落盘再尽力上报。

export const resolveUtilityHostLogPath = (dataDir?: string | null) => {
  const root = dataDir?.trim() ? dataDir.trim() : path.join(process.cwd(), '.chill-vibe')
  return path.join(root, 'logs', 'utility-host.log')
}

export const formatUtilityHostCrashLine = (scope: string, error: unknown, at = new Date()) => {
  const detail =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error)
            } catch {
              return String(error)
            }
          })()

  return `[${at.toISOString()}] [utility-host] ${scope}: ${detail}${os.EOL}`
}

const maxUtilityHostLogBytes = 5 * 1024 * 1024

export const appendUtilityHostCrashLine = (line: string) => {
  try {
    const logPath = resolveUtilityHostLogPath(process.env.CHILL_VIBE_DATA_DIR)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })

    const size = fs.statSync(logPath, { throwIfNoEntry: false })?.size ?? 0
    if (size > maxUtilityHostLogBytes) {
      fs.rmSync(`${logPath}.1`, { force: true })
      fs.renameSync(logPath, `${logPath}.1`)
    }

    fs.appendFileSync(logPath, line, 'utf8')
  } catch {
    // 日志本身失败时不能再抛：那会把一次可恢复的业务错误升级成进程死亡。
  }
}

type ParentPortLike = {
  postMessage: (message: unknown) => void
  on: (event: 'message', listener: (event: { data: unknown }) => void) => void
}

export const startUtilityHostOnParentPort = (parentPort: ParentPortLike) => {
  const transport: UtilityHostTransport = {
    postMessage: (message) => parentPort.postMessage(message),
    onMessage: (listener) => {
      parentPort.on('message', (event) => listener(event.data))
    },
  }

  const host = createBackendUtilityHost({
    transport,
    logFatal: (scope, error) => {
      appendUtilityHostCrashLine(formatUtilityHostCrashLine(scope, error))
    },
    // 懒加载不是权宜之计：backend.ts 会顺带拉起整棵 server/ 树，而其中一部分在
    // 模块作用域就解析数据目录（pitfall 77/79）。必须等 init 把 env/cwd 摆正之后
    // 才允许它被 import，否则 profile 会静默漂移。
    loadBackend: async (deps) => {
      const { createDesktopBackend } = await import('./backend.js')
      return createDesktopBackend({
        onChatStreamEvent: (event) => deps.onChatStreamEvent(event),
        onFileWatchEvent: (event) => deps.onFileWatchEvent(event),
        onUnsolicitedStream: (notification) => deps.onUnsolicitedStream(notification),
        dispatchRemoteCommand: (command) => deps.dispatchRemoteCommand(command),
        dispatchWorkspaceAdminCommand: (command) => deps.dispatchWorkspaceAdminCommand(command),
      }) as unknown as UtilityHostBackend
    },
  })

  // 和 crash-logger.ts 保持同一姿态：记录但不主动退出。后端进程里挂着 108 个
  // 通道和整个 Claude 进程池，一条无人处理的 rejection 不该把它们全带走。
  process.on('uncaughtException', (error) => {
    appendUtilityHostCrashLine(formatUtilityHostCrashLine('uncaughtException', error))
    host.reportFatal('uncaughtException', error)
  })

  process.on('unhandledRejection', (reason) => {
    appendUtilityHostCrashLine(formatUtilityHostCrashLine('unhandledRejection', reason))
    host.reportFatal('unhandledRejection', reason)
  })

  process.on('exit', (code) => {
    appendUtilityHostCrashLine(
      formatUtilityHostCrashLine('exit', new Error(`utility host exited with code ${code}`)),
    )
  })

  return host
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

if (parentPort) {
  startUtilityHostOnParentPort(parentPort)
}
