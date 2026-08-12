// 后端 utilityProcess 的监管者：fork 时机、init 握手、推送通道的重新登记、
// 崩溃重启、退出握手，全部收在这一个可注入的工厂里。
//
// 症状 — 用户报"闪退"。实测退出码 0xCFFFFFFF = Windows 因窗口 5 秒不泵消息把进程
//   杀了；全天 0 次渲染进程 unresponsive 事件，冻结时主进程 minidump 停在内核等待
//   —— 卡的是**主进程主线程**。
// 根因 — 2026-08-12：`server/` 全跑在主进程主线程，而 libuv 在 Windows 上同步执行
//   CreateProcessW。40 次 git spawn p50=102ms、最坏单次 6910ms，而每轮对话结束的
//   全量 diff 最多派生 768 个 git 子进程。同一批 20 次 git 调用跑在主进程时窗口
//   单次最长停摆 6827ms（11 次 >1s、2 次 >5s），跑在 utilityProcess 只有 58ms。
// 为什么不是 `utilityProcess.fork` 直接写在 main.ts — fork 必须排在
//   `configureDesktopEnvironment()` 之后（子进程只拿 fork 时刻的 env 快照），而
//   `createDesktopBackend()` 原本在模块顶层执行。把"什么时候允许 fork"做成一道
//   显式的门（ensureBackend），才可能对它写守卫测试；散在 main.ts 里只能对源码
//   文本做正则断言，那证明不了任何运行时行为（pitfall 248）。

import {
  createBackendRpcClient,
  isBackendProxyMethodName,
  type BackendRpcClient,
  type BackendRpcClientOptions,
} from './backend-rpc-client.js'
import { createBackendRpcInit, type BackendRpcMessage } from './backend-rpc-protocol.js'

// 只依赖这四个能力，不碰 Electron 的 utilityProcess：假 child 才驱动得动真实编排。
export type BackendHostChild = {
  postMessage: (message: BackendRpcMessage) => void
  onMessage: (listener: (message: unknown) => void) => void
  onExit: (listener: (code: number | null) => void) => void
  kill: () => void
}

export type BackendHostInit = {
  // 打包版是 null（host 会正确跳过 chdir 并继承 fork 时的 cwd）。
  workingDirectory: string | null
  env?: Record<string, string>
}

export type BackendHostLoss = {
  exitCode: number | null
  attempt: number
  willRestart: boolean
}

export type BackendHostOptions = {
  fork: () => BackendHostChild
  resolveInit: () => BackendHostInit
  // 后端没了（无论会不会重启）。调用方必须借此告知渲染端所有 streamId 失效：
  // 今天后端死 = 整个 app 死（可见），以后 utility 独立退出而窗口还活着。
  onBackendLost?: (loss: BackendHostLoss) => void
  onLog?: (level: 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void
  maxRestarts?: number
  restartDelayMs?: number
  // 活满这段时间才算"这次启动是健康的"，重启预算随之归零；否则一个开机就崩的
  // 后端会靠"每次都重启一次"把预算无限续下去。
  restartCounterResetMs?: number
  schedule?: (callback: () => void, delayMs: number) => void
  now?: () => number
  clientOptions?: BackendRpcClientOptions
}

// 同形状但每个方法都返回 Promise。后端里有一批同步方法（`fetchWhiteNoiseScenes`
// 返回 NoiseScene[]、`unwatchFile` 返回 void），跨进程后它们**全部**变成 Promise；
// 让类型如实说出这一点，调用点漏掉的 await 才会在 `pnpm check` 里红，而不是在
// 运行时变成一个恒真的 thenable。
export type AsyncifiedBackend<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K]
}

export const backendNotStartedMessage = 'The backend process has not been started yet.'
export const backendUnavailableMessage = 'The backend process is not available.'

const defaultMaxRestarts = 5
const defaultRestartDelayMs = 500
const defaultRestartCounterResetMs = 60_000

