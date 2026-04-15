import type { Provider } from './schema.js'

export const DEFAULT_CODEX_MODEL = 'gpt-5.4'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-6'
export const DEFAULT_GIT_AGENT_MODEL = `${DEFAULT_CODEX_MODEL} xhigh`
export const GIT_TOOL_MODEL = '__git_tool__'
export const MUSIC_TOOL_MODEL = '__music_tool__'
export const WHITENOISE_TOOL_MODEL = '__whitenoise_tool__'
export const WEATHER_TOOL_MODEL = '__weather_tool__'
export const STICKYNOTE_TOOL_MODEL = '__stickynote_tool__'
export const FILETREE_TOOL_MODEL = '__filetree_tool__'
export const BRAINSTORM_TOOL_MODEL = '__brainstorm_tool__'
export const TEXTEDITOR_TOOL_MODEL = '__texteditor_tool__'
// Legacy-only token kept so persisted PM cards can be demoted safely during load.
export const PM_TOOL_MODEL = '__pm_tool__'

export type ModelOption = {
  label: string
  provider: Provider
  model: string
  aliases?: string[]
  usesConfiguredDefault?: boolean
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
    label: 'GPT-5.4',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    aliases: ['gpt-5.4', '5.4', 'gpt54'],
  },
  {
    label: 'Opus 4.6',
    provider: 'claude',
    model: DEFAULT_CLAUDE_MODEL,
    aliases: ['opus', 'opus-4.6', 'claude-opus-4-6'],
  },
  {
    label: 'Sonnet 4.6',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    aliases: ['sonnet', 'sonnet-4.6', 'claude-sonnet-4-6'],
  },
  {
    label: 'Haiku 4.5',
    provider: 'claude',
    model: 'claude-haiku-4-5-20251001',
    aliases: ['haiku', 'haiku-4.5', 'claude-haiku-4-5-20251001'],
  },
]

const legacyCodexModels = new Set(['gpt-4.5', '__dream_tool__'])

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
