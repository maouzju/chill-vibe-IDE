import type {
  ChatMessage,
  ProviderTurnStopReason,
  ProviderTurnUsage,
  SessionUsageTotals,
} from './schema.js'

// 把回合遥测（终态原因 + 上下文占用）落盘。
//
// 为什么搭在 run-duration 消息上而不是新发一条：新增一种 system 消息就等于新增一条
// 渲染路径，而未知 kind 的空消息在这套转录里会渲染成空气泡（同族坑见 pitfall #169）。
// run-duration 每个逻辑回合结束时本来就产生一条，读它的地方（readRunDurationMs /
// MessageBubble）只认 kind + durationMs 两个键，多挂几个键对它们完全透明。
//
// 为什么不存进 card：那要动 chatCardSchema 与 normalizeAppSettings 的升级路径
// （pitfall #5/#6），而遥测是每回合一份的历史数据，本来就该跟着消息走。

export type TurnTelemetry = {
  turnStopReason?: ProviderTurnStopReason
  usage?: ProviderTurnUsage
  // 这一轮**实际生效**的模型与档位。切模型/档位在本仓库只是"下次请求带不同值"，
  // 没有任何协议事件，所以转录里此前无从追溯某一轮到底跑在什么配置下——
  // 排查「同样的问题为什么这次答得差」时缺的正是这个。
  model?: string
  reasoningEffort?: string
  thinkingEnabled?: boolean
  planMode?: boolean
}

const stopReasonKey = 'turnStopReason'
const modelKey = 'turnModel'
const reasoningEffortKey = 'turnReasoningEffort'
// 布尔存 '1'/'0' 而不是省略：false 与"这条老消息没记过"必须分得开，
// 否则一条 2026-08 以前的转录会被读成"用户关了思考"。
const thinkingEnabledKey = 'turnThinkingEnabled'
const planModeKey = 'turnPlanMode'

const readBooleanMeta = (meta: Record<string, string>, key: string): boolean | undefined => {
  const raw = meta[key]
  if (raw === undefined) {
    return undefined
  }
  return raw === '1'
}

// meta 是 Record<string, string>，所以每个数值字段各占一个键并显式还原类型。
// 刻意不 JSON.stringify 成一个键：那样会和 structuredData 走同一条截断逻辑
// （pitfall #180 的"截断出非法 JSON"），而这几个标量根本不需要冒那个险。
const usageKeys = {
  used: 'turnUsageUsed',
  size: 'turnUsageSize',
  inputTokens: 'turnUsageInput',
  outputTokens: 'turnUsageOutput',
  cacheReadTokens: 'turnUsageCacheRead',
  cacheCreationTokens: 'turnUsageCacheCreation',
  costUsd: 'turnUsageCostUsd',
} as const satisfies Record<keyof ProviderTurnUsage, string>

