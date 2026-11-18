import type { LocalModelEntry, ModelPickerCustomModel, Provider } from './schema.js'

export const DEFAULT_CODEX_MODEL = 'gpt-6-sol'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
// 2026-11-14：默认仍保持 Gemini 3.8 Flash；更新的 Gemini 4 型号进入可选列表。
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
export const DEFAULT_GIT_AGENT_MODEL = 'gpt-6-luna medium'
/**
 * 目录里明确「不收 reasoning.effort=none、也不收 personality」的 Codex 型号：缺省档 low、六档到 ultra。
 *
 * 症状（2026-09-30 真实中转站探针）：gpt-6.1-sol + effort=none → 整轮 400
 *   `does not support reasoning effort 'none'`；同一探针 gpt-6-sol / gpt-6-luna 则正常。
 * 根因：`none` 是否合法是逐型号的能力，而「关思考 → none」是全局映射。Astra 时代这条判定
 *   叫 isAstraModel、散在请求出口与两处 UI，6.1 Sol 一来就有一半出口漏掉。
 * 做法：判定收在这一处（依据 Codex `model/list` 的 supportedReasoningEfforts / supportsPersonality），
 *   请求出口、personality 与 UI 一律引用它；新型号进这份名单即可，不再逐处补。
 * 被否决：前缀匹配——没有实证（日期快照名、`-openai-compact` 变体是否同性质未知），保持精确匹配。
 */
const CODEX_NONE_EFFORT_UNSUPPORTED_MODELS = new Set(['gpt-6-astra', 'gpt-6.1-sol'])

export const isCodexNoneEffortUnsupportedModel = (model?: string | null): boolean =>
  CODEX_NONE_EFFORT_UNSUPPORTED_MODELS.has(model?.trim().toLowerCase() ?? '')
export const GIT_TOOL_MODEL = '__git_tool__'
export const MUSIC_TOOL_MODEL = '__music_tool__'
export const WHITENOISE_TOOL_MODEL = '__whitenoise_tool__'
export const WEATHER_TOOL_MODEL = '__weather_tool__'
export const STICKYNOTE_TOOL_MODEL = '__stickynote_tool__'
export const FILETREE_TOOL_MODEL = '__filetree_tool__'
export const BRAINSTORM_TOOL_MODEL = '__brainstorm_tool__'
export const TEXTEDITOR_TOOL_MODEL = '__texteditor_tool__'
export const IMAGEEDITOR_TOOL_MODEL = '__imageeditor_tool__'
export const AUTOMATIONBOARD_TOOL_MODEL = '__automationboard_tool__'
export const STATS_TOOL_MODEL = '__stats_tool__'
// Legacy-only token kept so persisted PM cards can be demoted safely during load.
export const PM_TOOL_MODEL = '__pm_tool__'

