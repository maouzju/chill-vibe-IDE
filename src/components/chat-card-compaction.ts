import { parseSlashCommandInput } from '../../shared/slash-commands'
import type { CardStatus, ChatMessage, Provider } from '../../shared/schema'

export type CompactWindowHiddenReason = 'compact' | 'performance'
export type CompactTrigger = 'manual' | 'auto'

export type CompactMessageWindow = {
  hiddenMessageCount: number
  compactMessageId: string | null
  hiddenReason: CompactWindowHiddenReason | null
  compactTrigger: CompactTrigger | null
  visibleMessages: ChatMessage[]
}

type CompactMessageWindowOptions = {
  revealedHiddenMessageCount?: number
  allowPerformanceWindowing?: boolean
  archivedHiddenMessageCount?: number
}

type MergeCompactedHistoryOptions = {
  allowUnanchoredArchive?: boolean
}

const compactBoundaryMetaKey = 'compactBoundary'
const compactTriggerMetaKey = 'compactTrigger'
const compactHiddenMetaKey = 'compactHidden'
const compactPendingMetaKey = 'compactPending'
const compactRunStreamMetaKey = 'compactRunStreamId'
const performanceWindowThreshold = 1200
const performanceVisibleMessageCount = 360
const contentPerformanceWindowThresholdChars = 2_000_000
const contentPerformanceVisibleChars = 900_000
const contentPerformanceMinimumMessageCount = 160
const structuredPerformanceWindowThreshold = 300
const structuredPerformanceVisibleMessageCount = 160
const structuredPerformanceScanCount = 96
const structuredPerformanceActivationCount = 36

const isStructuredPerformanceMessage = (message: ChatMessage) => {
  switch (message.meta?.kind) {
    case 'command':
    case 'tool':
    case 'edits':
    case 'reasoning':
    case 'todo':
    case 'agents':
      return true
    default:
      return false
  }
}

const shouldUseStructuredPerformanceWindow = (messages: ChatMessage[]) => {
  let structuredCount = 0

  for (const message of messages.slice(-structuredPerformanceScanCount)) {
    if (isStructuredPerformanceMessage(message)) {
      structuredCount += 1
    }
  }

  return structuredCount >= structuredPerformanceActivationCount
}

const getPerformanceWindowConfig = (messages: ChatMessage[]) =>
  shouldUseStructuredPerformanceWindow(messages)
    ? {
        threshold: structuredPerformanceWindowThreshold,
        visibleCount: structuredPerformanceVisibleMessageCount,
      }
    : {
        threshold: performanceWindowThreshold,
        visibleCount: performanceVisibleMessageCount,
      }

const isCompactCommandMessage = (message: ChatMessage) =>
  message.role === 'user' && parseSlashCommandInput(message.content)?.name === 'compact'

const hasExplicitCompactBoundary = (message: ChatMessage) =>
  message.role === 'user' && message.meta?.[compactBoundaryMetaKey] === 'true'

/** 这条边界还挂着：压缩回合没收尾，压没压成还没定（见 settlePendingCompactBoundary）。 */
export const isCompactBoundaryPending = (message: ChatMessage) =>
  hasExplicitCompactBoundary(message) && message.meta?.[compactPendingMetaKey] === 'true'

/** 这条 /compact 是 App 自己发起的自动压缩（markAppAutoCompactRun 留下的记号）。 */
const isAppAutoCompactMessage = (message: ChatMessage) => {
  const runStreamId = message.meta?.[compactRunStreamMetaKey]
  return typeof runStreamId === 'string' && runStreamId.length > 0
}

