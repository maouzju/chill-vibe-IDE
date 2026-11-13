import type { ProviderTurnStopReason, ProviderTurnUsage } from '../shared/schema.js'

// 回合遥测：把 provider 已经在报、但此前被我们整个丢掉的两样东西读出来——
// 终态原因与上下文占用。两者都对齐 ACP v1 的语义（StopReason / UsageUpdate），
// 抽成纯函数模块而不是内联进 providers.ts 的 fold，是为了能被真实夹具直接钉住
// （pitfall #248：只有可导入的纯函数才测得动）。

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

// 只映射语义明确的取值。刻意不收 `tool_use`：result 级出现它是上游异常
// （pitfall #141 的空 tool_use 块），映射成 end_turn 会把那个 bug 盖掉。
const claudeStopReasons: Record<string, ProviderTurnStopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
}

// 轮次上限不在 stop_reason 里，它由 result 的 subtype 携带。
const claudeSubtypeStopReasons: Record<string, ProviderTurnStopReason> = {
  error_max_turns: 'max_turn_requests',
}

/**
 * 把 Claude `result` 事件的终态映射成 ACP 语义的回合停止原因。
 *
 * 认不出来就返回 undefined —— 编一个兜底值会让下游分不清「上游没给」和
 * 「上游真的是这个原因」，那正是这条链路此前最贵的信息损失。
 */
export const mapClaudeTurnStopReason = (
  event: Record<string, unknown>,
): ProviderTurnStopReason | undefined => {
  const subtype = typeof event.subtype === 'string' ? event.subtype : undefined
  if (subtype && claudeSubtypeStopReasons[subtype]) {
    return claudeSubtypeStopReasons[subtype]
  }

  const stopReason = typeof event.stop_reason === 'string' ? event.stop_reason : undefined
  if (stopReason && claudeStopReasons[stopReason]) {
    return claudeStopReasons[stopReason]
  }

  return undefined
}

// 上下文窗口来自 CLI 自报的 modelUsage[*].contextWindow。一个回合可能横跨多个
// 模型（子 agent 常用更便宜的档），此时取最大窗口：used 是各模型 token 之和，
// 配最大窗口会**低估**占用率。这个方向是刻意的——宁可少报警，也不要在多模型
// 回合里虚报"上下文快满了"把用户吓去做无谓的压缩。
const readContextWindow = (event: Record<string, unknown>): number | undefined => {
  const modelUsage = readRecord(event.modelUsage)
  if (!modelUsage) {
    return undefined
  }

  let largest: number | undefined
  for (const entry of Object.values(modelUsage)) {
    const window = readFiniteNumber(readRecord(entry)?.contextWindow)
    if (window !== undefined && (largest === undefined || window > largest)) {
      largest = window
    }
  }

  return largest
}

/**
 * 读出一个 Claude `result` 事件的上下文占用。
 *
 * used 把两类缓存也算进去：cache_read 与 cache_creation 都是**真实占着上下文窗口**
 * 的 token，只是计费不同。只加 input+output 会把一个 45k 的回合报成 7 token
 * （2026-08-16 实测夹具：3 + 4 + 45042 + 0）。
 */
export const readClaudeTurnUsage = (
  event: Record<string, unknown>,
): ProviderTurnUsage | undefined => {
  const usage = readRecord(event.usage)
  if (!usage) {
    return undefined
  }

  const inputTokens = readFiniteNumber(usage.input_tokens)
  const outputTokens = readFiniteNumber(usage.output_tokens)
  const cacheReadTokens = readFiniteNumber(usage.cache_read_input_tokens)
  const cacheCreationTokens = readFiniteNumber(usage.cache_creation_input_tokens)

  const used =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheCreationTokens ?? 0)

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined
  }

  return {
    used,
    size: readContextWindow(event),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: readFiniteNumber(event.total_cost_usd),
  }
}