const readNumericMeta = (meta: Record<string, string>, key: string): number | undefined => {
  const raw = meta[key]
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 把遥测挂到一条已有消息的 meta 上，返回新消息。
 *
 * 没有任何可写字段时原样返回**同一个引用** —— 上层的记忆化按引用比较，
 * 无谓的新对象会白白打断它。
 */
export const attachTurnTelemetry = (
  message: ChatMessage,
  telemetry: TurnTelemetry,
): ChatMessage => {
  const additions: Record<string, string> = {}

  if (telemetry.turnStopReason) {
    additions[stopReasonKey] = telemetry.turnStopReason
  }

  const usage = telemetry.usage
  if (usage) {
    for (const [field, key] of Object.entries(usageKeys) as [
      keyof ProviderTurnUsage,
      string,
    ][]) {
      const value = usage[field]
      if (typeof value === 'number' && Number.isFinite(value)) {
        additions[key] = String(value)
      }
    }
  }

  if (telemetry.model?.trim()) {
    additions[modelKey] = telemetry.model.trim()
  }
  if (telemetry.reasoningEffort?.trim()) {
    additions[reasoningEffortKey] = telemetry.reasoningEffort.trim()
  }
  if (typeof telemetry.thinkingEnabled === 'boolean') {
    additions[thinkingEnabledKey] = telemetry.thinkingEnabled ? '1' : '0'
  }
  if (typeof telemetry.planMode === 'boolean') {
    additions[planModeKey] = telemetry.planMode ? '1' : '0'
  }

  if (Object.keys(additions).length === 0) {
    return message
  }

  return { ...message, meta: { ...message.meta, ...additions } }
}

/**
 * 读回一条消息上的回合遥测；没有就返回 null。
 *
 * 这是诊断入口：报「输出残缺 / 上下文被压掉 / 模型不干活」时，先来这里看
 * 那一轮到底是 end_turn 还是 max_tokens，以及当时上下文占了多少。
 */
export const readTurnTelemetry = (message: ChatMessage): TurnTelemetry | null => {
  const meta = message.meta
  if (!meta) {
    return null
  }

  const turnStopReason = meta[stopReasonKey] as ProviderTurnStopReason | undefined
  const used = readNumericMeta(meta, usageKeys.used)
  const model = meta[modelKey]
  const reasoningEffort = meta[reasoningEffortKey]
  const thinkingEnabled = readBooleanMeta(meta, thinkingEnabledKey)
  const planMode = readBooleanMeta(meta, planModeKey)

  if (
    !turnStopReason &&
    used === undefined &&
    model === undefined &&
    reasoningEffort === undefined &&
    thinkingEnabled === undefined &&
    planMode === undefined
  ) {
    return null
  }

  const telemetry: TurnTelemetry = {}
  if (turnStopReason) {
    telemetry.turnStopReason = turnStopReason
  }
  if (model !== undefined) {
    telemetry.model = model
  }
  if (reasoningEffort !== undefined) {
    telemetry.reasoningEffort = reasoningEffort
  }
  if (thinkingEnabled !== undefined) {
    telemetry.thinkingEnabled = thinkingEnabled
  }
  if (planMode !== undefined) {
    telemetry.planMode = planMode
  }
  if (used !== undefined) {
    telemetry.usage = {
      used,
      size: readNumericMeta(meta, usageKeys.size),
      inputTokens: readNumericMeta(meta, usageKeys.inputTokens),
      outputTokens: readNumericMeta(meta, usageKeys.outputTokens),
      cacheReadTokens: readNumericMeta(meta, usageKeys.cacheReadTokens),
      cacheCreationTokens: readNumericMeta(meta, usageKeys.cacheCreationTokens),
      costUsd: readNumericMeta(meta, usageKeys.costUsd),
    }
  }

  return telemetry
}

/**
 * 一段会话里的花费该怎么合并成一个数。
 *
 * 症状：统计卡的「费用」是真实值的好几倍——2026-08-16 实测用户归档里一段三轮会话，
 *   逐轮报 120.592 / 120.857 / 121.433 美元，求和算出 362.88，真实只花了 121.43。
 * 根因：`costUsd` 来自 Claude result 事件的 `total_cost_usd`，那是**会话累计**花费，
 *   每一轮都把前面所有轮再报一遍；token 计数（input/output/cache）反而是每轮各自的量。
 *   两者语义不同，却被同一个循环一视同仁地累加。
 * 为什么取最大值而不是最后一条：compact / 换 session 会把累计清零重来（同批数据里
 *   见过 15.83 → 7.87），取最后一条会让花费凭空缩水。取最大值在"单调递增"与
 *   "中途重置"两种形态下都不会低于任何一段已经确认花掉的钱。
 */
const mergeRunningCost = (
  current: { total: number; segment: number },
  reported: number | undefined,
) => {
  if (reported === undefined) return current
  // Claude reports a running total. A decrease means compact/session restart;
  // preserve the completed segment and start a new one from the reset value.
  if (reported < current.segment) {
    return { total: current.total + current.segment, segment: reported }
  }
  return { total: current.total, segment: Math.max(current.segment, reported) }
}

/**
 * 把一串消息里的回合用量汇总成一份与消息条数无关的定长记录。
 *
 * 归档一张卡时调用（见 shared/default-state.ts），因为消息的 `meta` 只在那一刻还完整；
 * 没有任何一轮报过用量就返回 null，让「真的没有数据」与「全是 0」保持可分辨。
 */
export const summarizeTurnUsage = (messages: readonly ChatMessage[]): SessionUsageTotals | null => {
  const totals: SessionUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    turns: 0,
    peakUsed: 0,
    peakSize: 0,
    costUsd: 0,
  }
  let runningCost = { total: 0, segment: 0 }

  for (const message of messages) {
    const usage = readTurnTelemetry(message)?.usage
    if (!usage) {
      continue
    }

    totals.turns += 1
    totals.input += usage.inputTokens ?? 0
    totals.output += usage.outputTokens ?? 0
    totals.cacheRead += usage.cacheReadTokens ?? 0
    totals.cacheCreation += usage.cacheCreationTokens ?? 0
    runningCost = mergeRunningCost(runningCost, usage.costUsd)
    totals.costUsd = runningCost.total + runningCost.segment

    if (usage.used > totals.peakUsed) {
      totals.peakUsed = usage.used
      totals.peakSize = usage.size ?? 0
    }
  }

  return totals.turns > 0 ? totals : null
}
