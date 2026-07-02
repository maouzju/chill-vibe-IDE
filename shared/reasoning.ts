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
// `--effort xhigh` plus `"ultracode": true` in `--settings` (see providers.ts).
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

// Fable 5 cannot turn thinking off: the session toggle and `--effort none`
// have no effect there, and the model decides per step how much to think based
// on the effort level. Claude Code's own detection rule is "the model ID
// contains claude-fable-5"; the bare-alias forms cover hand-typed custom
// model values.
export const isClaudeAlwaysThinkingModel = (model?: string | null): boolean => {
  const normalized = model?.trim().toLowerCase() ?? ''
  if (!normalized) {
    return false
  }

  return (
    normalized.includes('claude-fable-5') ||
    normalized === 'fable' ||
    normalized.startsWith('fable-')
  )
}

// Fable 5's official default effort is high — max is documented as prone to
// overthinking there, and Fable output tokens cost 2x Opus.
export const getDefaultReasoningEffortForModel = (
  provider: Provider,
  model?: string | null,
): ReasoningEffort =>
  provider === 'claude' && isClaudeAlwaysThinkingModel(model) ? 'high' : getDefaultReasoningEffort(provider)

export const getReasoningOptions = (provider: Provider, language: AppLanguage = 'en') =>
  reasoningOptionsByProvider[provider].map((option) => ({
    ...option,
    label: reasoningOptionLabels[language][option.value],
  }))

// Model-aware tier menu: Fable 5 hides `auto` because auto rides the
// thinking-disabled path, which does not exist on an always-thinking model.
export const getReasoningOptionsForModel = (
  provider: Provider,
  model?: string | null,
  language: AppLanguage = 'en',
) =>
  provider === 'claude' && isClaudeAlwaysThinkingModel(model)
    ? getReasoningOptions(provider, language).filter((option) => option.value !== 'auto')
    : getReasoningOptions(provider, language)

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
// xhigh on the flag plus the official `"ultracode": true` session settings key
// (Claude Code v2.1.157+). `auto` likewise isn't a flag value, so callers pass
// it through their own thinking-disabled handling.
export const isUltracodeEffort = (effort?: string | null): boolean =>
  normalizeReasoningEffort('claude', effort) === 'ultracode'

export const toClaudeEffortFlag = (effort?: string | null): ReasoningEffort => {
  const normalized = normalizeReasoningEffort('claude', effort)
  return normalized === 'ultracode' ? 'xhigh' : normalized
}

// Model-aware normalization for persisted card tiers: on Fable 5 the auto
// (thinking-off) tier and empty/unknown values land on the model default high
// instead of the provider-wide max; every other model keeps the plain
// provider normalization.
export const normalizeReasoningEffortForModel = (
  provider: Provider,
  model?: string | null,
  effort?: string | null,
): ReasoningEffort => {
  if (provider !== 'claude' || !isClaudeAlwaysThinkingModel(model)) {
    return normalizeReasoningEffort(provider, effort)
  }

  const trimmed = effort?.trim().toLowerCase() ?? ''
  const matched = trimmed
    ? reasoningOptionsByProvider.claude.find((option) => option.value === trimmed)?.value
    : undefined

  if (!matched || matched === 'auto') {
    return getDefaultReasoningEffortForModel(provider, model)
  }

  return matched
}

// Single exit point for the `--effort` flag value. Fable 5 never receives
// `none` — thinking-off and the auto tier degrade to its high default there;
// every other model keeps the legacy thinking-off → none contract, and auto
// consistently rides that path instead of leaking the invalid literal "auto"
// onto the flag.
export const toClaudeEffortFlagValue = (
  model: string | null | undefined,
  effort: string | null | undefined,
  thinkingDisabled: boolean,
): string => {
  const normalized = normalizeReasoningEffort('claude', effort)

  if (thinkingDisabled || normalized === 'auto') {
    return isClaudeAlwaysThinkingModel(model)
      ? getDefaultReasoningEffortForModel('claude', model)
      : 'none'
  }

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
