import type { CardStatus, ChatMessage } from '../../shared/schema'

export type AutoUrgeEvaluation =
  | { kind: 'skip' }
  | { kind: 'disable' }
  | { kind: 'send'; message: string }

type AutoUrgeState = {
  active: boolean
  enabled: boolean
  message: string
  successKeyword: string
  messages: ChatMessage[]
}

type StreamFinishedTrigger = {
  type: 'stream-finished'
  previousStatus: CardStatus
  status: CardStatus
}

type ManualActivationTrigger = {
  type: 'manual-activation'
  status: CardStatus
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
        typeof entry.content === 'string' &&
        entry.content.includes(successKeyword),
    )
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

  const trimmedMessage = state.message.trim()
  if (!trimmedMessage) {
    return { kind: 'skip' }
  }

  if (trigger.type === 'stream-finished') {
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
