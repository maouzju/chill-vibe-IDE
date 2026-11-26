import type { Provider } from './schema.js'

// 哪些 provider 的原生会话文件能做「无损分叉」（server/session-fork.ts 的文件手术）。
// 服务端（不支持就返回 null）和渲染端（恢复时决定清不清会话）共用这一张表：
// Gemini CLI 的会话文件格式没做手术，分叉必然落空。
const losslessSessionForkProviders: ReadonlySet<Provider> = new Set<Provider>(['claude', 'codex'])

export const providerSupportsLosslessSessionFork = (provider: Provider) =>
  losslessSessionForkProviders.has(provider)
