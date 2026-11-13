import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage, ChatMessage, Provider, StreamContextUsageEvent } from '../../shared/schema'
import {
  getPendingCompactBoundaryMessage,
  isCompactBoundaryMessage,
  isCompactBoundaryPending,
  settlePendingCompactBoundary,
} from './chat-card-compaction'
import type { SendMessageOrigin } from './deferred-send-queue'

// 上下文占用的渲染端纯逻辑（docs/specs/context-usage-auto-compact）。
//
// 数字只有一个来源：CLI 自己报的数。占用 = 最近一次主线程请求的输入侧 + 输出，窗口 = CLI 报的
// contextWindow。不维护模型窗口表、不估算（pitfall #293）；不知道就是不知道，界面不显示、
// 自动压缩也不触发。

export type ContextUsageSnapshot = {
  /** 当前占用（token）。压缩之后、下一次真实请求之前是未知。 */
  used?: number
  /** 模型的上下文窗口（token）。 */
  size?: number
  /**
   * 最近一次压缩之后的第一次真实占用，用来判断「压完又长回来了多少」。
   * App 替用户发起的压缩没压成时，记的是当时的占用（markAutoCompactNotCompleted）。
   */
  baselineUsed?: number
  /** 刚压缩过：下一次真实占用要记成基线。 */
  awaitingBaseline?: true
}

/** 「明确什么都不知道」。和「store 里没有这张卡」不是一回事，后者会回落到落盘值。 */
export const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = Object.freeze({})

export type ContextUsageLevel = 'normal' | 'warning' | 'danger'

/** 只有 Claude / Codex 的 CLI 报占用，也只有它们有 /compact。 */
export const supportsContextUsage = (provider: Provider) => provider === 'claude' || provider === 'codex'

const isValidTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * 把一条 context_usage 事件并进快照。没有变化时返回原对象，订阅方靠引用相等跳过重渲染。
 *
 * 顺序固定为「先 reset、再 used / size」：服务端 backlog 会把一个回合里的多条事件折成一条
 * （shared/context-usage.ts），折出来的事件可能同时带 reset 和压缩之后的新占用。
 */
export const reduceContextUsage = (
  previous: ContextUsageSnapshot | undefined,
  event: StreamContextUsageEvent,
): ContextUsageSnapshot => {
  const base = previous ?? EMPTY_CONTEXT_USAGE
  let used = base.used
  let size = base.size
  let baselineUsed = base.baselineUsed
  let awaitingBaseline = base.awaitingBaseline === true

  if (event.reset === true) {
    used = undefined
    baselineUsed = undefined
    awaitingBaseline = true
  }

  if (isValidTokenCount(event.used)) {
    used = event.used

    if (awaitingBaseline) {
      baselineUsed = event.used
      awaitingBaseline = false
    }
  }

  if (isValidTokenCount(event.size) && event.size > 0) {
    size = event.size
  }

  if (
    used === base.used &&
    size === base.size &&
    baselineUsed === base.baselineUsed &&
    awaitingBaseline === (base.awaitingBaseline === true)
  ) {
    return base
  }

  return {
    ...(used !== undefined ? { used } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(baselineUsed !== undefined ? { baselineUsed } : {}),
    ...(awaitingBaseline ? { awaitingBaseline: true as const } : {}),
  }
}

/** 占用百分比（0–100）。占用或窗口有一个不知道就没有百分比。 */
export const getContextUsagePercent = (snapshot: ContextUsageSnapshot | undefined): number | undefined => {
  if (!snapshot || snapshot.used === undefined || snapshot.size === undefined || snapshot.size <= 0) {
    return undefined
  }

  // 先乘后除：占用恰好等于阈值时得到的是整数（57%，不是 56.99999999999999%），
  // 颜色档位、显示的数字和 shouldAutoCompactBeforeSend 的整数比较才对得上。
  return Math.min(100, Math.max(0, (snapshot.used * 100) / snapshot.size))
}

/**
 * 指示器的三档颜色跟着「自动压缩阈值」走：到阈值的 7/8 开始提醒，到阈值就是危险色。
 * 用户把阈值调到 60%，55% 就该有提醒，所以不写死 70 / 80。
 */
export const getContextUsageLevel = (
  percent: number | undefined,
  thresholdPercent: number,
): ContextUsageLevel => {
  if (percent === undefined) {
    return 'normal'
  }

  if (percent >= thresholdPercent) {
    return 'danger'
  }

  return percent >= (thresholdPercent * 7) / 8 ? 'warning' : 'normal'
}

/** 44289 → `44.3k`，200000 → `200k`，1048576 → `1.05M`。 */
export const formatTokenCount = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }

  const rounded = Math.round(value)

  if (rounded < 1000) {
    return String(rounded)
  }

  const thousands = Number((rounded / 1000).toFixed(1))

  if (thousands < 1000) {
    return `${thousands}k`
  }

  return `${Number((rounded / 1_000_000).toFixed(2))}M`
}

