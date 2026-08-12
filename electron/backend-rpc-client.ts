// 主进程侧的后端代理：把 `desktopBackend.foo(a, b)` 变成端口上的一条 RPC。
//
// 症状 — `server/` 的 28385 行全部跑在主进程主线程上，和窗口消息泵共用一个线程；
//   任何一次同步/阻塞操作直接冻窗，超过 5 秒就被 Windows 打上 0xCFFFFFFF 杀掉
//   （用户视角的"闪退"）。
// 根因 — 2026-08-12 实测：同一批 20 次 git 调用，跑在主进程时窗口单次最长停摆
//   6827ms（11 次 >1s、2 次 >5s），跑在 utilityProcess 只有 58ms（0 次超标）。
// 为什么是 Proxy 而不是逐个改写 — main.ts 有 108 个 IPC handler，每个都调
//   `createDesktopBackend()` 返回对象上的一个方法。同形状 Proxy 让 handler 主体
//   一行不用改（SPEC R2），替换点收敛到 backend 的创建处这一个地方。
//
// 形状沿用 server/providers.ts:1729-2034 的 Codex JSON-RPC 客户端：id 工厂 +
// pending-promise map + 可选超时 + 拆解时 mass-reject。不另发明一套。

import {
  createBackendRpcHostFailure,
  createBackendRpcHostResponse,
  createBackendRpcIdFactory,
  createBackendRpcRequest,
  deserializeBackendError,
  describeUncloneableValue,
  findUncloneableValue,
  isBackendRpcEvent,
  isBackendRpcHostRequest,
  isBackendRpcResponse,
  type BackendRpcMessage,
} from './backend-rpc-protocol.js'

// 只依赖这三个能力，不碰 Electron 的 utilityProcess：假 transport 才测得动。
export type BackendRpcTransport = {
  postMessage: (message: BackendRpcMessage) => void
  onMessage: (listener: (message: unknown) => void) => void
  onClose?: (listener: (reason: string) => void) => void
}

export type BackendRpcClientOptions = {
  // 默认 null = 不超时。后端有真·长跑方法（安装 CLI、拉 Ollama 模型、大仓库
  // git 操作），一刀切的超时会把"慢"变成"失败"；真正兜住"永远挂起"的是下面
  // 传输断开时的 mass-reject，不是计时器。
  timeoutMs?: number | null
  resolveTimeoutMs?: (method: string) => number | null | undefined
  // 开发期体检：把"传了个函数过去"在 postMessage 之前就拍死。默认关闭，因为
  // queueSaveState 这类调用的载荷实测 1.2MB，逐字段遍历本身就是主线程开销 ——
  // 而这正是这次改造要消灭的东西。用 CHILL_VIBE_BACKEND_RPC_VALIDATE=1 打开。
  validatePayloads?: boolean
}

