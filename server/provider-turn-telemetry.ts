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