export type ContextUsageDisplay = {
  /** 圆环旁边的字：知道窗口时是百分比，否则是已用的 token 数。 */
  valueLabel: string
  /** 0–100，画圆环用；不知道窗口时没有。 */
  percent?: number
  level: ContextUsageLevel
  /** 一句话说明（读屏用）。 */
  summary: string
  /** 悬停提示：说明，外加自动压缩会在什么时候发生。 */
  tooltip: string
}

/**
 * 指示器上该显示什么。没有占用数字时返回 undefined（什么都不显示）。
 *
 * 百分比向下取整：显示的数字一到阈值，下一次发送就真的会先压缩。四舍五入会让 79.6%
 * 提前显示成 80%，用户看着「到了」却等不到说好的压缩。
 */
export const describeContextUsage = ({
  snapshot,
  language,
  autoCompactEnabled,
  autoCompactThresholdPercent,
}: {
  snapshot: ContextUsageSnapshot | undefined
  language: AppLanguage
  autoCompactEnabled: boolean
  autoCompactThresholdPercent: number | undefined
}): ContextUsageDisplay | undefined => {
  const used = snapshot?.used

  if (used === undefined) {
    return undefined
  }

  const text = getLocaleText(language)
  const usedLabel = formatTokenCount(used)
  const percent = getContextUsagePercent(snapshot)

  if (percent === undefined || snapshot?.size === undefined) {
    const summary = text.contextUsageSummaryUnknownWindow(usedLabel)

    return { valueLabel: usedLabel, level: 'normal', summary, tooltip: summary }
  }

  const shownPercent = Math.floor(percent)
  const summary = text.contextUsageSummary(usedLabel, formatTokenCount(snapshot.size), shownPercent)

  return {
    valueLabel: `${shownPercent}%`,
    percent,
    level:
      autoCompactThresholdPercent === undefined
        ? 'normal'
        : getContextUsageLevel(percent, autoCompactThresholdPercent),
    summary,
    tooltip:
      autoCompactEnabled && autoCompactThresholdPercent !== undefined
        ? text.contextUsageAutoCompactHint(summary, autoCompactThresholdPercent)
        : summary,
  }
}

// ---------------------------------------------------------------------------
// 落盘：挂在回合末尾那条消息的 meta 上
// ---------------------------------------------------------------------------
//
// meta 是 Record<string, string>，每个数各占一个键（pitfall #180：别 JSON.stringify 成一个键）。
// 不新增消息 kind：未知 kind 的空消息会渲染成一个空气泡（pitfall #169）。

const usedMetaKey = 'contextUsageUsed'
const sizeMetaKey = 'contextUsageSize'
const baselineMetaKey = 'contextUsageBaseline'
const awaitingBaselineMetaKey = 'contextUsageAwaitingBaseline'
const providerMetaKey = 'contextUsageProvider'

const readTokenMeta = (meta: Record<string, string> | undefined, key: string): number | undefined => {
  const raw = meta?.[key]

  if (raw === undefined || raw.trim() === '') {
    return undefined
  }

  const value = Number(raw)
  return isValidTokenCount(value) ? value : undefined
}

const hasContextUsageMeta = (meta: Record<string, string> | undefined): meta is Record<string, string> =>
  meta !== undefined &&
  (usedMetaKey in meta || sizeMetaKey in meta || baselineMetaKey in meta || awaitingBaselineMetaKey in meta)

const contextUsageMetaKeys = [
  usedMetaKey,
  sizeMetaKey,
  baselineMetaKey,
  awaitingBaselineMetaKey,
  providerMetaKey,
] as const

/**
 * 把快照记到消息上。快照里什么都不知道时原样返回消息，不留空记录。
 *
 * 消息上已有的记录是整份换掉、不是逐键合并：没有 run-duration 消息可挂的回合会把占用记到
 * 「最后一条消息」上（settleRunEndMessages），那条消息可能还带着上一回合的记录。逐键合并的话，
 * 压缩之后的 `{ size, awaitingBaseline }` 会和压缩之前留下的 used / baseline 混在一起，
 * 读回来就是「已经压过，但还是快满的」。
 * 记的内容和已有的一样时原样返回，调用方靠引用相等省掉一次多余的更新。
 */
