import type { AppLanguage, Provider } from './schema.js'

type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
type ClaudeReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'max'
export type ReasoningEffort = CodexReasoningEffort | ClaudeReasoningEffort

export type ReasoningOption = {
  value: ReasoningEffort
  label: string
}

const reasoningOptionLabels: Record<AppLanguage, Record<ReasoningEffort, string>> = {
  'zh-CN': {
    auto: '自动',
    low: '低',
    medium: '中',
    high: '高',
    max: '最高',
    xhigh: '最高',
  },
  en: {
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    max: 'Max',
    xhigh: 'Max',
  },
}

const reasoningOptionsByProvider = {
  codex: [
    { value: 'low' },
    { value: 'medium' },
    { value: 'high' },
    { value: 'xhigh' },
  ],
  claude: [
    { value: 'auto' },
    { value: 'low' },
    { value: 'medium' },
    { value: 'high' },
    { value: 'max' },
  ],
} satisfies Record<Provider, readonly Omit<ReasoningOption, 'label'>[]>

const reasoningAliasesByProvider: Record<Provider, Partial<Record<string, ReasoningEffort>>> = {
  codex: {
    max: 'xhigh',
  },
  claude: {
    xhigh: 'max',
  },
}

const defaultReasoningEffortByProvider: Record<Provider, ReasoningEffort> = {
  codex: 'xhigh',
  claude: 'max',
}

export const getDefaultReasoningEffort = (provider: Provider) =>
  defaultReasoningEffortByProvider[provider]

export const getReasoningOptions = (provider: Provider, language: AppLanguage = 'en') =>
  reasoningOptionsByProvider[provider].map((option) => ({
    ...option,
    label: reasoningOptionLabels[language][option.value],
  }))

export const normalizeReasoningEffort = (
  provider: Provider,
  effort?: string | null,
): ReasoningEffort => {
  const trimmed = effort?.trim().toLowerCase() ?? ''
  const matchedOption = reasoningOptionsByProvider[provider].find((option) => option.value === trimmed)

  if (matchedOption) {
    return matchedOption.value
  }

  return reasoningAliasesByProvider[provider][trimmed] ?? getDefaultReasoningEffort(provider)
}

export const getReasoningLabel = (
  provider: Provider,
  effort?: string | null,
  language: AppLanguage = 'en',
) => {
  const normalized = normalizeReasoningEffort(provider, effort)
  return getReasoningOptions(provider, language).find((option) => option.value === normalized)?.label ?? normalized
}