// 空字符串不是"当前目录"，它只是一个没写完的路径。打包版本来就该传 null，
// 让 host 跳过 chdir 并继承 fork 时的 cwd。
export const resolveBackendInitWorkingDirectory = (value: string | null | undefined) => {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export type BackendHost<T extends object> = {
  proxy: T
  ensureBackend: () => Promise<void>
  onEvent: (channel: string, handler: (payload: never) => void) => () => void
  onRequest: (channel: string, handler: (payload: never) => unknown) => () => void
  isRunning: () => boolean
  restartCount: () => number
  shutdown: () => void
}

export const createBackendHost = <T extends object>(options: BackendHostOptions): BackendHost<T> => {
  const {
    fork,
    resolveInit,
    onBackendLost,
    onLog,
    maxRestarts = defaultMaxRestarts,
    restartDelayMs = defaultRestartDelayMs,
    restartCounterResetMs = defaultRestartCounterResetMs,
    schedule = (callback, delayMs) => {
      setTimeout(callback, delayMs)
    },
    now = () => Date.now(),
    clientOptions,
  } = options

  const eventHandlers = new Map<string, Set<(payload: never) => void>>()
  const requestHandlers = new Map<string, (payload: never) => unknown>()
  const methodCache = new Map<string, (...args: unknown[]) => Promise<unknown>>()

  let child: BackendHostChild | null = null
  let client: BackendRpcClient<T> | null = null
  let started = false
  let stopped = false
  let restarts = 0
  let launchedAt = 0
  let relaunching: Promise<void> | null = null

  const attachChannels = (target: BackendRpcClient<T>) => {
    // 事件/反向请求的登记留在监管者这一层，每次换 client 都重新挂一遍。
    // 忘了重挂的表现：重启之后聊天流事件全丢、手机远程监工静默全部报"无窗口"。
    for (const channel of eventHandlers.keys()) {
      target.onEvent(channel, (payload) => {
        for (const handler of [...(eventHandlers.get(channel) ?? [])]) {
          handler(payload)
        }
      })
    }

    for (const channel of requestHandlers.keys()) {
      target.onRequest(channel, (payload) => {
        const handler = requestHandlers.get(channel)
        if (!handler) {
          // 没有处理者时必须抛：静默回 undefined 会被后端读成 false，于是手机监工
          // 报"无窗口"而日志里一个字都没有 —— 正是这次改造要消灭的失败模式。
          throw new Error(`No main-process handler for channel "${channel}".`)
        }

        return handler(payload)
      })
    }
  }

  const launch = () => {
    const nextChild = fork()
    child = nextChild
    launchedAt = now()

    // init **必须**是端口上的第一条消息。utility host 会缓冲早到的请求，但缓冲只在
    // init 到达时才解开：init 若不来，所有调用永远挂在缓冲里（而不是报错）。
    // 先 post 再建 client，保证任何 RPC 都排在它后面。
    nextChild.postMessage(createBackendRpcInit(normalizeInit()))

    const nextClient = createBackendRpcClient<T>(
      {
        postMessage: (message) => nextChild.postMessage(message),
        onMessage: (listener) => nextChild.onMessage(listener),
      },
      clientOptions,
    )

    client = nextClient
    attachChannels(nextClient)

    nextChild.onExit((code) => {
      if (child !== nextChild) {
        // 已经被换掉的旧 child 迟到的 exit。忽略，否则会把健康的新进程算作崩溃。
        return
      }

      handleExit(nextClient, code)
    })
  }

  const normalizeInit = (): BackendHostInit => {
    const init = resolveInit()
    return {
      workingDirectory: resolveBackendInitWorkingDirectory(init.workingDirectory),
      ...(init.env ? { env: init.env } : {}),
    }
  }

  const handleExit = (deadClient: BackendRpcClient<T>, code: number | null) => {
    child = null
    client = null

    // 在途调用必须被拒绝：挂着不动 = 用户视角的"永久无响应"，而这次窗口还活着。
    deadClient.close(`The backend process exited (code ${code ?? 'unknown'}).`)

    if (stopped) {
      return
    }

    if (now() - launchedAt >= restartCounterResetMs) {
      restarts = 0
    }

    restarts += 1
    const willRestart = restarts <= maxRestarts

    onLog?.(willRestart ? 'warn' : 'error', '[main] Backend process exited.', {
      exitCode: code,
      attempt: restarts,
      willRestart,
    })
    onBackendLost?.({ exitCode: code, attempt: restarts, willRestart })

    if (!willRestart) {
      return
    }

    relaunching = new Promise<void>((resolve) => {
      schedule(() => {
        relaunching = null
        if (stopped) {
          resolve()
          return
        }

        try {
          launch()
        } catch (error) {
          onLog?.('error', '[main] Failed to restart the backend process.', {
            error: error instanceof Error ? error.message : String(error),
          })
        }

        resolve()
      }, restartDelayMs)
    })
  }

  const invoke = async (method: string, args: unknown[]) => {
    if (!started) {
      // fork 早于 configureDesktopEnvironment() 就是数据目录静默漂移，所以宁可
      // 响亮地失败也绝不在这里顺手起进程。
      throw new Error(backendNotStartedMessage)
    }

    if (!client && relaunching) {
      await relaunching
    }

    const active = client
    if (!active) {
      throw new Error(backendUnavailableMessage)
    }

    return (active.proxy as Record<string, (...callArgs: unknown[]) => Promise<unknown>>)[method]!(
      ...args,
    )
  }

  const proxy = new Proxy({} as T, {
    get: (_target, property) => {
      if (!isBackendProxyMethodName(property)) {
        return undefined
      }

      const cached = methodCache.get(property)
      if (cached) {
        return cached
      }

      // 稳定的函数身份必须活过重启：main.ts 的 108 个 handler 在启动时就闭包捕获了
      // 这些方法，重启换掉的是内层 client，外层这一份不能动。
      const method = (...args: unknown[]) => invoke(property, args)
      methodCache.set(property, method)
      return method
    },
    has: () => true,
  })

  return {
    proxy,

    ensureBackend: async () => {
      if (stopped) {
        throw new Error(backendUnavailableMessage)
      }

      if (!started) {
        started = true
        launch()
      }
    },

    onEvent: (channel, handler) => {
      const handlers = eventHandlers.get(channel) ?? new Set()
      const isNewChannel = handlers.size === 0
      handlers.add(handler)
      eventHandlers.set(channel, handlers)

      if (isNewChannel && client) {
        client.onEvent(channel, (payload) => {
          for (const entry of [...(eventHandlers.get(channel) ?? [])]) {
            entry(payload)
          }
        })
      }

      return () => {
        handlers.delete(handler)
      }
    },

    onRequest: (channel, handler) => {
      const isNewChannel = !requestHandlers.has(channel)
      requestHandlers.set(channel, handler)

      if (isNewChannel && client) {
        client.onRequest(channel, (payload) => {
          const current = requestHandlers.get(channel)
          if (!current) {
            throw new Error(`No main-process handler for channel "${channel}".`)
          }

          return current(payload)
        })
      }

      return () => {
        if (requestHandlers.get(channel) === handler) {
          requestHandlers.delete(channel)
        }
      }
    },

    isRunning: () => client !== null,
    restartCount: () => restarts,

    shutdown: () => {
      // `child` 刻意**不**清空：清了的话随后到达的 exit 会被 launch() 里的
      // "旧 child 迟到"分支吃掉，`stopped` 那道闸门就永远跑不到、变成没人测得
      // 到的死代码。留着让退出走同一条 handleExit，由 stopped 一处决定不重启。
      stopped = true
      client?.close(backendUnavailableMessage)
      client = null
      child?.kill()
    },
  }
}