export const attachContextUsageMeta = (
  message: ChatMessage,
  snapshot: ContextUsageSnapshot | undefined,
  provider: Provider,
): ChatMessage => {
  if (!snapshot) {
    return message
  }

  const additions: Record<string, string> = {}

  if (snapshot.used !== undefined) {
    additions[usedMetaKey] = String(snapshot.used)
  }

  if (snapshot.size !== undefined) {
    additions[sizeMetaKey] = String(snapshot.size)
  }

  if (snapshot.baselineUsed !== undefined) {
    additions[baselineMetaKey] = String(snapshot.baselineUsed)
  }

  if (snapshot.awaitingBaseline) {
    additions[awaitingBaselineMetaKey] = 'true'
  }

  if (Object.keys(additions).length === 0) {
    return message
  }

  additions[providerMetaKey] = provider

  const previousMeta = message.meta

  if (previousMeta && contextUsageMetaKeys.every((key) => previousMeta[key] === additions[key])) {
    return message
  }

  const keptMeta = Object.fromEntries(
    Object.entries(previousMeta ?? {}).filter(
      ([key]) => !(contextUsageMetaKeys as readonly string[]).includes(key),
    ),
  )

  return { ...message, meta: { ...keptMeta, ...additions } }
}

/**
 * 从对话历史里读回最近一次记下的占用（应用重启后、以及回合之间都靠它）。
 *
 * 从后往前找：
 * - 先遇到一条占用记录 → 就是它；
 * - 先遇到压缩边界 → 边界之前的占用已经作废，只沿用更早记下的窗口大小，并标记「等基线」；
 * - 还挂着（pending）的边界不算边界，见循环里的说明；
 * - 记录是另一个 provider 留下的（卡片换过 provider 且保留了历史）→ 不认。
 *
 * 症状（不这么做会怎样）：压缩回合如果没留下自己的记录，重启后指示器会显示压缩前的
 * 「快满了」，下一条消息又白白压一遍。
 */
export const readPersistedContextUsage = (
  messages: readonly ChatMessage[],
  provider: Provider,
): ContextUsageSnapshot | undefined => {
  let compacted = false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const meta = message.meta

    if (hasContextUsageMeta(meta)) {
      const recordedProvider = meta[providerMetaKey]

      if (recordedProvider !== undefined && recordedProvider !== provider) {
        return compacted ? { awaitingBaseline: true } : undefined
      }

      const size = readTokenMeta(meta, sizeMetaKey)

      if (compacted) {
        return { ...(size !== undefined ? { size } : {}), awaitingBaseline: true }
      }

      const used = readTokenMeta(meta, usedMetaKey)
      const baselineUsed = readTokenMeta(meta, baselineMetaKey)
      const awaitingBaseline = meta[awaitingBaselineMetaKey] === 'true'

      if (used === undefined && size === undefined && baselineUsed === undefined && !awaitingBaseline) {
        return undefined
      }

      return {
        ...(used !== undefined ? { used } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(baselineUsed !== undefined ? { baselineUsed } : {}),
        ...(awaitingBaseline ? { awaitingBaseline: true as const } : {}),
      }
    }

    // 症状（要防的）：压缩回合进行中应用退出，重启后在「中断会话」提示里点了「不恢复」，那条
    //   /compact 就一直挂着。把它当成压过的话：指示器消失、下一条消息不先压缩，而且下一回合的
    //   第一次真实占用（其实还是快满的）会被记成「压缩后基线」落盘，之后要再涨窗口的 10% 才会再压。
    // 根因（2026-11-12 独立审查）：挂着只说明「发起过」，压没压成要等回合收尾才定
    //   （settlePendingCompactBoundary）；收尾没跑到的话，CLI 那边多半一个字都没少。
    // 被否决的替代方案：在关掉「中断会话」提示、停止请求发不出去这些地方逐个清掉挂着的标记——
    //   这样的出口不止一处，漏一处就是一张再也不自动压缩的卡。
    if (
      !compacted &&
      isCompactBoundaryMessage(message, provider) &&
      !isCompactBoundaryPending(message)
    ) {
      compacted = true
    }
  }

  return compacted ? { awaitingBaseline: true } : undefined
}

// ---------------------------------------------------------------------------
// 发送前要不要先压缩
// ---------------------------------------------------------------------------