export type ModelOption = {
  label: string
  provider: Provider
  model: string
  aliases?: string[]
  usesConfiguredDefault?: boolean
  hiddenFromPicker?: boolean
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    label: 'Git',
    provider: 'codex',
    model: GIT_TOOL_MODEL,
    aliases: ['git', 'git-tool', 'commit'],
  },
  {
    label: 'Music',
    provider: 'codex',
    model: MUSIC_TOOL_MODEL,
    aliases: ['music', 'music-tool', 'netease', 'playlist'],
  },
  {
    label: 'White Noise',
    provider: 'codex',
    model: WHITENOISE_TOOL_MODEL,
    aliases: ['whitenoise', 'ambient', 'noise'],
  },
  {
    label: 'Weather',
    provider: 'codex',
    model: WEATHER_TOOL_MODEL,
    aliases: ['weather', 'weather-tool'],
  },
  {
    label: 'Sticky Note',
    provider: 'codex',
    model: STICKYNOTE_TOOL_MODEL,
    aliases: ['note', 'sticky', 'stickynote', 'memo'],
  },
  {
    label: 'Files',
    provider: 'codex',
    model: FILETREE_TOOL_MODEL,
    aliases: ['files', 'filetree', 'tree', 'explorer'],
  },
  {
    label: 'Brainstorm',
    provider: 'codex',
    model: BRAINSTORM_TOOL_MODEL,
    aliases: ['brainstorm', 'brain-storm', 'ideas', 'ideation'],
  },
  {
    label: 'Editor',
    provider: 'codex',
    model: TEXTEDITOR_TOOL_MODEL,
    aliases: ['editor', 'text-editor', 'texteditor', 'edit'],
  },
  {
    label: 'Images',
    provider: 'codex',
    model: IMAGEEDITOR_TOOL_MODEL,
    aliases: ['image', 'images', 'photo', 'photoshop'],
  },
  {
    label: 'Automation',
    provider: 'codex',
    model: AUTOMATIONBOARD_TOOL_MODEL,
    aliases: ['board', 'kanban', 'automation', 'automation-board', 'auto'],
  },
  {
    label: 'Stats',
    provider: 'codex',
    model: STATS_TOOL_MODEL,
    aliases: ['stats', 'statistics', 'insights', 'activity'],
  },
  {
    label: 'Codex',
    provider: 'codex',
    model: '',
    aliases: ['gpt', 'codex'],
    usesConfiguredDefault: true,
  },
  {
    label: 'Claude',
    provider: 'claude',
    model: '',
    aliases: ['claude'],
    usesConfiguredDefault: true,
  },
  {
    label: 'Gemini',
    provider: 'gemini',
    model: '',
    aliases: ['gemini', 'google'],
    usesConfiguredDefault: true,
  },
  {
    // 2026-11-17 发布（OpenAI 官方 + duckcoding 中转站实测 none/low/max 均可用，none 不被拒，
    // 所以不进 CODEX_NONE_EFFORT_UNSUPPORTED_MODELS）。裸别名 sol/6 仍归默认的 GPT-6 Sol。
    label: 'GPT-6.2 Sol',
    provider: 'codex',
    model: 'gpt-6.2-sol',
    aliases: ['gpt-6.2-sol', '6.2-sol', 'sol-6.2', 'sol6.2', 'gpt62sol'],
  },
  {
    label: 'GPT-6.2 Astra',
    provider: 'codex',
    model: 'gpt-6.2-astra',
    aliases: ['gpt-6.2-astra', '6.2-astra', 'astra-6.2', 'astra6.2', 'gpt62astra', 'astra', '6.2'],
  },
  {
    // 2026-11-17 起被 6.2 取代，退出选择器；别名与旧卡保留。
    label: 'GPT-6.1 Sol',
    provider: 'codex',
    model: 'gpt-6.1-sol',
    aliases: ['gpt-6.1-sol', '6.1', '6.1-sol', 'sol-6.1', 'sol6.1', 'gpt61sol'],
    hiddenFromPicker: true,
  },
  {
    // Retired from the picker on 2026-10-01; keep aliases and stored cards working.
    label: 'GPT-6 Sol',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    aliases: ['gpt-6-sol', '6', '6-sol', 'sol', 'gpt6sol'],
    hiddenFromPicker: true,
  },
  {
    label: 'GPT-6 Luna',
    provider: 'codex',
    model: 'gpt-6-luna',
    aliases: ['gpt-6-luna', '6-luna', 'luna', 'gpt6luna'],
  },
  {
    label: 'GPT-5.6 Sol',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    aliases: ['gpt-5.6', 'gpt-5.6-sol', '5.6', '5.6-sol', 'gpt56'],
    hiddenFromPicker: true,
  },
  {
    label: 'GPT-6 Astra',
    provider: 'codex',
    model: 'gpt-6-astra',
    aliases: ['gpt-6-astra', 'gpt6', 'gpt-6'],
    hiddenFromPicker: true,
  },
  {
    label: 'GPT-5.6 Terra',
    provider: 'codex',
    model: 'gpt-5.6-terra',
    aliases: ['gpt-5.6-terra', '5.6-terra', 'terra'],
    hiddenFromPicker: true,
  },
  {
    label: 'GPT-5.6 Luna',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    aliases: ['gpt-5.6-luna', '5.6-luna', 'luna'],
    hiddenFromPicker: true,
  },
  {
    label: 'GPT-5.5',
    provider: 'codex',
    model: 'gpt-5.5',
    aliases: ['gpt-5.5', '5.5', 'gpt55'],
    hiddenFromPicker: true,
  },
  {
    // Mythos-class tier above Opus; never the default. Bare "fable" follows the
    // newest Fable generation, like bare "opus"/"sonnet" do.
    label: 'Fable 5.2',
    provider: 'claude',
    model: 'claude-fable-5-2',
    aliases: ['fable', 'fable-5.2', 'claude-fable-5-2'],
  },
  {
    // Retired from the picker, but kept for exact legacy commands and saved cards.
    label: 'Fable 5.1',
    provider: 'claude',
    model: 'claude-fable-5-1',
    aliases: ['fable-5.1', 'claude-fable-5-1'],
    hiddenFromPicker: true,
  },
  {
    // Retired from the picker, but kept for exact legacy commands and saved cards.
    label: 'Fable 5',
    provider: 'claude',
    model: 'claude-fable-5',
    aliases: ['fable-5', 'claude-fable-5'],
    hiddenFromPicker: true,
  },
  {
    // Bare "opus" follows the newest Opus tier, like bare "sonnet" does.
    label: 'Opus 5.5',
    provider: 'claude',
    model: DEFAULT_CLAUDE_MODEL,
    aliases: ['opus', 'opus-5.5', 'claude-opus-5-5'],
  },
  {
    // Retired from the picker, but kept for exact legacy commands and saved cards.
    label: 'Opus 5',
    provider: 'claude',
    model: 'claude-opus-5',
    aliases: ['opus-5', 'claude-opus-5'],
    hiddenFromPicker: true,
  },
  {
    // Bare "sonnet" follows the newest Sonnet tier, like bare "opus" does.
    label: 'Sonnet 5.5',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    aliases: ['sonnet', 'sonnet-5.5', 'claude-sonnet-5-5'],
  },
  {
    // Retired from the picker, but kept for exact legacy commands and saved cards.
    label: 'Sonnet 5',
    provider: 'claude',
    model: 'claude-sonnet-5',
    aliases: ['sonnet-5', 'claude-sonnet-5'],
    hiddenFromPicker: true,
  },
  {
    // Retired from the picker, but kept for exact legacy commands and saved cards.
    label: 'Sonnet 4.6',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    aliases: ['sonnet-4.6', 'claude-sonnet-4-6'],
    hiddenFromPicker: true,
  },
  {
    // 2026-10-07 发布，API id 为不带日期戳的 claude-haiku-5-5（2026-10-09 用 CLI 2.1.280 实测真实可用，
    // CLI 只报 unrecognized_model 日志、不拦截）。裸 "haiku" 跟随最新一代，与 opus/sonnet 一致。
    label: 'Haiku 5.5',
    provider: 'claude',
    model: 'claude-haiku-5-5',
    aliases: ['haiku', 'haiku-5.5', 'claude-haiku-5-5'],
  },
  {
    // Retired from the picker, but kept for exact legacy commands and saved cards.
    label: 'Haiku 4.5',
    provider: 'claude',
    model: 'claude-haiku-4-5-20251001',
    aliases: ['haiku-4.5', 'claude-haiku-4-5-20251001'],
    hiddenFromPicker: true,
  },
  {
    // 2026-11-14：Google Gemini API 模型目录中的最新通用型号。
    label: 'Gemini 4 Carbon',
    provider: 'gemini',
    model: 'gemini-4-carbon',
    aliases: ['gemini-4-carbon', 'carbon', '4-carbon'],
  },
  {
    label: 'Gemini 4 Hydrogen',
    provider: 'gemini',
    model: 'gemini-4-hydrogen',
    aliases: ['gemini-4-hydrogen', 'hydrogen', '4-hydrogen'],
  },
  {
    label: 'Gemini 4 Argon',
    provider: 'gemini',
    model: 'gemini-4-argon',
    aliases: ['gemini-4-argon', 'argon', 'gemini-4', '4-argon'],
  },
  {
    label: 'Gemini 3.1 Pro',
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    aliases: ['gemini-3.1-pro-preview', 'gemini-3.1-pro', 'pro', '3.1-pro'],
  },
  {
    // 裸 "flash" 跟随最新一代 Flash，与 opus/sonnet 的裸别名规则一致。
    label: 'Gemini 3.8 Flash',
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
    aliases: ['gemini-3.8-flash', 'flash', '3.8-flash', '3.8'],
  },
  {
    label: 'Gemini 3 Flash',
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    aliases: ['gemini-3-flash-preview', '3-flash', 'flash-3'],
  },
  {
    label: 'Gemini 3.5 Flash Lite',
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    aliases: ['gemini-3.5-flash-lite', 'flash-lite', 'lite'],
  },
  {
    label: 'Gemini 3.1 Flash Lite',
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite',
    aliases: ['gemini-3.1-flash-lite', '3.1-flash-lite'],
  },
  {
    label: 'Gemini 3.6 Flash',
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    aliases: ['gemini-3.6-flash', '3.6-flash'],
    hiddenFromPicker: true,
  },
  {
    label: 'Gemini 2.5 Pro',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    aliases: ['gemini-2.5-pro', '2.5-pro'],
    hiddenFromPicker: true,
  },
  {
    label: 'Gemini 2.5 Flash',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    aliases: ['gemini-2.5-flash', '2.5-flash'],
    hiddenFromPicker: true,
  },
]

