import type { ChatMessage, ProviderTurnStopReason, ProviderTurnUsage } from '../shared/schema'

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
