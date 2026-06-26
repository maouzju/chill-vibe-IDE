import type { AppLanguage, Provider } from './schema.js'

type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
type ClaudeReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'
export type ReasoningEffort = CodexReasoningEffort | ClaudeReasoningEffort

export type ReasoningOption = {
  value: ReasoningEffort
  label: string
}

// Claude CLI `--effort` accepts low/medium/high/xhigh/max (xhigh and max are
// distinct rungs — max is the deepest pure-reasoning level with no token cap).
// `ultracode` is NOT a `--effort` value: it is the session-level top rung that
// sends xhigh to the model and additionally has Claude orchestrate dynamic
// workflows. We surface it as a selectable tier and activate it by sending
// `--effort xhigh` plus injecting the `ultracode` keyword (see providers.ts).
// Codex tops out at xhigh and has no max/ultracode equivalent.
const reasoningOptionLabels: Record<AppLanguage, Record<ReasoningEffort, string>> = {
  'zh-CN': {
    auto: '自动',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
    ultracode: 'Ultracode（超高＋工作流）',
  },
  en: {
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
    ultracode: 'Ultracode (xhigh + workflows)',
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
    { value: 'xhigh' },
    { value: 'max' },
    { value: 'ultracode' },
  ],
} satisfies Record<Provider, readonly Omit<ReasoningOption, 'label'>[]>

const reasoningAliasesByProvider: Record<Provider, Partial<Record<string, ReasoningEffort>>> = {
  codex: {
    // Codex has no max/ultracode rung — snap both to its xhigh top tier.
    max: 'xhigh',
    ultracode: 'xhigh',
  },
  claude: {},
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

// The Claude CLI `--effort` flag rejects the literal "ultracode" (it only
// accepts low/medium/high/xhigh/max). The ultracode tier is realized by sending
// xhigh on the flag and separately injecting the `ultracode` keyword to opt the
// session into dynamic-workflow orchestration. `auto` likewise isn't a flag
// value, so callers pass it through their own thinking-disabled handling.
export const isUltracodeEffort = (effort?: string | null): boolean =>
  normalizeReasoningEffort('claude', effort) === 'ultracode'

export const toClaudeEffortFlag = (effort?: string | null): ReasoningEffort => {
  const normalized = normalizeReasoningEffort('claude', effort)
  return normalized === 'ultracode' ? 'xhigh' : normalized
}

export const getReasoningLabel = (
  provider: Provider,
  effort?: string | null,
  language: AppLanguage = 'en',
) => {
  const normalized = normalizeReasoningEffort(provider, effort)
  return getReasoningOptions(provider, language).find((option) => option.value === normalized)?.label ?? normalized
}