/**
 * 症状：打开自动化看板后，之后新建的每一张卡都变成看板样式且一片空白。
 * 根因：`src/state.ts` 曾经维护一份**第二份**工具模型名单，新增看板时漏加，
 *   于是"切到看板"被当成用户选了一个真模型，写进 settings.requestModels /
 *   lastModel / column.model，新建 tab 再原样继承回来（2026-08-11 实证）。
 * 被否决的替代：在下游各处特判看板模型 —— 那只是给同一个漏名单再补一处，
 *   下一个工具卡还会再犯。工具模型名单在此单点定义，其他地方一律引用。
 */
export const TOOL_CARD_MODELS = new Set([
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  AUTOMATIONBOARD_TOOL_MODEL,
  STATS_TOOL_MODEL,
])

export const isToolCardModel = (model?: string | null) =>
  TOOL_CARD_MODELS.has((model ?? '').trim())

export const MODEL_PICKER_HIDDEN_TOOL_MODELS = TOOL_CARD_MODELS

export const isModelPickerOptionVisible = (
  option: Pick<ModelOption, 'model' | 'hiddenFromPicker'>,
) => !TOOL_CARD_MODELS.has(option.model) && !option.hiddenFromPicker

/**
 * 头脑风暴的「请求模型」选单与普通模型选择器同源，差别只有一条：它不提供
 * 「用默认模型」那一项，因为一条头脑风暴请求必须指名具体模型。
 *
 * 症状：已从选择器下架的型号（Sonnet 4.6、Fable 5）在头脑风暴的模型下拉里仍然可选。
 * 根因：那处 filter 另抄了一份「排掉工具卡」的条件，与 isModelPickerOptionVisible
 *   并列演化，于是后加的 hiddenFromPicker 只在其中一处生效。
 * 被否决的替代：在 ChatCard 里补一个 `&& !option.hiddenFromPicker` —— 两份等价过滤
 *   继续并存，下一个可见性维度还会再漏一处。
 */
export const isBrainstormRequestModelVisible = (
  option: Pick<ModelOption, 'model' | 'hiddenFromPicker' | 'usesConfiguredDefault'>,
) => !option.usesConfiguredDefault && isModelPickerOptionVisible(option)

const legacyCodexModels = new Set(['gpt-4.5', '__dream_tool__', '__spec_tool__'])

const canonicalizeModelAlias = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-')

const DEFAULT_MODELS: Record<Provider, string> = {
  codex: DEFAULT_CODEX_MODEL,
  claude: DEFAULT_CLAUDE_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
}

export const getDefaultModel = (provider: Provider) => DEFAULT_MODELS[provider]

export const getModelOptions = (provider: Provider) =>
  MODEL_OPTIONS.filter((option) => option.provider === provider)

/**
 * Claude Agent 工具的 `model` 只收这四个别名；子 agent 提示词与 CLI 的别名落点都从这里派生。
 *
 * 症状（2026-09-29 实测 CLI 2.1.280）：Sonnet 5.5 发布次日，CLI 自带的 `sonnet` 别名仍解析到
 *   claude-sonnet-5，而提示词按目录告诉 agent「sonnet = Sonnet 5.5」—— 子 agent 实际跑的是旧型号。
 * 根因：别名表在 CLI 二进制里，随 CLI 版本走，与本目录各自演化。
 * 做法：同一份映射经 ANTHROPIC_DEFAULT_*_MODEL 钉给 CLI（实测子 agent 随之落到 claude-sonnet-5-5）。
 * 被否决：CLAUDE_CODE_SUBAGENT_MODEL —— 那是把所有子 agent 定死成一个模型，不是修正别名。
 */
export const CLAUDE_AGENT_MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const

export const resolveClaudeAgentAliasModels = () => {
  const models = getModelOptions('claude').filter(
    (option) => isModelPickerOptionVisible(option) && !option.usesConfiguredDefault && option.model,
  )
  return CLAUDE_AGENT_MODEL_ALIASES.flatMap((alias) => {
    const option = models.find((candidate) => candidate.label.toLowerCase().startsWith(alias))
    return option ? [{ alias, option }] : []
  })
}

export const buildClaudeAgentAliasModelEnv = (): Record<string, string> =>
  Object.fromEntries(
    resolveClaudeAgentAliasModels().map(({ alias, option }) => [
      `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`,
      option.model,
    ]),
  )

/**
 * 「默认模型被内置新型号完爆」的判定表：旧型号 → 同档位更强的新型号（单跳，直指最新）。
 *
 * 症状（2026-10-13）：升级后用户在「设置→模型」里手配的默认仍是 GPT-6 Sol，而选择器里
 *   已上架 GPT-6.1 Sol；没人告诉他，他会一直用着旧档。
 * 做法：只对「同档位换代」建表（Sol→Sol、Opus→Opus），不跨档——Sonnet 默认不会被 Opus 顶替，
 *   那是价格取舍，不是被完爆。新型号上架时在此加一行即可，弹窗对每条 provider+from+to 只提示一次。
 * 被否决：自动静默换——默认模型是用户的选择，且换代会影响计费与行为，必须让用户点头。
 */
