import {
  DEFAULT_BRAINSTORM_ANSWER_COUNT,
  normalizeBrainstormAnswerCount as normalizeSharedBrainstormAnswerCount,
} from '../../shared/brainstorm'
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  normalizeStoredModel,
} from '../../shared/models'
import type { BrainstormState, ChatCard, Provider } from '../../shared/schema'

export const normalizeBrainstormAnswerCount = (value: unknown) =>
  normalizeSharedBrainstormAnswerCount(value, DEFAULT_BRAINSTORM_ANSWER_COUNT)

export const getBrainstormCardStatus = (
  brainstorm: BrainstormState,
): ChatCard['status'] => {
  if (brainstorm.answers.some((answer) => answer.status === 'streaming' && answer.streamId)) {
    return 'streaming'
  }

  // Individual answer failures stay local to the answer card so one bad slot
  // does not tint the whole brainstorm tool as a hard error state.
  return 'idle'
}

type BrainstormRequestTarget = Pick<BrainstormState, 'provider' | 'model'>

export const resolveBrainstormRequestTarget = (
  brainstorm: BrainstormRequestTarget,
  fallbackCodexModel = DEFAULT_CODEX_MODEL,
) => {
  const provider: Provider = brainstorm.provider === 'claude' ? 'claude' : 'codex'
  const fallbackModel = provider === 'claude' ? DEFAULT_CLAUDE_MODEL : fallbackCodexModel
  const model = normalizeStoredModel(provider, brainstorm.model) || fallbackModel

  return { provider, model }
}