export type BackendRpcClient<T extends object> = {
  proxy: T
  onEvent: (channel: string, handler: (payload: never) => void) => () => void
  onRequest: (channel: string, handler: (payload: never) => unknown) => () => void
  close: (reason?: string) => void
  pendingRequestCount: () => number
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

// `await proxy` 会去查 `then`；任意属性都返回函数的话，代理会被当成 thenable，
// 那个 then 永远不 resolve = 整条调用链静默挂死。JSON.stringify 查 `toJSON` 同理。
const nonMethodProperties = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor'])

// backend-host.ts 的外层代理（跨重启保持同一份对象身份）必须与这里做完全相同的
// 判断。导出而不是在那边照抄一份：抄错一个词就是"await 后端代理静默挂死"，而这类
// 手抄名单在本仓库已经栽过（pitfall 263）。
export const isBackendProxyMethodName = (property: string | symbol): property is string =>
  typeof property === 'string' && !nonMethodProperties.has(property)

const resolveDefaultValidatePayloads = () =>
  process.env.CHILL_VIBE_BACKEND_RPC_VALIDATE === '1'

export const createBackendRpcClient = <T extends object>(
  transport: BackendRpcTransport,
  options: BackendRpcClientOptions = {},
): BackendRpcClient<T> => {
  const nextRequestId = createBackendRpcIdFactory()
  const pendingRequests = new Map<number, PendingRequest>()
  const eventHandlers = new Map<string, Set<(payload: never) => void>>()
  const requestHandlers = new Map<string, (payload: never) => unknown>()
  const methodCache = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const validatePayloads = options.validatePayloads ?? resolveDefaultValidatePayloads()

  let closedReason: string | null = null

  const resolveTimeoutMs = (method: string) => {
    const override = options.resolveTimeoutMs?.(method)
    if (override !== undefined) {
      return override
    }

    return options.timeoutMs ?? null
  }

  const rejectPendingRequests = (message: string) => {
    for (const { reject } of pendingRequests.values()) {
      reject(new Error(message))
    }
    pendingRequests.clear()
  }

  const sendRequest = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (closedReason) {
        reject(new Error(closedReason))
        return
      }

      if (validatePayloads) {
        const report = findUncloneableValue(args, 'args')
        if (report) {
          reject(new Error(`${method}: ${describeUncloneableValue(report)}`))
          return
        }
      }

      const id = nextRequestId()
      const timeoutMs = resolveTimeoutMs(method)
      const timer =
        typeof timeoutMs === 'number' && timeoutMs > 0
          ? setTimeout(() => {
              pendingRequests.delete(id)
              reject(new Error(`${method} timed out after ${timeoutMs}ms.`))
            }, timeoutMs)
          : null

      pendingRequests.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })

      try {
        transport.postMessage(createBackendRpcRequest(id, method, args))
      } catch (error) {
        pendingRequests.delete(id)
        if (timer) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

  const handleHostRequest = (id: number, channel: string, payload: unknown) => {
    const handler = requestHandlers.get(channel)
    if (!handler) {
      // 后端在等这个返回值（它决定 HTTP 503/202）。没人处理时必须回一个失败，
      // 不能什么都不发——那会让后端侧的 pending 永远挂着。
      transport.postMessage(
        createBackendRpcHostFailure(
          id,
          new Error(`No main-process handler for channel "${channel}".`),
        ),
      )
      return
    }

    void (async () => {
      try {
        const value = await handler(payload as never)
        transport.postMessage(createBackendRpcHostResponse(id, value))
      } catch (error) {
        transport.postMessage(createBackendRpcHostFailure(id, error))
      }
    })()
  }

  transport.onMessage((message) => {
    if (isBackendRpcResponse(message)) {
      const pending = pendingRequests.get(message.id)
      // 未知 id = 超时后迟到的回复，或重复投递。安静丢弃。
      if (!pending) {
        return
      }

      pendingRequests.delete(message.id)
      if (message.ok) {
        pending.resolve(message.value)
      } else {
        pending.reject(deserializeBackendError(message.error))
      }
      return
    }

    if (isBackendRpcEvent(message)) {
      const handlers = eventHandlers.get(message.channel)
      if (!handlers) {
        return
      }

      for (const handler of [...handlers]) {
        handler(message.payload as never)
      }
      return
    }

    if (isBackendRpcHostRequest(message)) {
      handleHostRequest(message.id, message.channel, message.payload)
    }
  })

  const close = (reason = 'The backend process is no longer available.') => {
    closedReason = reason
    rejectPendingRequests(reason)
  }

  transport.onClose?.((reason) => {
    close(reason)
  })

  const proxy = new Proxy({} as T, {
    get: (_target, property) => {
      if (typeof property !== 'string' || nonMethodProperties.has(property)) {
        return undefined
      }

      const cached = methodCache.get(property)
      if (cached) {
        return cached
      }

      // 稳定的函数身份：handler 里可能把方法取出来复用，且热路径上不应该
      // 每次属性访问都新建一个闭包。
      const method = (...args: unknown[]) => sendRequest(property, args)
      methodCache.set(property, method)
      return method
    },
    has: () => true,
  })

  return {
    proxy,
    onEvent: (channel, handler) => {
      const handlers = eventHandlers.get(channel) ?? new Set()
      handlers.add(handler)
      eventHandlers.set(channel, handlers)

      return () => {
        handlers.delete(handler)
        if (handlers.size === 0) {
          eventHandlers.delete(channel)
        }
      }
    },
    onRequest: (channel, handler) => {
      requestHandlers.set(channel, handler)
      return () => {
        if (requestHandlers.get(channel) === handler) {
          requestHandlers.delete(channel)
        }
      }
    },
    close,
    pendingRequestCount: () => pendingRequests.size,
  }
}

// main.ts 的唯一替换点用这个：拿到的对象与 `createDesktopBackend()` 的返回值同形状，
// 108 个 handler 原样不动。事件/反向请求的注册走 createBackendRpcClient。
export const createBackendProxy = <T extends object>(
  transport: BackendRpcTransport,
  options?: BackendRpcClientOptions,
): T => createBackendRpcClient<T>(transport, options).proxy