export const MODEL_SUCCESSORS: Record<Provider, Record<string, string>> = {
  codex: {
    'gpt-6-sol': 'gpt-6.2-sol',
    'gpt-6.1-sol': 'gpt-6.2-sol',
    'gpt-5.6-sol': 'gpt-6.2-sol',
    'gpt-6-astra': 'gpt-6.2-astra',
    'gpt-5.6-luna': 'gpt-6-luna',
  },
  claude: {
    'claude-opus-5': 'claude-opus-5-5',
    'claude-sonnet-5': 'claude-sonnet-5-5',
    'claude-sonnet-4-6': 'claude-sonnet-5-5',
    'claude-fable-5': 'claude-fable-5-2',
    'claude-fable-5-1': 'claude-fable-5-2',
    'claude-haiku-4-5-20251001': 'claude-haiku-5-5',
  },
  gemini: {
    'gemini-2.5-pro': 'gemini-3.1-pro-preview',
    'gemini-2.5-flash': 'gemini-3.8-flash',
    'gemini-3.6-flash': 'gemini-3.8-flash',
  },
}

export type ModelUpgradeSuggestion = {
  provider: Provider
  from: string
  to: string
  key: string
}

const buildModelUpgradeKey = (provider: Provider, from: string, to: string) =>
  `${provider}:${from}>${to}`

export const listModelUpgradeKeys = (): string[] =>
  (['codex', 'claude', 'gemini'] as const).flatMap((provider) =>
    Object.entries(MODEL_SUCCESSORS[provider]).map(([from, to]) => buildModelUpgradeKey(provider, from, to)),
  )

export const findModelUpgradeSuggestions = (
  requestModels: Partial<Record<Provider, string>>,
  acknowledged: readonly string[],
): ModelUpgradeSuggestion[] =>
  (['codex', 'claude', 'gemini'] as const).flatMap((provider) => {
    const from = (requestModels[provider] ?? '').trim().toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(MODEL_SUCCESSORS[provider], from)) {
      return []
    }
    const to = MODEL_SUCCESSORS[provider][from]

    const key = buildModelUpgradeKey(provider, from, to)
    return acknowledged.includes(key) ? [] : [{ provider, from, to, key }]
  })

export const getModelLabel = (provider: Provider, model: string) =>
  MODEL_OPTIONS.find((option) => option.provider === provider && option.model === model)?.label ?? model

export const normalizeStoredModel = (provider: Provider, model?: string | null) => {
  const trimmed = model?.trim() ?? ''

  if (!trimmed) {
    return ''
  }

  if (provider === 'codex' && legacyCodexModels.has(trimmed)) {
    return DEFAULT_CODEX_MODEL
  }

  return trimmed
}

export const normalizeModel = (provider: Provider, model?: string | null) =>
  normalizeStoredModel(provider, model) || getDefaultModel(provider)

/**
 * 症状：2026-09-02 Fable 升到 5.1（`claude-fable-5-1`）后，一批「这是不是 Fable」
 *   的判断会静默失效 —— 强制思考的档位约束回落到普通 Claude 规则，陈旧列继承也
 *   不再把残留的 Fable 列判为陈旧，于是在 Sonnet 上聊过的 pane 新建 tab 又被拉回
 *   2 倍价的 Fable。
 * 根因：同一个问题在 `shared/reasoning.ts` 与 `src/state.ts` 各写各的字面量比较，
 *   一处是 `includes('claude-fable-5')`（侥幸兼容 5.1），一处是 `=== 'claude-fable-5'`
 *   （直接失效）。判定分叉 ⇒ 换代时必然漏改一半。
 * 被否决的替代：在每处补一个 `|| === 'claude-fable-5-1'` —— 那只是给同一份漏名单
 *   再补一处，下一代 Fable 还会重演（与 TOOL_CARD_MODELS 那次同型，见上方注释）。
 * 前缀取 `claude-fable-` 而非官方原文的 `claude-fable-5`：代际号不该进判定条件。
 * 裸别名形态覆盖用户在「设置→模型」里手打的自定义模型名。
 */
export const isFableModel = (model?: string | null): boolean => {
  const normalized = model?.trim().toLowerCase() ?? ''

  return (
    normalized.includes('claude-fable-') ||
    normalized === 'fable' ||
    normalized.startsWith('fable-')
  )
}

export const resolveSlashModel = (provider: Provider, input: string) => {
  const candidate = canonicalizeModelAlias(input)
  const option = getModelOptions(provider).find((entry) => {
    const values = [
      entry.model,
      entry.label,
      ...(entry.aliases ?? []),
    ].map(canonicalizeModelAlias)

    return values.includes(candidate)
  })

  return option?.model ?? null
}

// 目录外的模型名（中转站 / 自定义 / `vendor/model` 形态）按家族关键字归属。关键字必须出现在
// 词首（行首或分隔符之后），免得 `photogpt`、`foo3` 之类碰巧含片段的名字被误认。
const PROVIDER_FAMILY_PATTERNS: [Provider, RegExp][] = [
  ['claude', /(?:^|[^a-z0-9])(?:claude|anthropic|opus|sonnet|haiku|fable)/],
  ['gemini', /(?:^|[^a-z0-9])gemini/],
  ['codex', /(?:^|[^a-z0-9])(?:gpt|codex|openai|o\d)/],
]

/**
 * 自由文本模型名归属哪个 CLI；认不出来返回 null，由调用方决定兜底。
 *
 * 症状：2026-10-17 用户在「Git 卡片 AI 模型」里填 claude-sonnet-5-5，Git 卡仍写死走 Codex，
 *   把一个 Claude 模型发给 Codex CLI。
 * 做法：先精确比对模型目录（正式 id / 标签 / 别名，如 `sonnet`、`luna`、`flash`），再按家族
 *   关键字认目录外的名字；两个家族同时命中视为认不出，不替用户瞎猜。
 * 被否决：只认目录 —— 绝大多数用户接的是中转站，模型名由服务商决定（见下方 customModelNamePattern 注释）。
 */
