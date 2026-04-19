import type { AppLanguage } from '../../shared/schema'

const leadingOptionLikePattern = /^\s*-/

export const formatAskUserFollowUpPrompt = (
  answer: string,
  language: AppLanguage,
) => {
  const trimmed = answer.trim()

  if (!trimmed) {
    return answer
  }

  if (!leadingOptionLikePattern.test(trimmed)) {
    return trimmed
  }

  return language === 'en' ? `My choice: ${trimmed}` : `我选择：${trimmed}`
}
