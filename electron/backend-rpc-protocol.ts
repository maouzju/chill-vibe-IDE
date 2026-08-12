// 主进程 ↔ utilityProcess 后端之间的消息协议：编解码、错误封送、载荷体检。
//
// 这个文件刻意与 Electron 完全无关（只用 node 内置能力），所以 node:test 可以直接
// 测它，而不需要拉起一个真实的 utilityProcess。
//
// 症状 — 后端搬进 utilityProcess 之后，backend 抛出的错误到达渲染进程时变成一个
//   空对象 `{}`：既没有 message 也没有 name，用户看到的是一句没有内容的失败。
// 根因 — 2026-08-12：结构化克隆（postMessage 用的就是它）对 Error 只保 message/
//   name/stack，对**子类的自有字段一概不保**；而 backend 里有 60+ 处 `.parse()`
//   抛 ZodError，调用方读的正是 `error.issues`。`electron/backend.ts:592-597` 已经
//   记录过一次同类事故。
// 为什么不能直接依赖结构化克隆 — 它连 Error 原型都不保证一致（跨 realm 时
//   `instanceof Error` 可假），而 main.ts 的 108 个 handler 全部把 rejection 直接
//   交给 ipcMain，渲染端按 `error.message` 展示。所以必须显式打包成纯数据、在接收
//   端重建 Error 实例。

export const backendRpcRequestType = 'backend-rpc/request'
export const backendRpcResponseType = 'backend-rpc/response'
export const backendRpcEventType = 'backend-rpc/event'
export const backendRpcHostRequestType = 'backend-rpc/host-request'
export const backendRpcHostResponseType = 'backend-rpc/host-response'
export const backendRpcInitType = 'backend-rpc/init'
export const backendRpcFatalType = 'backend-rpc/fatal'

// 后端 → 主进程的推送通道名。两侧都从这里取，避免出现"发的和收的差一个字母、
// 全程零报错"的哑火（pitfall 270 同族）。
export const backendRpcChannels = {
  chatStreamEvent: 'chat-stream-event',
  fileWatchEvent: 'file-watch-event',
  unsolicitedStream: 'unsolicited-stream',
  remoteCommand: 'remote-command',
  workspaceAdminCommand: 'workspace-admin-command',
} as const

export type SerializedBackendError = {
  name: string
  message: string
  stack?: string
  // ZodError.issues、fs 错误的 code 之类的自有字段。只收可结构化克隆的那些。
  details?: Record<string, unknown>
}

export type BackendRpcRequest = {
  type: typeof backendRpcRequestType
  id: number
  method: string
  args: unknown[]
}

export type BackendRpcResponse =
  | { type: typeof backendRpcResponseType; id: number; ok: true; value: unknown }
  | { type: typeof backendRpcResponseType; id: number; ok: false; error: SerializedBackendError }

export type BackendRpcEvent = {
  type: typeof backendRpcEventType
  channel: string
  payload: unknown
}

// 后端 → 主进程且**需要返回值**的调用（dispatchRemoteCommand /
// dispatchWorkspaceAdminCommand：布尔值直接决定 HTTP 503 还是 202）。事件是单向的，
// 装不下这种语义，所以单独一对消息类型。
export type BackendRpcHostRequest = {
  type: typeof backendRpcHostRequestType
  id: number
  channel: string
  payload: unknown
}

export type BackendRpcHostResponse =
  | { type: typeof backendRpcHostResponseType; id: number; ok: true; value: unknown }
  | {
      type: typeof backendRpcHostResponseType
      id: number
      ok: false
      error: SerializedBackendError
    }

export type BackendRpcInit = {
  type: typeof backendRpcInitType
  workingDirectory: string | null
  env?: Record<string, string>
}

export type BackendRpcFatal = {
  type: typeof backendRpcFatalType
  scope: string
  error: SerializedBackendError
}

export type BackendRpcMessage =
  | BackendRpcRequest
  | BackendRpcResponse
  | BackendRpcEvent
  | BackendRpcHostRequest
  | BackendRpcHostResponse
  | BackendRpcInit
  | BackendRpcFatal

// 沿用 server/providers.ts:1590 的 id 工厂形状（每个客户端一个闭包计数器）。这里用
// 数字而不是 `chill-vibe-${Date.now()}-${n}` 字符串：pending 表的 key 在流式热路径上
// 每秒要建/删数百次，数字 key 省掉一次字符串拼接和哈希。
export const createBackendRpcIdFactory = () => {
  let requestCount = 0
  return () => (requestCount += 1)
}