export const inferProviderFromModel = (model?: string | null): Provider | null => {
  const candidate = canonicalizeModelAlias(model ?? '')

  if (!candidate || isToolCardModel(candidate) || isLocalModelToken(candidate)) {
    return null
  }

  const catalogProviders = new Set(
    MODEL_OPTIONS.filter((option) => !TOOL_CARD_MODELS.has(option.model))
      .filter((option) =>
        [option.model, option.label, ...(option.aliases ?? [])]
          .filter(Boolean)
          .map(canonicalizeModelAlias)
          .includes(candidate),
      )
      .map((option) => option.provider),
  )

  if (catalogProviders.size === 1) {
    return [...catalogProviders][0]!
  }

  const familyProviders = PROVIDER_FAMILY_PATTERNS.filter(([, pattern]) => pattern.test(candidate)).map(
    ([provider]) => provider,
  )

  return familyProviders.length === 1 ? familyProviders[0]! : null
}

// 症状：2026-08-14 用户的两名同事「很久都用不了 codex」，报错是服务商回的
//   `unknown provider for model gpt-5.6-sol`——那正是 DEFAULT_CODEX_MODEL。
// 根因：MODEL_OPTIONS 是我们维护的几个官方模型，而绝大多数用户接的是中转站，模型名由
//   服务商决定。旧实现下 `/model gpt-5.4` 被 resolveSlashModel 判 null 后直接拒掉
//   （App.tsx 的 'model' 分支），下拉里也只有 5.6 三兄弟 + 5.5，于是服务商不上架这几个
//   的用户开箱即死，唯一活路是自己找到 设置→模型 里那个自由文本框。
// 为什么不因为"怕用户拼错"继续拒：拼错的代价是发出去后服务商回一句错（现在还会被
//   describeCodexUpstreamFailure 翻译成人话），拒绝的代价是这个人永远用不了。不对称。
// 形状约束的意义不是校验模型是否存在（那只有服务商知道），而是挡住明显不是模型名的输入，
//   避免把一整句话或工具卡令牌写进 card.model。
const customModelNamePattern = /^[A-Za-z0-9][\w.:+\-/]{1,63}$/

// 本地模型条目在选择器里用令牌代表，真实模型名与端点留在 settings.localModelEntries，
// 由后端最上游翻译一次（server/providers.ts 的 launchProviderRun），下游 argv 与流解析器无感。
// 前缀刻意用 `__` 开头：上面的 customModelNamePattern 要求首字符是字母数字，于是用户无法
// 通过 `/model __local__:xxx` 手打出指向不存在条目的令牌 —— 与 TOOL_CARD_MODELS 同款护栏。
export const LOCAL_MODEL_TOKEN_PREFIX = '__local__:'

export const buildLocalModelToken = (id: string) => `${LOCAL_MODEL_TOKEN_PREFIX}${id}`

export const parseLocalModelToken = (model?: string | null): string | null => {
  const trimmed = (model ?? '').trim()
  if (!trimmed.startsWith(LOCAL_MODEL_TOKEN_PREFIX)) {
    return null
  }

  return trimmed.slice(LOCAL_MODEL_TOKEN_PREFIX.length) || null
}

export const isLocalModelToken = (model?: string | null) => parseLocalModelToken(model) !== null

export const buildLocalModelOptions = (entries: LocalModelEntry[]): ModelOption[] =>
  entries.map((entry) => ({
    label: entry.label || entry.model,
    provider: entry.harness,
    model: buildLocalModelToken(entry.id),
  }))

export const resolveSlashModelInput = (
  provider: Provider,
  input: string,
): { model: string; custom: boolean } | null => {
  const alias = resolveSlashModel(provider, input)
  if (alias !== null) {
    return { model: alias, custom: false }
  }

  const trimmed = input.trim()
  // 工具卡令牌当成模型名会造出空壳卡（见 TOOL_CARD_MODELS 上方注释）。首字符限制其实已经
  // 挡掉了 `__git_tool__`，这里保留显式判断，免得将来令牌换个写法就漏进来。
  if (!customModelNamePattern.test(trimmed) || isToolCardModel(trimmed)) {
    return null
  }

  return { model: trimmed, custom: true }
}

// ---------------------------------------------------------------------------
// 可选模型目录（SPEC agent-model-choice）
//
// 超管 create_session 把这份目录塞给 MCP 子进程，agent 才知道自己能选什么。
// 三个来源按顺序合并、按 provider+model 去重：
//   1. 模型目录里对选择器可见的真实模型（排除工具卡 / hiddenFromPicker / "用默认"占位项）
//   2. 各 provider 在设置里配置的默认模型 —— 即使它已从选择器下架（用户当前就是
//      claude-fable-5），或是目录里根本没有的自定义名，也必须可选，否则"默认"本身选不到
//   3. 本地模型条目，以 `__local__:<id>` 令牌出现，标签取条目名
// ---------------------------------------------------------------------------
export type SelectableModel = {
  provider: Provider
  model: string
  label: string
}

export const listSelectableModelCatalog = (settings: {
  requestModels: Partial<Record<Provider, string>>
  localModelEntries: LocalModelEntry[]
}): SelectableModel[] => {
  const seen = new Set<string>()
  const catalog: SelectableModel[] = []
  const push = (entry: SelectableModel) => {
    const key = `${entry.provider} ${entry.model}`
    if (!entry.model || seen.has(key)) return
    seen.add(key)
    catalog.push(entry)
  }

  for (const option of MODEL_OPTIONS) {
    if (isModelPickerOptionVisible(option) && !option.usesConfiguredDefault) {
      push({ provider: option.provider, model: option.model, label: option.label })
    }
  }

  for (const provider of ['codex', 'claude', 'gemini'] as const) {
    const configured = normalizeStoredModel(provider, settings.requestModels[provider])
    if (!configured || isLocalModelToken(configured)) continue
    const known = MODEL_OPTIONS.find((option) => option.provider === provider && option.model === configured)
    push({ provider, model: configured, label: known?.label ?? 'configured default' })
  }

  for (const option of buildLocalModelOptions(settings.localModelEntries)) {
    push({ provider: option.provider, model: option.model, label: option.label })
  }

  return catalog
}