export const getCompactBoundaryTrigger = (
  message: ChatMessage | undefined,
  provider: Provider,
): CompactTrigger | null => {
  if (!message) {
    return null
  }

  if (hasExplicitCompactBoundary(message)) {
    return message.meta?.[compactTriggerMetaKey] === 'auto' ? 'auto' : 'manual'
  }

  // 症状：App 替用户发起的自动压缩被停止 / 失败之后，更早的历史照样被折叠，上下文占用
  // 变成「未知」，带着历史另开会话时边界之前的内容也被丢掉——可 CLI 那边根本没压缩过。
  // 根因（2026-11-12）：Claude 的 /compact 是靠消息内容认的，clearPendingCompactBoundaryMessage
  // 清掉了显式标记，下面这条内容规则又把它认回了手动边界。
  // 所以带着「由哪个回合发起」记号、却已经没有显式标记的 /compact，就是一次没发生的压缩。
  // 被否决的替代方案：失败时把那条消息从历史里删掉——state 没有删除单条消息的 action，
  // 为此新增一个高风险的 reducer 分支不值得。
  if (isAppAutoCompactMessage(message)) {
    return null
  }

  return provider === 'claude' && isCompactCommandMessage(message) ? 'manual' : null
}

export const isHiddenCompactBoundaryMessage = (message: ChatMessage) =>
  message.role === 'user' && message.meta?.[compactHiddenMetaKey] === 'true'

export const getPendingCompactBoundaryMessage = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && isCompactBoundaryPending(message)) {
      return message
    }
  }

  return null
}

const replaceCompactBoundaryMeta = (
  message: ChatMessage,
  patch: Partial<Record<typeof compactBoundaryMetaKey | typeof compactTriggerMetaKey | typeof compactHiddenMetaKey | typeof compactPendingMetaKey, string>>,
) => {
  const nextMetaEntries = Object.entries({
    ...(message.meta ?? {}),
    ...patch,
  }).filter(([, value]) => typeof value === 'string' && value.length > 0)

  return {
    ...message,
    meta: nextMetaEntries.length > 0 ? Object.fromEntries(nextMetaEntries) : undefined,
  }
}

export const finalizePendingCompactBoundaryMessage = (message: ChatMessage): ChatMessage => {
  if (!isCompactBoundaryPending(message)) {
    return message
  }

  return replaceCompactBoundaryMeta(message, {
    [compactPendingMetaKey]: '',
  })
}

export const clearPendingCompactBoundaryMessage = (message: ChatMessage): ChatMessage => {
  if (!isCompactBoundaryPending(message)) {
    return message
  }

  return replaceCompactBoundaryMeta(message, {
    [compactBoundaryMetaKey]: '',
    [compactTriggerMetaKey]: '',
    [compactPendingMetaKey]: '',
  })
}

/**
 * 回合收尾时，还挂着（pending）的压缩边界是生效还是撤销。
 *
 * - 用户自己敲的 /compact：照旧，没被停止就生效。
 * - App 自己发起的压缩：只有 CLI 确实报告过压缩完成才生效，和停没停无关。
 *
 * 症状（要防的）：自动压缩的回合「正常结束」了，但其实没压成（/compact 被当成普通文本
 *   回答了，或者压缩请求被上游拒了却没报错）。边界一旦生效，更早的历史就被折叠、带着历史
 *   另开会话时也被截掉，而 CLI 那边的上下文一个字都没少。
 * 根因（2026-11-12）：Claude 的手动 /compact 不发 compaction 活动（server/providers.ts：
 *   渲染端已经为用户敲的那条建了边界，再发会重复）。App 的自动压缩在 CLI 眼里就是一次手动
 *   /compact，所以回合中途没有任何东西会把它的 pending 边界 finalize，只能在收尾时凭
 *   「CLI 报没报过压缩」（context_usage 的 reset）来定。
 * 被否决的替代方案：和手动的一样「没被停止就生效」——压没压成全靠猜，猜错就丢历史。
 */
export const settlePendingCompactBoundary = (
  message: ChatMessage,
  { stopped, compactionObserved }: { stopped: boolean; compactionObserved: boolean },
): ChatMessage => {
  const takesEffect = isAppAutoCompactMessage(message) ? compactionObserved : !stopped

  return takesEffect
    ? finalizePendingCompactBoundaryMessage(message)
    : clearPendingCompactBoundaryMessage(message)
}