export const createBackendRpcRequest = (
  id: number,
  method: string,
  args: unknown[],
): BackendRpcRequest => ({ type: backendRpcRequestType, id, method, args })

export const createBackendRpcResponse = (id: number, value: unknown): BackendRpcResponse => ({
  type: backendRpcResponseType,
  id,
  ok: true,
  value,
})

export const createBackendRpcFailure = (id: number, error: unknown): BackendRpcResponse => ({
  type: backendRpcResponseType,
  id,
  ok: false,
  error: serializeBackendError(error),
})

export const createBackendRpcEvent = (channel: string, payload: unknown): BackendRpcEvent => ({
  type: backendRpcEventType,
  channel,
  payload,
})

export const createBackendRpcHostRequest = (
  id: number,
  channel: string,
  payload: unknown,
): BackendRpcHostRequest => ({ type: backendRpcHostRequestType, id, channel, payload })

export const createBackendRpcHostResponse = (
  id: number,
  value: unknown,
): BackendRpcHostResponse => ({ type: backendRpcHostResponseType, id, ok: true, value })

export const createBackendRpcHostFailure = (
  id: number,
  error: unknown,
): BackendRpcHostResponse => ({
  type: backendRpcHostResponseType,
  id,
  ok: false,
  error: serializeBackendError(error),
})

export const createBackendRpcInit = ({
  workingDirectory,
  env,
}: {
  workingDirectory: string | null
  env?: Record<string, string>
}): BackendRpcInit => ({
  type: backendRpcInitType,
  workingDirectory,
  ...(env ? { env } : {}),
})

export const createBackendRpcFatal = (scope: string, error: unknown): BackendRpcFatal => ({
  type: backendRpcFatalType,
  scope,
  error: serializeBackendError(error),
})

const hasType = (value: unknown, type: string): value is { type: string } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type

export const isBackendRpcRequest = (value: unknown): value is BackendRpcRequest =>
  hasType(value, backendRpcRequestType) &&
  typeof (value as BackendRpcRequest).id === 'number' &&
  typeof (value as BackendRpcRequest).method === 'string' &&
  Array.isArray((value as BackendRpcRequest).args)

export const isBackendRpcResponse = (value: unknown): value is BackendRpcResponse =>
  hasType(value, backendRpcResponseType) &&
  typeof (value as BackendRpcResponse).id === 'number' &&
  typeof (value as BackendRpcResponse).ok === 'boolean'

export const isBackendRpcEvent = (value: unknown): value is BackendRpcEvent =>
  hasType(value, backendRpcEventType) && typeof (value as BackendRpcEvent).channel === 'string'

export const isBackendRpcHostRequest = (value: unknown): value is BackendRpcHostRequest =>
  hasType(value, backendRpcHostRequestType) &&
  typeof (value as BackendRpcHostRequest).id === 'number' &&
  typeof (value as BackendRpcHostRequest).channel === 'string'

export const isBackendRpcHostResponse = (value: unknown): value is BackendRpcHostResponse =>
  hasType(value, backendRpcHostResponseType) &&
  typeof (value as BackendRpcHostResponse).id === 'number' &&
  typeof (value as BackendRpcHostResponse).ok === 'boolean'

export const isBackendRpcInit = (value: unknown): value is BackendRpcInit =>
  hasType(value, backendRpcInitType)

export const isBackendRpcFatal = (value: unknown): value is BackendRpcFatal =>
  hasType(value, backendRpcFatalType)

// ── 载荷体检 ───────────────────────────────────────────────────────────────────

export type UncloneableValueReport = {
  path: string
  reason: string
}

// 结构化克隆本身支持循环引用、Map/Set/Date/RegExp/TypedArray，所以这些都放行。
// 真正会在运行时炸掉的是函数、symbol 和这几个"活对象"。
const uncloneableTags = new Set([
  '[object Promise]',
  '[object WeakMap]',
  '[object WeakSet]',
  '[object WeakRef]',
])

const describeTag = (tag: string) => tag.slice('[object '.length, -1)

