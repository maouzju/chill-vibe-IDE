import { DEFAULT_CODEX_MODEL } from './models.js'

export const DEFAULT_BRAINSTORM_ANSWER_COUNT = 6
export const MIN_BRAINSTORM_ANSWER_COUNT = 1
export const MAX_BRAINSTORM_ANSWER_COUNT = 12

export const normalizeBrainstormAnswerCount = (
  value: unknown,
  fallback = DEFAULT_BRAINSTORM_ANSWER_COUNT,
) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback
  }

  const truncated = Math.trunc(value)
  return Math.min(MAX_BRAINSTORM_ANSWER_COUNT, Math.max(MIN_BRAINSTORM_ANSWER_COUNT, truncated))
}

export const createDefaultBrainstormState = () => ({
  prompt: '',
  provider: 'codex' as const,
  model: DEFAULT_CODEX_MODEL,
  answerCount: DEFAULT_BRAINSTORM_ANSWER_COUNT,
  answers: [],
  failedAnswers: [],
})