/** 压缩之后至少要再涨回「窗口的这么多」才会再次自动压缩。 */
export const AUTO_COMPACT_MIN_REGROWTH_PERCENT = 10

export type AutoCompactDecisionInput = {
  /** 设置里的开关。 */
  enabled: boolean
  /** 设置里的阈值（占窗口的百分比）。 */
  thresholdPercent: number
  provider: Provider
  origin: SendMessageOrigin
  /** 这次发送会接着已有的 CLI 会话聊（有会话 id，且不是带着历史另开新会话）。 */
  hasResumableSession: boolean
  hasSendContent: boolean
  isSlashCommand: boolean
  /** 工具卡（Git、文件树等）没有对话上下文。 */
  isToolCard: boolean
  providerUnavailable: boolean
  /**
   * 这条消息是在回答上一轮的提问 / 计划审批。回答必须紧跟在提问后面：
   * 中间插一条 /compact 的 user 消息，计划审批就认不出这是在回答它，计划模式退不出去。
   */
  answersAskUser: boolean
  /** 上一次发送就是自动压缩（现在这条正是当时被排队的用户消息）。 */
  recentlyAttempted: boolean
  usage: ContextUsageSnapshot | undefined
}

/**
 * 用户发消息之前，要不要先替他发一条 /compact。
 *
 * 症状：会话聊到窗口快满时，CLI 要么在回合中途自己压缩（用户看着它卡半天、不知道在干嘛），
 * 要么直接报上下文超限、这一回合白跑。
 *
 * 根因（2026-11-12 实测 Claude CLI 2.1.233）：`-p` 模式下 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 * 不生效，没法让 CLI 提前压；Chill Vibe 自己的 shouldAutoCompactCodexConversation 写死 false。
 * 所以只能在回合边界、由 App 自己先发 /compact，再把用户那条消息排在后面。
 *
 * 被否决的替代方案：
 * - 回合跑完后立刻压缩：用户可能就此不聊了，白花一次请求；而且「一轮跑完之后自动做点什么」
 *   挂在渲染层很容易在卡片不可见时丢掉（pitfall #351）。
 * - 按字数估算占用：不同模型、缓存、工具定义都算不准（pitfall #293），压早了丢上下文。
 *
 * 防连环有两道：`recentlyAttempted`（压完紧接着那次发送不再压），以及基线（压完之后的第一次
 * 真实占用）——压不下去的会话（系统提示 + 工具定义本身就超阈值）不会每条消息都压一遍。
 */
export const shouldAutoCompactBeforeSend = (input: AutoCompactDecisionInput): boolean => {
  if (!input.enabled || input.origin !== 'user' || !supportsContextUsage(input.provider)) {
    return false
  }

  if (
    !input.hasResumableSession ||
    !input.hasSendContent ||
    input.isSlashCommand ||
    input.isToolCard ||
    input.providerUnavailable ||
    input.answersAskUser ||
    input.recentlyAttempted
  ) {
    return false
  }

  const { used, size, baselineUsed } = input.usage ?? EMPTY_CONTEXT_USAGE

  if (used === undefined || size === undefined || size <= 0) {
    return false
  }

  // 全程整数乘法比较，不让 160000 / 200000 * 100 这种浮点误差卡在阈值边上。
  if (used * 100 < input.thresholdPercent * size) {
    return false
  }

  if (
    baselineUsed !== undefined &&
    (used - baselineUsed) * 100 < size * AUTO_COMPACT_MIN_REGROWTH_PERCENT
  ) {
    return false
  }

  return true
}

/**
 * App 替用户发起的那次压缩没压成（失败、被停止、或者「正常结束」了但 CLI 没报过压缩）：
 * 落盘前把「现在的占用」记成基线。于是规则只有一条——一次自动压缩尝试之后，不管成没成，
 * 都要等占用再涨回窗口的 AUTO_COMPACT_MIN_REGROWTH_PERCENT 才会再试。
 *
 * 症状（不这么做会怎样）：压缩一直失败的环境里（中转站不认 /compact、网络时好时坏），
 *   每隔一条用户消息就白压一次——多等一会、多一行「没压成」的说明，上下文却一个字没少。
 * 根因：`recentlyAttempted` 只拦得住紧接着的那一次发送；压成功时基线由 CLI 的 reset 带出来，
 *   没压成时没有任何东西更新基线。
 * 被否决的替代方案：另开一个运行期的「连续失败次数」——应用重启就丢，而且要在停止、换会话、
 *   关卡片等每个清理点都记得清掉；基线跟着对话落盘，这些场景天然都对。
 *
 * 占用未知时原样返回（没有可记的东西，也就不会触发下一次自动压缩）。
 */
