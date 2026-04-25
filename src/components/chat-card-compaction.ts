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
}

const compactBoundaryMetaKey = 'compactBoundary'
const compactTriggerMetaKey = 'compactTrigger'
const compactHiddenMetaKey = 'compactHidden'
const compactPendingMetaKey = 'compactPending'
const performanceWindowThreshold = 220
const performanceVisibleMessageCount = 140
const contentPerformanceWindowThresholdChars = 120_000
const contentPerformanceVisibleChars = 80_000
const structuredPerformanceWindowThreshold = 72
const structuredPerformanceVisibleMessageCount = 56
const structuredPerformanceScanCount = 96
const structuredPerformanceActivationCount = 36

const isStructuredPerformanceMessage = (message: ChatMessage) => {
  switch (message.meta?.kind) {
    case 'command':
    case 'tool':
    case 'edits':
    case 'reasoning':
    case 'todo':
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

const isCompactBoundaryPending = (message: ChatMessage) =>
  hasExplicitCompactBoundary(message) && message.meta?.[compactPendingMetaKey] === 'true'

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

const getContentHiddenMessageCount = (messages: ChatMessage[]) => {
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

  return Math.max(countHiddenMessageCount, contentHiddenMessageCount)
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