export const markCompactBoundaryMessage = (
  message: ChatMessage,
  options?: {
    trigger?: CompactTrigger
    hidden?: boolean
    pending?: boolean
  },
): ChatMessage => {
  if (!isCompactCommandMessage(message) || hasExplicitCompactBoundary(message)) {
    return message
  }

  const trigger = options?.trigger ?? 'manual'

  return {
    ...message,
    meta: {
      ...message.meta,
      [compactBoundaryMetaKey]: 'true',
      [compactTriggerMetaKey]: trigger,
      ...(options?.hidden ? { [compactHiddenMetaKey]: 'true' } : {}),
      ...(options?.pending ? { [compactPendingMetaKey]: 'true' } : {}),
    },
  }
}

export const isCompactBoundaryMessage = (
  message: ChatMessage | undefined,
  provider: Provider,
) => {
  return getCompactBoundaryTrigger(message, provider) !== null
}

/**
 * 给「App 自己在发送前发起的那次压缩」的边界消息记上它是哪个回合跑的
 * （docs/specs/context-usage-auto-compact）。
 *
 * 这种压缩整个回合就只干压缩这一件事，和「回合中途 CLI 自己压了一下」不同：
 * 它要拦住后面的消息（见 shouldWaitForCompactionBeforeSending），收尾时也不该
 * 响提示音、不该触发续跑。两处都靠这个回合 id 认它。
 */
export const markAppAutoCompactRun = (message: ChatMessage, streamId: string): ChatMessage => {
  if (!hasExplicitCompactBoundary(message) || streamId.length === 0) {
    return message
  }

  return {
    ...message,
    meta: {
      ...message.meta,
      [compactRunStreamMetaKey]: streamId,
    },
  }
}

/**
 * 这条消息是不是 `streamId` 这个回合里 App 自己发起的压缩。
 * 不要求它此刻仍是边界：压缩没成时边界会被清掉标记，但回合收尾还要认得它。
 */
export const isAppAutoCompactRun = (
  message: ChatMessage | undefined,
  streamId: string | undefined,
) =>
  typeof streamId === 'string' &&
  streamId.length > 0 &&
  message?.meta?.[compactRunStreamMetaKey] === streamId

/**
 * 卡片上 `streamId` 这个回合是不是 App 自己发起的压缩：看最新一条 user 消息。
 * 回合收尾的每个出口（done、出错、等不到服务端确认的停止）都先问它，口径只此一处。
 *
 * 只看最新一条：压缩回合里不会再有别的 user 消息；后面一旦有了新的 user 消息，
 * 就说明那次压缩早就收尾了。
 */
export const isAppAutoCompactRunOnCard = (
  messages: readonly ChatMessage[] | undefined,
  streamId: string | undefined,
) => isAppAutoCompactRun(messages?.findLast((message) => message.role === 'user'), streamId)

/**
 * 正在回答的卡上收到普通 follow-up 时，要不要先等这次压缩结束再发。
 *
 * 症状：2026-08-16 用户报"一个会话 streaming 久了之后再给他输入消息，居然自动
 *   变成延后消息"。
 * 根因：自动压缩会往消息流里塞一条隐藏的 `/compact` user 消息
 *   （createAutoCompactionBoundaryMessage）。它此后一直是 latest user message，
 *   而旧判据用的是 `isCompactBoundaryMessage`——不分手动/自动，于是整轮 streaming
 *   里每一次普通左键发送都被判成"要等压缩"，只入 FIFO 队列、不打断，一直挂到
 *   本轮结束。会话越长越容易触发自动压缩，也就越像"streaming 久了就发不出去"。
 * 被否决：改看 `compactPending` 标记 —— 只有 Codex 的手动 `/compact` 会打这个标，
 *   Claude 的手动 `/compact` 靠消息内容识别、从来没有 pending，换过去会把
 *   "用户自己发了 /compact 紧接着追加一句"这个原始需求（deferred-send-queue
 *   需求 8）一起弄丢。
 *
 * 2026-11-12 补充：App 在发送前自己发起的压缩（markAppAutoCompactRun）也要等——
 *   用户那条消息本来就排在它后面，途中再追加的消息如果把压缩打断，等于白压。
 *   但它的边界同样是「隐藏的自动边界」，为了不重蹈上面的覆辙，只在
 *   `activeStreamId` 正是它自己那个回合时才算数；回合一结束就失效。
 * 被否决：另开一个运行期 ref 记「正在自动压缩的卡」—— 停止、报错、重试、换会话
 *   等清理点有八处以上，漏一处就是一张再也发不出消息的卡。
 */