// ---------------------------------------------------------------------------
// 上下文占用的实时信号（docs/specs/context-usage-auto-compact）
//
// 上面的 readClaudeTurnUsage 读的是 result.usage —— 一回合里**所有请求之和**
// （pitfall #322），带工具调用的回合会远超窗口大小，不能当「现在占了多少」。
// 占用要看最近一次主线程请求：它的输入侧就是此刻整段上下文。
// ---------------------------------------------------------------------------

/** Claude `result` 事件里 CLI 自报的上下文窗口（多模型时取最大）。 */
export const readClaudeContextWindow = (event: Record<string, unknown>): number | undefined =>
  readContextWindow(event)

/**
 * 读出一次 Claude **主线程**请求的上下文占用（输入侧含两类缓存 + 输出）。
 *
 * 2026-11-12 实测 CLI 2.1.233：
 * - `message_start` 的用量在 `event.message.usage`，请求一发出就有输入侧；
 * - `message_delta` 的用量在 `event.usage`（不是 `delta.usage`），是这次请求的最终值。
 *
 * 只认 `parent_tool_use_id` 为空的事件：子 Agent 有自己的窗口，算进来会让占用乱跳。
 * `message_delta` 没带任何输入侧字段时返回 undefined —— 否则 45k 的占用会被报成
 * 只有输出的几十个 token。
 */
export const readClaudeRequestContextUsage = (
  event: Record<string, unknown>,
): number | undefined => {
  if (event.type !== 'stream_event') {
    return undefined
  }

  if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) {
    return undefined
  }

  const streamEvent = readRecord(event.event)
  const usage =
    streamEvent?.type === 'message_start'
      ? readRecord(readRecord(streamEvent.message)?.usage)
      : streamEvent?.type === 'message_delta'
        ? readRecord(streamEvent.usage)
        : undefined

  if (!usage) {
    return undefined
  }

  const inputTokens = readFiniteNumber(usage.input_tokens)
  const cacheReadTokens = readFiniteNumber(usage.cache_read_input_tokens)
  const cacheCreationTokens = readFiniteNumber(usage.cache_creation_input_tokens)

  if (
    inputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined
  }

  return (
    (inputTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheCreationTokens ?? 0) +
    (readFiniteNumber(usage.output_tokens) ?? 0)
  )
}

export type ClaudeCompactBoundary = {
  trigger: 'manual' | 'auto'
  preTokens: number | undefined
}

/**
 * 识别 Claude 的 `system/compact_boundary`。
 *
 * 只实测到过 `trigger: "manual"`（用户发 `/compact`）。CLI 回合内自带的自动压缩
 * 没能在 `-p` 模式下触发出来，所以「不是 manual」一律按自动处理，不去猜具体字面量。
 * 刻意不返回 `post_tokens`：实测 891，而下一次请求真实输入侧 45261（它不含系统提示
 * 和工具定义），拿它当压缩后占用会骗人。
 */
export const readClaudeCompactBoundary = (
  event: Record<string, unknown>,
): ClaudeCompactBoundary | undefined => {
  if (event.type !== 'system' || event.subtype !== 'compact_boundary') {
    return undefined
  }

  const metadata = readRecord(event.compact_metadata)

  return {
    trigger: metadata?.trigger === 'manual' ? 'manual' : 'auto',
    preTokens: readFiniteNumber(metadata?.pre_tokens),
  }
}

export type CodexContextUsage = {
  threadId: string | undefined
  used: number
  size: number | undefined
}

/**
 * 读出 Codex `thread/tokenUsage/updated` 通知的占用。
 *
 * 取 `tokenUsage.last`（最近一次请求）而不是 `total`（整个线程累计，会越过窗口）。
 * 窗口取 `modelContextWindow`，协议里它可以是 null。
 */
export const readCodexContextUsage = (
  params: Record<string, unknown>,
): CodexContextUsage | undefined => {
  const tokenUsage = readRecord(params.tokenUsage)
  const used = readFiniteNumber(readRecord(tokenUsage?.last)?.totalTokens)

  if (used === undefined) {
    return undefined
  }

  return {
    threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    used,
    size: readFiniteNumber(tokenUsage?.modelContextWindow),
  }
}
