import type { AutoUrgeJudgeMode, CardStatus, ChatMessage } from '../../shared/schema'

export type AutoUrgeEvaluation =
  | { kind: 'skip' }
  | { kind: 'disable' }
  | { kind: 'send'; message: string }
  | { kind: 'judge'; message: string }

type AutoUrgeState = {
  active: boolean
  enabled: boolean
  message: string
  successKeyword: string
  messages: ChatMessage[]
  canSendEmptyContinuation?: boolean
  judgeMode?: AutoUrgeJudgeMode
}

type StreamFinishedTrigger = {
  type: 'stream-finished'
  previousStatus: CardStatus
  status: CardStatus
}

type ManualActivationTrigger = {
  type: 'manual-activation'
  status: CardStatus
  source?: 'card' | 'global'
}

export type AutoUrgeTrigger = StreamFinishedTrigger | ManualActivationTrigger

type AutoUrgeToggleState = {
  featureEnabled: boolean
  chatActive: boolean
  status: CardStatus
}

type AutoUrgeToggleResult = {
  featureEnabled: boolean
  chatActive: boolean
  shouldSendImmediately: boolean
}

const findLastUserMessageIndex = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index
    }
  }

  return -1
}

const latestAssistantTurnContainsSuccessKeyword = (
  messages: ChatMessage[],
  successKeyword: string,
) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)

  return messages
    .slice(latestUserMessageIndex + 1)
    .some(
      (entry) =>
        entry.role === 'assistant' &&
        entry.meta?.kind !== 'ask-user' &&
        typeof entry.content === 'string' &&
        entry.content.includes(successKeyword),
    )
}

export const latestTurnHasPendingAskUser = (messages: ChatMessage[]) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)

  return messages
    .slice(latestUserMessageIndex + 1)
    .some((entry) => entry.meta?.kind === 'ask-user')
}

export const latestTurnEndedByManualStop = (messages: ChatMessage[]) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)

  return messages
    .slice(latestUserMessageIndex + 1)
    .some(
      (entry) =>
        entry.meta?.kind === 'run-stopped' && entry.meta?.stopReason !== 'ask-user-answer',
    )
}

const judgeTextTailLimit = 4000

export const getLatestAssistantTurnText = (messages: ChatMessage[]) => {
  const latestUserMessageIndex = findLastUserMessageIndex(messages)
  const turnMessages = messages.slice(latestUserMessageIndex + 1)

  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    const entry = turnMessages[index]
    if (
      entry?.role === 'assistant' &&
      entry.meta?.kind !== 'ask-user' &&
      typeof entry.content === 'string' &&
      entry.content.trim()
    ) {
      const content = entry.content.trim()
      return content.length > judgeTextTailLimit ? content.slice(-judgeTextTailLimit) : content
    }
  }

  return ''
}

export type EffectiveAutoUrgeSource = 'card' | 'global' | 'none'

export type EffectiveAutoUrge = {
  active: boolean
  profileId: string
  source: EffectiveAutoUrgeSource
}

export const resolveEffectiveAutoUrge = ({
  cardAutoUrgeActive,
  cardAutoUrgeProfileId,
  globalUrgeActive,
  globalUrgeProfileId,
  isToolCard,
}: {
  cardAutoUrgeActive: boolean
  cardAutoUrgeProfileId: string
  globalUrgeActive: boolean
  globalUrgeProfileId: string
  isToolCard: boolean
}): EffectiveAutoUrge => {
  if (cardAutoUrgeActive) {
    return { active: true, profileId: cardAutoUrgeProfileId, source: 'card' }
  }

  if (globalUrgeActive && !isToolCard) {
    return { active: true, profileId: globalUrgeProfileId, source: 'global' }
  }

  return { active: false, profileId: cardAutoUrgeProfileId, source: 'none' }
}

export const getNextAutoUrgeToggleState = ({
  featureEnabled,
  chatActive,
  status,
}: AutoUrgeToggleState): AutoUrgeToggleResult => {
  const nextFeatureEnabled = true
  const nextChatActive = featureEnabled ? !chatActive : true

  return {
    featureEnabled: nextFeatureEnabled,
    chatActive: nextChatActive,
    shouldSendImmediately: nextChatActive && status === 'idle',
  }
}

export const evaluateAutoUrge = (
  trigger: AutoUrgeTrigger,
  state: AutoUrgeState,
): AutoUrgeEvaluation => {
  if (trigger.type === 'stream-finished') {
    if (trigger.previousStatus !== 'streaming' || trigger.status !== 'idle') {
      return { kind: 'skip' }
    }
  } else {
    if (trigger.status !== 'idle') {
      return { kind: 'skip' }
    }
  }

  if (!state.active || !state.enabled) {
    return { kind: 'skip' }
  }

  // A pending question to the user always wins: never urge over an
  // unanswered ask-user, regardless of trigger or judge mode.
  if (latestTurnHasPendingAskUser(state.messages)) {
    return { kind: 'skip' }
  }

  // A turn the user stopped by hand is a deliberate "wait" — neither the
  // stream-finished path nor a global-urge sweep may override it. Only an
  // explicit card-level re-activation counts as a new user instruction.
  const respectsManualStop =
    trigger.type === 'stream-finished' ||
    (trigger.type === 'manual-activation' && trigger.source === 'global')
  if (respectsManualStop && latestTurnEndedByManualStop(state.messages)) {
    return { kind: 'skip' }
  }

  const trimmedMessage = state.message.trim()
  const canSendBlankContinuation =
    state.canSendEmptyContinuation ??
    state.messages.some((message) => message.role === 'user' || message.role === 'assistant')
  if (!trimmedMessage && !canSendBlankContinuation) {
    return { kind: 'skip' }
  }

  if (trigger.type === 'stream-finished') {
    if (state.judgeMode === 'local-model') {
      return { kind: 'judge', message: trimmedMessage }
    }

    const trimmedSuccessKeyword = state.successKeyword.trim()
    const successFound =
      trimmedSuccessKeyword.length > 0 &&
      latestAssistantTurnContainsSuccessKeyword(state.messages, trimmedSuccessKeyword)

    if (successFound) {
      return { kind: 'disable' }
    }
  }

  return {
    kind: 'send',
    message: trimmedMessage,
  }
}
