import type { LocalModelEntry, Provider } from './schema.js'

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'
export const DEFAULT_GIT_AGENT_MODEL = 'gpt-5.6-terra medium'
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
    label: 'GPT-5.6 Sol',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    aliases: ['gpt-5.6', 'gpt-5.6-sol', '5.6', '5.6-sol', 'sol', 'gpt56'],
  },
  {
    label: 'GPT-5.6 Terra',
    provider: 'codex',
    model: 'gpt-5.6-terra',
    aliases: ['gpt-5.6-terra', '5.6-terra', 'terra'],
  },
  {
    label: 'GPT-5.6 Luna',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    aliases: ['gpt-5.6-luna', '5.6-luna', 'luna'],
  },
  {
    label: 'GPT-5.5',
    provider: 'codex',
    model: 'gpt-5.5',
    aliases: ['gpt-5.5', '5.5', 'gpt55'],
  },
  {
    // Mythos-class tier above Opus; never the default. Bare "fable" follows the
    // newest Fable generation, like bare "opus"/"sonnet" do.
    label: 'Fable 5.1',
    provider: 'claude',
    model: 'claude-fable-5-1',
    aliases: ['fable', 'fable-5.1', 'claude-fable-5-1'],
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
    label: 'Opus 5',
    provider: 'claude',
    model: DEFAULT_CLAUDE_MODEL,
    aliases: ['opus', 'opus-5', 'claude-opus-5'],
  },
  {
    // Bare "sonnet" follows the official alias to Sonnet 5 (native 1M window).
    label: 'Sonnet 5',
    provider: 'claude',
    model: 'claude-sonnet-5',
    aliases: ['sonnet', 'sonnet-5', 'claude-sonnet-5'],
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
    label: 'Haiku 4.5',
    provider: 'claude',
    model: 'claude-haiku-4-5-20251001',
    aliases: ['haiku', 'haiku-4.5', 'claude-haiku-4-5-20251001'],
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

export const getDefaultModel = (provider: Provider) =>
  provider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL

export const getModelOptions = (provider: Provider) =>
  MODEL_OPTIONS.filter((option) => option.provider === provider)

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