// ---------------------------------------------------------------------------
// 会话卡模型下拉的选项（SPEC model-picker-customization）
//
// 用户可以在设置里关掉内置项、勾回已下架的型号、额外加自定义模型名。覆盖表只记改过的项，
// 没碰过的继续跟随 hiddenFromPicker。isModelPickerOptionVisible 仍是「内置可见性」——
// 看板与超管目录不受这份个人偏好影响。
// ---------------------------------------------------------------------------
export type ModelPickerCustomization = {
  visibility?: Record<string, boolean>
  customModels?: ModelPickerCustomModel[]
}

export const getModelPickerOptionKey = (option: Pick<ModelOption, 'provider' | 'model'>) =>
  `${option.provider}:${option.model}`

export const isModelPickerOptionEnabled = (
  option: Pick<ModelOption, 'provider' | 'model' | 'hiddenFromPicker'>,
  visibility?: Record<string, boolean>,
) => {
  if (TOOL_CARD_MODELS.has(option.model)) {
    return false
  }

  const override = visibility?.[getModelPickerOptionKey(option)]
  return typeof override === 'boolean' ? override : !option.hiddenFromPicker
}

/** 设置面板里列出来让用户勾选的内置项：除工具卡外的整份目录（含已下架与「默认」项）。 */
export const listConfigurableModelPickerOptions = () =>
  MODEL_OPTIONS.filter((option) => !TOOL_CARD_MODELS.has(option.model))

export const isValidCustomPickerModelName = (model: string) => {
  const trimmed = model.trim()
  return customModelNamePattern.test(trimmed) && !isToolCardModel(trimmed) && !isLocalModelToken(trimmed)
}

const VARIANT_EFFORT_ORDER: Record<string, number> = {
  ultra: 1,
  max: 2,
  xhigh: 3,
  high: 4,
  medium: 5,
  low: 6,
  minimal: 7,
  auto: 8,
}

type ParsedPickerModelSeries = {
  series: string
  version: number[]
  variantRank: number
  variantOrder: number
}

const stripModelQualifierSuffixes = (raw: string) => {
  let core = raw
  let isPreview = false
  let hasThinking = false
  let effortOrder = 0
  let hasSnapshot = false

  while (true) {
    const snapshotMatch = core.match(/^(.+)-(\d{8})$/)
    if (snapshotMatch) {
      core = snapshotMatch[1]!
      hasSnapshot = true
      continue
    }
    const previewMatch = core.match(/^(.+)-preview$/)
    if (previewMatch) {
      core = previewMatch[1]!
      isPreview = true
      continue
    }
    const thinkingEffortMatch = core.match(
      /^(.+)-thinking-(minimal|low|medium|high|xhigh|max|ultra|auto)$/,
    )
    if (thinkingEffortMatch) {
      core = thinkingEffortMatch[1]!
      hasThinking = true
      effortOrder = VARIANT_EFFORT_ORDER[thinkingEffortMatch[2]!] ?? 0
      continue
    }
    const thinkingMatch = core.match(/^(.+)-thinking$/)
    if (thinkingMatch) {
      core = thinkingMatch[1]!
      hasThinking = true
      continue
    }
    const effortMatch = core.match(/^(.+)-(minimal|low|medium|high|xhigh|max|ultra)$/)
    if (effortMatch) {
      core = effortMatch[1]!
      hasThinking = true
      effortOrder = VARIANT_EFFORT_ORDER[effortMatch[2]!] ?? 0
      continue
    }
    break
  }

  const variantRank = hasSnapshot ? 3 : hasThinking ? 2 : isPreview ? 1 : 0
  return { core, variantRank, variantOrder: effortOrder }
}

const parsePickerModelSeriesCore = (provider: Provider, model: string, keepQualifiers: boolean): ParsedPickerModelSeries | null => {
  let lower = model.trim().toLowerCase().replace(/^models\//, '')
  if (provider === 'claude') lower = lower.replace(/^anthropic\//, '')
  else if (provider === 'codex') lower = lower.replace(/^openai\//, '')
  else if (provider === 'gemini') lower = lower.replace(/^google\//, '')

  // 效果档 / 思考后缀可能就是型号名本身（如 gemini-4-ultra），剥掉后解析失败时由调用方用原名重试。
  const { core, variantRank, variantOrder } = keepQualifiers
    ? { core: lower, variantRank: 0, variantOrder: 0 }
    : stripModelQualifierSuffixes(lower)

  if (provider === 'claude') {
    const modern = core.match(/^claude-([a-z]+)-(\d+)(?:[.-](\d+))?$/)
    if (modern) {
      return {
        series: `claude:${modern[1]}`,
        version: [Number(modern[2]), Number(modern[3] ?? 0)],
        variantRank,
        variantOrder,
      }
    }
    const legacy = core.match(/^claude-(\d+)(?:[.-](\d+))?-([a-z]+)$/)
    if (legacy) {
      return {
        series: `claude:${legacy[3]}`,
        version: [Number(legacy[1]), Number(legacy[2] ?? 0)],
        variantRank,
        variantOrder,
      }
    }
    return null
  }

  if (provider === 'codex') {
    const gpt = core.match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z][a-z0-9-]*))?$/)
    if (gpt) {
      const [major, minor = 0] = gpt[1]!.split('.').map(Number)
      return {
        series: `codex:${gpt[2] ?? 'base'}`,
        version: [major!, minor],
        variantRank,
        variantOrder,
      }
    }
    const oSeries = core.match(/^o(\d+)(?:-([a-z][a-z0-9-]*))?$/)
    if (oSeries) {
      return {
        series: `codex:o-${oSeries[2] ?? 'base'}`,
        version: [Number(oSeries[1]), 0],
        variantRank,
        variantOrder,
      }
    }
    return null
  }

  const gemini = core.match(/^gemini-(\d+(?:\.\d+)?)-([a-z][a-z0-9-]*)$/)
  if (gemini) {
    const [major, minor = 0] = gemini[1]!.split('.').map(Number)
    return {
      series: `gemini:${gemini[2]}`,
      version: [major!, minor],
      variantRank,
      variantOrder,
    }
  }
  return null
}

const parsePickerModelSeries = (provider: Provider, model: string): ParsedPickerModelSeries | null =>
  parsePickerModelSeriesCore(provider, model, false) ?? parsePickerModelSeriesCore(provider, model, true)

