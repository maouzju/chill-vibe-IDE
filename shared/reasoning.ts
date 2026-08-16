import type { AppLanguage, Provider } from './schema.js'

type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
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
// Current Codex 5.6 models can add max and, for Sol/Terra, Ultra. Older
// Codex models still top out at xhigh; model-aware filtering below keeps the
// persisted tier compatible with the selected model.
const reasoningOptionLabels: Record<AppLanguage, Record<ReasoningEffort, string>> = {
  'zh-CN': {
    auto: '自动',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
    ultra: 'Ultra（多 Agent）',
    ultracode: 'Ultracode（超高＋工作流）',
  },
  en: {
    auto: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
    ultra: 'Ultra (multi-agent)',
    ultracode: 'Ultracode (xhigh + workflows)',
  },
}

const reasoningOptionsByProvider = {
  codex: [
    { value: 'low' },
    { value: 'medium' },
    { value: 'high' },
    { value: 'xhigh' },
    { value: 'max' },
    { value: 'ultra' },
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
    ultracode: 'ultra',
  },
  claude: {},
}

const defaultReasoningEffortByProvider: Record<Provider, ReasoningEffort> = {
  codex: 'medium',
  claude: 'max',
}

export const getDefaultReasoningEffort = (provider: Provider) =>
  defaultReasoningEffortByProvider[provider]

// Fable 5 cannot turn thinking off: the session toggle has no effect there, and
// the model decides per step how much to think based on the effort level.
// (Nothing turns thinking off on any model — the CLI has no such switch at all;
// see pitfall #289. Fable is special only in that it also ignores the lowest
// tier as a stand-in.) Claude Code's own detection rule is "the model ID
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

/**
 * 用户在思考关闭的状态下选了一个思考深度 —— 该不该顺手把思考打开？
 *
 * 症状：2026-08-16 用户截图报「这什么垃圾UI啊，怎么还没法设置」。当时深度下拉被
 *   思考开关 disable，界面上只剩一个灰掉的「超高」，既点不动也没写为什么。
 * 根因：把「关思考」实现成了深度的**前置条件**，但它其实只是深度谱系的最低一档
 *   （Codex 落 none / Claude 落 low，见 pitfall #289），两者是同一维度的东西。
 * 为什么不是加一行说明文字：说明只能让用户知道要多点一次开关，那一次点击没有
 *   任何信息量 —— 选「超高」本身就已经完整表达了意图。
 *
 * 独立成一个共享出口而不是各写各的：这条语义有两个渲染点（聊天 composer 的设置
 * 菜单、看板模板/待命面板），且两侧的调用形态不同（前者是 toggle 回调、后者是
 * patch 对象），只在其中一处内联判断就是等着下次改一半。
 */
export const shouldEnableThinkingForDepthChange = (
  thinkingEnabled: boolean | undefined,
  alwaysThinking: boolean,
): boolean => !alwaysThinking && thinkingEnabled === false

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

const getCodexReasoningOptionValuesForModel = (model?: string | null): CodexReasoningEffort[] => {
  const normalizedModel = model?.trim().toLowerCase() ?? ''
  const base: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

  if (
    normalizedModel === 'gpt-5.6-sol' ||
    normalizedModel === 'gpt-5.6-terra' ||
    normalizedModel === 'gpt-5.6'
  ) {
    return [...base, 'max', 'ultra']
  }

  if (normalizedModel === 'gpt-5.6-luna') {
    return [...base, 'max']
  }

  return base
}

// Model-aware tier menu: Fable 5 hides `auto` because auto means "omit --effort
// and let the CLI pick", and Fable always needs an explicit tier (it degrades to
// its own high default instead).
export const getReasoningOptionsForModel = (
  provider: Provider,
  model?: string | null,
  language: AppLanguage = 'en',
) => {
  if (provider === 'codex') {
    const supportedValues = new Set(getCodexReasoningOptionValuesForModel(model))
    return getReasoningOptions(provider, language).filter((option) =>
      supportedValues.has(option.value as CodexReasoningEffort),
    )
  }

  return isClaudeAlwaysThinkingModel(model)
    ? getReasoningOptions(provider, language).filter((option) => option.value !== 'auto')
    : getReasoningOptions(provider, language)
}

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
// (Claude Code v2.1.157+).
//
// 这里曾经还有一个 `toClaudeEffortFlag`（少一个 Value）：零调用、但导出，且喂它
// `auto` 会原样吐出 `'auto'` —— 与 pitfall #289 里的 `none` 完全同一类 CLI 不认
// 的值。它的名字是真正出口 `toClaudeEffortFlagValue` 的严格前缀，自动补全和 grep
// 都会先撞上它，第一个接线的人就会静默重演那个 bug。已删除：档位出口只留一个。
export const isUltracodeEffort = (effort?: string | null): boolean =>
  normalizeReasoningEffort('claude', effort) === 'ultracode'

// Model-aware normalization for persisted card tiers: on Fable 5 the auto
// (thinking-off) tier and empty/unknown values land on the model default high
// instead of the provider-wide max; every other model keeps the plain
// provider normalization.
export const normalizeReasoningEffortForModel = (
  provider: Provider,
  model?: string | null,
  effort?: string | null,
): ReasoningEffort => {
  if (provider === 'codex') {
    const normalized = normalizeReasoningEffort(provider, effort) as CodexReasoningEffort
    const supportedValues = getCodexReasoningOptionValuesForModel(model)

    if (supportedValues.includes(normalized)) {
      return normalized
    }

    return supportedValues.includes('max') ? 'max' : 'xhigh'
  }

  if (!isClaudeAlwaysThinkingModel(model)) {
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

// Single exit point for the `--effort` flag value. `null` means "omit the flag
// entirely" — callers must not stringify it onto the command line.
//
// 症状：选「自动」或关掉思考的会话，CLI 每轮都打
//   Warning: Unknown --effort value 'none' — ignoring it and using the default effort.
// 两个档位因此双双失效，用户的选择被静默丢弃。
// 根因：`none` 从来不是 CLI 认的值。2026-08-13 实测 `claude --effort none` 与
// `claude --effort bogus` 输出完全相同的警告、同样回落默认档；`claude --help`
// 只列 low/medium/high/xhigh/max，且 CLI 没有任何关闭思考的开关。
// 为什么不能继续传 none：它与拼错的值完全等价。auto 省略 flag 才是真正的
// 「跟随 CLI 默认」；关思考落在 low —— 合法值里唯一忠实于「别想太多」意图的
// 档，省略 flag 反而会让默认档比用户要的更深。
// Fable 5 例外：思考关不掉，auto 与关思考都退回它的 high 默认。
export const toClaudeEffortFlagValue = (
  model: string | null | undefined,
  effort: string | null | undefined,
  thinkingDisabled: boolean,
): string | null => {
  const normalized = normalizeReasoningEffort('claude', effort)

  if (isClaudeAlwaysThinkingModel(model)) {
    return thinkingDisabled || normalized === 'auto'
      ? getDefaultReasoningEffortForModel('claude', model)
      : normalized === 'ultracode'
        ? 'xhigh'
        : normalized
  }

  if (thinkingDisabled) {
    return 'low'
  }

  if (normalized === 'auto') {
    return null
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
