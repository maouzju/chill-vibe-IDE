import { MODEL_PICKER_HIDDEN_TOOL_MODELS } from '../../shared/models'
import type { ChatCard } from '../../shared/schema'

export type RepeatLoopCompletionKind = 'terminal' | 'background-pending' | 'stopped'

export const getEarliestRepeatLoopPrompt = (
  messages: ChatCard['messages'],
): string | null => {
  const firstUserPrompt = messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  )

  return firstUserPrompt?.content ?? null
}

export const resolveRepeatLoopCompletion = ({
  featureEnabled,
  completionKind,
  card,
}: {
  featureEnabled: boolean
  completionKind: RepeatLoopCompletionKind
  card: ChatCard
}): { prompt: string } | null => {
  if (
    !featureEnabled ||
    completionKind !== 'terminal' ||
    card.repeatLoopActive !== true ||
    MODEL_PICKER_HIDDEN_TOOL_MODELS.has(card.model) ||
    card.queuedSends.length > 0 ||
    (card.wakeTimerQueuedSends?.length ?? 0) > 0
  ) {
    return null
  }

  const prompt = getEarliestRepeatLoopPrompt(card.messages)
  return prompt ? { prompt } : null
}