export const shouldWaitForCompactionBeforeSending = (
  latestUserMessage: ChatMessage | undefined,
  provider: Provider,
  activeStreamId?: string,
) =>
  getCompactBoundaryTrigger(latestUserMessage, provider) === 'manual' ||
  isAppAutoCompactRun(latestUserMessage, activeStreamId)

const findLatestCompactBoundary = (
  messages: ChatMessage[],
  provider: Provider,
  status: CardStatus,
) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      !message ||
      !isCompactBoundaryMessage(message, provider) ||
      isCompactBoundaryPending(message)
    ) {
      continue
    }

    const hasLaterMessages = index < messages.length - 1
    if (hasLaterMessages || status !== 'streaming') {
      return index
    }
  }

  return null
}

const getMessageRenderWeight = (message: ChatMessage) => {
  let weight = message.content.length

  if (message.meta) {
    for (const [key, value] of Object.entries(message.meta)) {
      weight += key.length + value.length
    }
  }

  return weight
}

const getLatestContextUserIndex = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === 'user' &&
      !hasExplicitCompactBoundary(message) &&
      !isCompactCommandMessage(message)
    ) {
      return index
    }
  }

  return -1
}

const preserveLatestUserTurn = (messages: ChatMessage[], hiddenMessageCount: number) => {
  if (hiddenMessageCount <= 0) {
    return hiddenMessageCount
  }

  const latestUserIndex = getLatestContextUserIndex(messages)

  if (latestUserIndex >= 0 && hiddenMessageCount > latestUserIndex) {
    return latestUserIndex
  }

  return hiddenMessageCount
}

const getContentHiddenMessageCount = (messages: ChatMessage[]) => {
  if (messages.length < contentPerformanceMinimumMessageCount) {
    return 0
  }

  const totalWeight = messages.reduce((total, message) => total + getMessageRenderWeight(message), 0)

  if (totalWeight < contentPerformanceWindowThresholdChars) {
    return 0
  }

  let visibleWeight = 0
  let firstVisibleIndex = messages.length

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageWeight = getMessageRenderWeight(messages[index]!)
    const nextVisibleWeight = visibleWeight + messageWeight

    if (firstVisibleIndex < messages.length && nextVisibleWeight > contentPerformanceVisibleChars) {
      break
    }

    visibleWeight = nextVisibleWeight
    firstVisibleIndex = index
  }

  return Math.max(firstVisibleIndex, 0)
}

const getPerformanceHiddenMessageCount = (messages: ChatMessage[]) => {
  const { threshold, visibleCount } = getPerformanceWindowConfig(messages)
  const countHiddenMessageCount =
    messages.length >= threshold ? Math.max(messages.length - visibleCount, 0) : 0
  const contentHiddenMessageCount = getContentHiddenMessageCount(messages)

  return preserveLatestUserTurn(messages, Math.max(countHiddenMessageCount, contentHiddenMessageCount))
}

export const mergeCompactedHistoryForDisplay = (
  archivedMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  options?: MergeCompactedHistoryOptions,
) => {
  if (archivedMessages.length === 0) {
    return {
      messages: liveMessages,
      prependedMessageCount: 0,
    }
  }

  const uniqueArchivedMessages: ChatMessage[] = []
  const archivedIds = new Set<string>()
  for (const message of archivedMessages) {
    if (archivedIds.has(message.id)) {
      continue
    }
    archivedIds.add(message.id)
    uniqueArchivedMessages.push(message)
  }

  const liveMessageIds = new Set(liveMessages.map((message) => message.id))
  const firstSharedArchiveIndex = uniqueArchivedMessages.findIndex((archivedMessage) =>
    liveMessageIds.has(archivedMessage.id),
  )
  if (
    liveMessages.length === 0 ||
    (firstSharedArchiveIndex < 0 && options?.allowUnanchoredArchive !== true)
  ) {
    return {
      messages: liveMessages,
      prependedMessageCount: 0,
    }
  }

  const archivedPrefix = uniqueArchivedMessages
    .slice(0, firstSharedArchiveIndex < 0 ? undefined : firstSharedArchiveIndex)
    .filter((message) => !liveMessageIds.has(message.id))

  return {
    messages: archivedPrefix.length > 0 ? [...archivedPrefix, ...liveMessages] : liveMessages,
    prependedMessageCount: archivedPrefix.length,
  }
}