const compareModelVersions = (left: number[], right: number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const compareModelVersionsDesc = (left: number[], right: number[]) => compareModelVersions(right, left)

const sortProviderPickerOptions = (provider: Provider, items: ModelOption[]): ModelOption[] => {
  if (items.length <= 1) return items

  // 从整份内置目录（含已下架项）采集该 provider 下已知系列的顺序与最高主版本，
  // 这样即使某系列当前主推型号被隐藏，同系列的新型号或变体依然能锚定到正确位置。
  const catalogIndexByKey = new Map<string, number>()
  const builtInSeriesMeta = new Map<
    string,
    { orderIndex: number; maxMajor: number; entries: { key: string; builtInRank: number; version: number[] }[] }
  >()
  const builtInSeriesOrder: { series: string; maxMajor: number }[] = []

  for (const option of MODEL_OPTIONS) {
    if (option.provider !== provider || option.usesConfiguredDefault || TOOL_CARD_MODELS.has(option.model)) {
      continue
    }
    const key = getModelPickerOptionKey(option)
    catalogIndexByKey.set(key, catalogIndexByKey.size)
    const parsed = parsePickerModelSeries(provider, option.model)
    if (!parsed) continue
    const major = parsed.version[0] ?? 0
    const existing = builtInSeriesMeta.get(parsed.series)
    if (!existing) {
      const orderIndex = builtInSeriesOrder.length
      builtInSeriesMeta.set(parsed.series, {
        orderIndex,
        maxMajor: major,
        entries: [{ key, builtInRank: 0, version: parsed.version }],
      })
      builtInSeriesOrder.push({ series: parsed.series, maxMajor: major })
    } else {
      existing.entries.push({ key, builtInRank: existing.entries.length, version: parsed.version })
      if (major > existing.maxMajor) {
        existing.maxMajor = major
        builtInSeriesOrder[existing.orderIndex]!.maxMajor = major
      }
    }
  }

  const resolveKnownSeriesPrefix = (series: string): string => {
    if (builtInSeriesMeta.has(series)) return series
    const prefix = `${provider}:`
    if (!series.startsWith(prefix)) return series
    const suffix = series.slice(prefix.length)
    let bestMatch = ''
    for (const candidate of builtInSeriesMeta.keys()) {
      const candidateSuffix = candidate.slice(prefix.length)
      if (suffix.startsWith(`${candidateSuffix}-`) && candidateSuffix.length > bestMatch.length) {
        bestMatch = candidateSuffix
      }
    }
    return bestMatch ? `${prefix}${bestMatch}` : series
  }

  const customSeriesFirstIndex = new Map<string, number>()
  const decorated = items.map((option, index) => {
    const key = getModelPickerOptionKey(option)
    const catalogIndex = catalogIndexByKey.get(key)
    const rawParsed =
      parsePickerModelSeries(provider, option.model) ??
      (option.label && option.label !== option.model
        ? parsePickerModelSeries(provider, canonicalizeModelAlias(option.label))
        : null)
    const parsed = rawParsed
      ? { ...rawParsed, series: resolveKnownSeriesPrefix(rawParsed.series) }
      : null

    if (!parsed) {
      return {
        option,
        primaryRank: Number.MAX_SAFE_INTEGER,
        tierGroupOrder: index,
        slotNumber: 0,
        version: [] as number[],
        variantRank: 0,
        variantOrder: 0,
        tieBreaker: catalogIndex ?? items.length + index,
      }
    }

    const builtIn = builtInSeriesMeta.get(parsed.series)
    if (builtIn) {
      const catalogMatch = builtIn.entries.find((entry) => entry.key === key)
      let slotNumber: number
      if (catalogMatch) {
        slotNumber = catalogMatch.builtInRank * 2
      } else {
        const sameVersionMatch = builtIn.entries.find(
          (entry) => compareModelVersions(entry.version, parsed.version) === 0,
        )
        if (sameVersionMatch) {
          slotNumber = sameVersionMatch.builtInRank * 2 + 1
        } else {
          const olderEntry = builtIn.entries.find(
            (entry) => compareModelVersions(entry.version, parsed.version) < 0,
          )
          slotNumber = olderEntry ? olderEntry.builtInRank * 2 - 1 : builtIn.entries.length * 2 + 1
        }
      }
      return {
        option,
        primaryRank: builtIn.orderIndex * 2,
        tierGroupOrder: 0,
        slotNumber,
        version: parsed.version,
        variantRank: parsed.variantRank,
        variantOrder: parsed.variantOrder,
        tieBreaker: catalogIndex ?? items.length + index,
      }
    }

    // 新系列（不在内置目录里）：按主版本放到同代内置系列之后、更低代际之前，
    // 同一新系列内的多个变体共享同一个 tierGroupOrder 以保证挨在一起。
    const major = parsed.version[0] ?? 0
    let lastAnchorIndex = -1
    for (let i = 0; i < builtInSeriesOrder.length; i += 1) {
      if (builtInSeriesOrder[i]!.maxMajor >= major) {
        lastAnchorIndex = i
      }
    }

    let customGroup = customSeriesFirstIndex.get(parsed.series)
    if (customGroup === undefined) {
      customGroup = customSeriesFirstIndex.size
      customSeriesFirstIndex.set(parsed.series, customGroup)
    }

    return {
      option,
      primaryRank: lastAnchorIndex >= 0 ? lastAnchorIndex * 2 + 1 : -1,
      tierGroupOrder: customGroup,
      slotNumber: 0,
      version: parsed.version,
      variantRank: parsed.variantRank,
      variantOrder: parsed.variantOrder,
      tieBreaker: index,
    }
  })

  decorated.sort((left, right) => {
    if (left.primaryRank !== right.primaryRank) {
      return left.primaryRank - right.primaryRank
    }
    if (left.tierGroupOrder !== right.tierGroupOrder) {
      return left.tierGroupOrder - right.tierGroupOrder
    }
    if (left.slotNumber !== right.slotNumber) {
      return left.slotNumber - right.slotNumber
    }
    const versionDiff = compareModelVersionsDesc(left.version, right.version)
    if (versionDiff !== 0) {
      return versionDiff
    }
    if (left.variantRank !== right.variantRank) {
      return left.variantRank - right.variantRank
    }
    if (left.variantOrder !== right.variantOrder) {
      return left.variantOrder - right.variantOrder
    }
    return left.tieBreaker - right.tieBreaker
  })

  return decorated.map((entry) => entry.option)
}

export const buildModelPickerOptions = ({
  localModelEntries = [],
  customization,
  current,
  mode = 'chat',
}: {
  localModelEntries?: LocalModelEntry[]
  customization?: ModelPickerCustomization
  current: { provider: Provider; model: string }
  mode?: 'chat' | 'brainstorm'
}): ModelOption[] => {
  const currentModel = normalizeStoredModel(current.provider, current.model)
  const currentKey = `${current.provider}:${currentModel}`
  const seen = new Set<string>()
  const options: ModelOption[] = []
  const push = (option: ModelOption) => {
    const key = getModelPickerOptionKey(option)
    if (seen.has(key) || (mode === 'brainstorm' && option.usesConfiguredDefault)) return
    seen.add(key)
    options.push(option)
  }

  // 本地条目代表本机端点而非云端同系列型号，继续排在最前。
  if (mode === 'chat') {
    buildLocalModelOptions(localModelEntries).forEach(push)
  }

  // 各 provider 的「跟随默认」占位项保持在具体型号之前。
  if (mode === 'chat') {
    for (const option of MODEL_OPTIONS) {
      if (!option.usesConfiguredDefault) continue
      if (
        isModelPickerOptionEnabled(option, customization?.visibility) ||
        getModelPickerOptionKey(option) === currentKey
      ) {
        push(option)
      }
    }
  }

  // 自定义项、当前未入库型号与已启用内置项按 provider + 同系列合并排列，不再把自定义项整体堆在顶部。
  const providerPool: Record<Provider, ModelOption[]> = { codex: [], claude: [], gemini: [] }
  const poolKeys = new Set<string>()
  const pushToPool = (option: ModelOption) => {
    const key = getModelPickerOptionKey(option)
    if (seen.has(key) || poolKeys.has(key) || option.usesConfiguredDefault || TOOL_CARD_MODELS.has(option.model)) {
      return
    }
    poolKeys.add(key)
    providerPool[option.provider].push(option)
  }

  for (const entry of customization?.customModels ?? []) {
    pushToPool({ provider: entry.provider, model: entry.model, label: entry.label || entry.model })
  }
  // 当前卡模型不在目录里（`/model` 手打或设置里填的自定义名）：临时补一项，否则按钮显示
  // 与列表对不上、滚轮也找不到起点。本地令牌例外——条目被删时不该把令牌暴露给用户。
  const catalogued = MODEL_OPTIONS.some(
    (option) => option.provider === current.provider && option.model === currentModel,
  )
  if (currentModel && !catalogued && !isLocalModelToken(currentModel)) {
    pushToPool({ provider: current.provider, model: currentModel, label: currentModel })
  }
  // 当前选中的内置项即使被关掉/已下架也保留，不恢复其他下架项。
  for (const option of MODEL_OPTIONS) {
    if (option.usesConfiguredDefault || TOOL_CARD_MODELS.has(option.model)) continue
    if (
      isModelPickerOptionEnabled(option, customization?.visibility) ||
      getModelPickerOptionKey(option) === currentKey
    ) {
      pushToPool(option)
    }
  }

  for (const provider of ['codex', 'claude', 'gemini'] as const) {
    sortProviderPickerOptions(provider, providerPool[provider]).forEach(push)
  }

  return options
}

export type ReasoningDefaultModel = {
  provider: Provider
  model: string
  label: string
  isConfiguredDefault: boolean
}

/**
 * 设置「默认思考档位」表要列的模型（SPEC pin-new-session-defaults）：设置默认模型置顶，
 * 其余跟会话卡模型下拉同一份可见范围（含用户自定义项），用户在下拉里关掉的不列。
 * Gemini 只有「自动」一档，没东西可设，不列。
 */
export const listReasoningDefaultModels = (settings: {
  requestModels: Partial<Record<Provider, string>>
  modelPickerVisibility?: Record<string, boolean>
  modelPickerCustomModels?: ModelPickerCustomModel[]
}): ReasoningDefaultModel[] => {
  const entries: ReasoningDefaultModel[] = []

  for (const provider of ['codex', 'claude'] as const) {
    const configured = normalizeStoredModel(provider, settings.requestModels[provider]) || getDefaultModel(provider)
    const seen = new Set<string>()
    const push = (model: string, label: string, isConfiguredDefault: boolean) => {
      if (!model || seen.has(model) || isLocalModelToken(model) || TOOL_CARD_MODELS.has(model)) return
      seen.add(model)
      entries.push({ provider, model, label, isConfiguredDefault })
    }

    push(
      configured,
      MODEL_OPTIONS.find((option) => option.provider === provider && option.model === configured)?.label ?? configured,
      true,
    )
    for (const option of buildModelPickerOptions({
      customization: {
        visibility: settings.modelPickerVisibility,
        customModels: settings.modelPickerCustomModels,
      },
      current: { provider, model: configured },
    })) {
      if (option.provider === provider && !option.usesConfiguredDefault) {
        push(option.model, option.label, false)
      }
    }
  }

  return entries
}

/**
 * 滚轮步进：direction 1 = 上一项（向上滚），-1 = 下一项；到头返回 null，不循环
 * （快速连滚时循环会从最后一项跳回第一项，比停住更让人迷惑）。
 */
export const stepModelPickerOption = (
  options: Pick<ModelOption, 'provider' | 'model'>[],
  currentKey: string,
  direction: 1 | -1,
): string | null => {
  if (options.length === 0) return null
  const index = options.findIndex((option) => getModelPickerOptionKey(option) === currentKey)
  if (index < 0) {
    // 找不到起点（例如列表刚被设置改过）：往下滚从第一项开始，往上滚从最后一项开始。
    return getModelPickerOptionKey(options[direction === 1 ? options.length - 1 : 0]!)
  }
  const target = options[index - direction]
  return target ? getModelPickerOptionKey(target) : null
}
