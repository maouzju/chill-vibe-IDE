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

const findLastAssistantMessage = (messages: ChatMessage[]) =>
  [...messages].reverse().find((entry) => entry.role === 'assistant')

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

  const trimmedSuccessKeyword = state.successKeyword.trim()
  const lastAssistantMessage = findLastAssistantMessage(state.messages)
  const successFound =
    trimmedSuccessKeyword.length > 0 &&
    typeof lastAssistantMessage?.content === 'string' &&
    lastAssistantMessage.content.includes(trimmedSuccessKeyword)

  if (successFound) {
    return { kind: 'disable' }
  }

  return {
    kind: 'send',
    message: trimmedMessage,
  }
}