export const shouldAutoCompactCodexConversation = ({
  provider,
  sessionId,
  messages,
}: {
  provider: Provider
  sessionId?: string
  messages: ChatMessage[]
}) => {
  void provider
  void sessionId
  void messages
  return false
}

const buildCompactMessageWindow = ({
  messages,
  hiddenMessageCount,
  hiddenReason,
  compactTrigger,
  revealedHiddenMessageCount,
}: {
  messages: ChatMessage[]
  hiddenMessageCount: number
  hiddenReason: CompactWindowHiddenReason
  compactTrigger: CompactTrigger | null
  revealedHiddenMessageCount: number
}): CompactMessageWindow => {
  const clampedRevealCount = Math.min(
    Math.max(Math.trunc(revealedHiddenMessageCount), 0),
    hiddenMessageCount,
  )
  const remainingHiddenMessageCount = Math.max(hiddenMessageCount - clampedRevealCount, 0)

  return {
    hiddenMessageCount: remainingHiddenMessageCount,
  compactMessageId: messages[hiddenMessageCount]?.id ?? null,
  hiddenReason,
    compactTrigger,
    visibleMessages: messages.slice(remainingHiddenMessageCount),
  }
}

export const getCompactMessageWindow = (
  messages: ChatMessage[],
  provider: Provider,
  status: CardStatus,
  options?: CompactMessageWindowOptions,
): CompactMessageWindow => {
  const allowPerformanceWindowing = options?.allowPerformanceWindowing ?? true
  const revealedHiddenMessageCount = options?.revealedHiddenMessageCount ?? 0
  const compactBoundary = findLatestCompactBoundary(messages, provider, status)
  const pendingCompactBoundary = getPendingCompactBoundaryMessage(messages)
  const archivedHiddenMessageCount = Math.min(
    Math.max(Math.trunc(options?.archivedHiddenMessageCount ?? 0), 0),
    Math.max(messages.length - 1, 0),
  )

  if (compactBoundary === null && archivedHiddenMessageCount > 0 && pendingCompactBoundary === null) {
    return buildCompactMessageWindow({
      messages,
      hiddenMessageCount: archivedHiddenMessageCount,
      hiddenReason: 'compact',
      compactTrigger: 'auto',
      revealedHiddenMessageCount,
    })
  }

  if (compactBoundary === null || compactBoundary <= 0) {
    const performanceHiddenMessageCount = allowPerformanceWindowing
      ? getPerformanceHiddenMessageCount(messages)
      : 0

    if (performanceHiddenMessageCount <= 0) {
      return {
        hiddenMessageCount: 0,
        compactMessageId: null,
        hiddenReason: null,
        compactTrigger: null,
        visibleMessages: messages,
      }
    }

    return buildCompactMessageWindow({
      messages,
      hiddenMessageCount: performanceHiddenMessageCount,
      hiddenReason: 'performance',
      compactTrigger: null,
      revealedHiddenMessageCount,
    })
  }

  const performanceHiddenMessageCount = allowPerformanceWindowing
    ? compactBoundary + getPerformanceHiddenMessageCount(messages.slice(compactBoundary))
    : 0

  if (performanceHiddenMessageCount > compactBoundary) {
    return buildCompactMessageWindow({
      messages,
      hiddenMessageCount: performanceHiddenMessageCount,
      hiddenReason: 'performance',
      compactTrigger: null,
      revealedHiddenMessageCount,
    })
  }

  return buildCompactMessageWindow({
    messages,
    hiddenMessageCount: compactBoundary,
    hiddenReason: 'compact',
    compactTrigger: getCompactBoundaryTrigger(messages[compactBoundary], provider),
    revealedHiddenMessageCount,
  })
}