export const findUncloneableValue = (
  value: unknown,
  label = 'value',
): UncloneableValueReport | null => {
  const seen = new Set<object>()

  const walk = (current: unknown, currentPath: string): UncloneableValueReport | null => {
    const kind = typeof current

    if (kind === 'function') {
      return { path: currentPath, reason: 'function' }
    }

    if (kind === 'symbol') {
      return { path: currentPath, reason: 'symbol' }
    }

    if (current === null || kind !== 'object') {
      return null
    }

    const target = current as object

    // 循环引用对结构化克隆是合法的，但对遍历不是——不记忆就会栈溢出。
    if (seen.has(target)) {
      return null
    }
    seen.add(target)

    const tag = Object.prototype.toString.call(target)
    if (uncloneableTags.has(tag)) {
      return { path: currentPath, reason: describeTag(tag) }
    }

    if (
      target instanceof Date ||
      target instanceof RegExp ||
      target instanceof ArrayBuffer ||
      ArrayBuffer.isView(target)
    ) {
      return null
    }

    if (Array.isArray(target)) {
      for (let index = 0; index < target.length; index += 1) {
        const report = walk(target[index], `${currentPath}[${index}]`)
        if (report) {
          return report
        }
      }
      return null
    }

    if (target instanceof Map) {
      for (const [key, entry] of target) {
        const keyReport = walk(key, `${currentPath}.<key>`)
        if (keyReport) {
          return keyReport
        }
        const valueReport = walk(entry, `${currentPath}.<value>`)
        if (valueReport) {
          return valueReport
        }
      }
      return null
    }

    if (target instanceof Set) {
      for (const entry of target) {
        const report = walk(entry, `${currentPath}.<entry>`)
        if (report) {
          return report
        }
      }
      return null
    }

    for (const [key, entry] of Object.entries(target)) {
      const report = walk(entry, `${currentPath}.${key}`)
      if (report) {
        return report
      }
    }

    return null
  }

  return walk(value, label)
}

export const isStructuredCloneable = (value: unknown) => findUncloneableValue(value) === null

export const describeUncloneableValue = (report: UncloneableValueReport) =>
  `${report.path} is a ${report.reason}, which cannot cross the backend process boundary.`

// ── 错误封送 ───────────────────────────────────────────────────────────────────

const fallbackErrorMessage = 'The backend call failed without an error message.'

const describeNonError = (error: unknown) => {
  if (typeof error === 'string') {
    return error
  }

  if (error === undefined || error === null) {
    return fallbackErrorMessage
  }

  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export const serializeBackendError = (error: unknown): SerializedBackendError => {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: describeNonError(error) }
  }

  const details: Record<string, unknown> = {}
  // 必须走 getOwnPropertyNames + 描述符，不能用 Object.keys：2026-08-12 实测
  // zod 4.3.6 的 `ZodError.issues` 是**自有但不可枚举**的数据属性
  // （Object.keys 只给得到 name/message），而 issues 正是 60+ 处 .parse() 调用方
  // 唯一会读的字段。同时只收数据属性、不碰 getter —— 取值本身可能抛
  // （`stack`/`isEmpty` 在 zod 上就是访问器），在封送一个错误的过程中再抛一个
  // 错误是最难查的形态。
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') {
      continue
    }

    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    if (!descriptor || !('value' in descriptor)) {
      continue
    }

    // 自有字段里混进函数/Promise 时整条消息会在 postMessage 里抛 DataCloneError，
    // 把一次普通的业务失败升级成传输层故障。宁可丢掉这个字段。
    // （ZodError 的 `_zod` 就是这样被挡掉的：它内含 `constr` 构造函数。）
    if (!isStructuredCloneable(descriptor.value)) {
      continue
    }

    details[key] = descriptor.value
  }

  return {
    name: error.name || 'Error',
    message: error.message || fallbackErrorMessage,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}

export const deserializeBackendError = (payload: unknown): Error => {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Partial<
    SerializedBackendError
  >

  const message = typeof source.message === 'string' && source.message ? source.message : fallbackErrorMessage
  const restored = new Error(message)
  restored.name = typeof source.name === 'string' && source.name ? source.name : 'Error'

  // 保留**后端侧**的 stack：本地重建的那条只会指向 port 层，对定位毫无用处。
  if (typeof source.stack === 'string' && source.stack) {
    restored.stack = source.stack
  }

  if (source.details && typeof source.details === 'object') {
    Object.assign(restored, source.details)
  }

  return restored
}