export const markAutoCompactNotCompleted = (
  snapshot: ContextUsageSnapshot | undefined,
): ContextUsageSnapshot | undefined => {
  if (!snapshot || snapshot.used === undefined) {
    return snapshot
  }

  return {
    used: snapshot.used,
    ...(snapshot.size !== undefined ? { size: snapshot.size } : {}),
    baselineUsed: snapshot.used,
  }
}

const AUTO_COMPACT_FAILURE_DETAIL_MAX_LENGTH = 200

/**
 * 「自动压缩没有完成」那行说明后面括号里的原因：折成一行、截到一个上限；没有内容就不带括号。
 *
 * CLI / 中转站的报错常常是多行的，甚至是一整页 HTML 错误页；原样塞进去，一行本该不起眼的
 * 说明会把对话刷屏。用户要看的只是「大概为什么没压成」，完整报错对一次顺手的压缩没有价值。
 */
export const summarizeAutoCompactFailureDetail = (detail: string | undefined): string | undefined => {
  const singleLine = detail?.replace(/\s+/g, ' ').trim()

  if (!singleLine) {
    return undefined
  }

  return singleLine.length > AUTO_COMPACT_FAILURE_DETAIL_MAX_LENGTH
    ? `${singleLine.slice(0, AUTO_COMPACT_FAILURE_DETAIL_MAX_LENGTH)}…`
    : singleLine
}

// ---------------------------------------------------------------------------
// 回合收尾
// ---------------------------------------------------------------------------

/**
 * 回合收尾时要改哪几条**已有的**消息：把挂着的压缩边界定下来，把占用记到最后一条消息上。
 * 返回值直接交给 reducer 的 upsertMessages；没有要改的就是空数组。
 *
 * 症状（没有它会怎样）：
 * - 后台任务 / 定时唤醒还挂着的回合不出 run-duration 消息，占用就没地方记。带后台任务的长会话
 *   每一轮都这样收尾：指示器停在很久以前的数上，发送前的自动压缩永远等不到阈值。
 * - 收尾的出口有好几个（done、出错、等不到服务端确认的停止、发送失败），各写各的很容易漏掉
 *   「App 发起的压缩没压成 → 撤销边界」这一步，漏了就是更早的历史被白白折叠。
 * 根因（2026-11-12 读 src/app-helpers.ts 的 getStreamDonePlan）：Stop 钩子只要还有后台任务或
 *   定时器就判成 background-pending，这种回合不算逻辑上跑完，耗时消息留到真正跑完才出。
 * 被否决的替代方案：
 * - 给 background-pending 的回合也发一条 run-duration 消息：一个逻辑回合会冒出好几行耗时，
 *   遥测也跟着被拆成几份。
 * - 另加一条专门记占用的消息：未知 kind 的空消息会渲染成空气泡（pitfall #169）。
 *
 * 调用方注意：
 * - 这一回合有 run-duration 消息时占用挂在那条消息上，`usage` 传 undefined。
 * - upsertMessages 要排在 finishStoppedStream 之前：它是整条替换，排在后面会用这里拿到的旧副本
 *   盖掉 reducer 刚收敛过的命令卡 / 子代理状态。
 */
export const settleRunEndMessages = ({
  messages,
  provider,
  boundary,
  usage,
}: {
  messages: ChatMessage[]
  provider: Provider
  /** 这次收尾要不要把挂着的边界定下来；回合还不算跑完（后台任务还挂着的普通回合）就传 undefined。 */
  boundary: { stopped: boolean; compactionObserved: boolean } | undefined
  /** 要记到最后一条消息上的占用。 */
  usage: ContextUsageSnapshot | undefined
}): ChatMessage[] => {
  const updates = new Map<string, ChatMessage>()
  const pendingBoundary = boundary ? getPendingCompactBoundaryMessage(messages) : null

  if (pendingBoundary && boundary) {
    updates.set(pendingBoundary.id, settlePendingCompactBoundary(pendingBoundary, boundary))
  }

  const lastMessage = messages.at(-1)

  if (lastMessage && usage) {
    // 最后一条正好是那条边界时，两处改动要落在同一份副本上。
    const base = updates.get(lastMessage.id) ?? lastMessage
    const recorded = attachContextUsageMeta(base, usage, provider)

    if (recorded !== base) {
      updates.set(lastMessage.id, recorded)
    }
  }

  return [...updates.values()]
}
