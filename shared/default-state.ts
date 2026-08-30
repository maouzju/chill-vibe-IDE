import type {
  AppLanguage,
  AppFontFamily,
  AppSettings,
  AppState,
  AutoUrgeProfile,
  AutomationBoardLane,
  AutomationBoardTemplate,
  AutomationBoardWorkspaceState,
  BoardColumn,
  ChatCard,
  ChatMessage,
  ChatRole,
  CloseBehavior,
  LayoutNode,
  LocalModelEntry,
  PaneNode,
  Provider,
  RecentCrashRecovery,
  SessionHistoryEntry,
  SplitDirection,
  SplitNode,
  StickyNoteArchiveEntry,
  StickyNoteViewState,
  WakeTimerMode,
} from './schema.js'
import { createDefaultBrainstormState } from './brainstorm.js'
import {
  closeBehaviorSchema,
  createDefaultAutomationBoardTemplateTrigger,
  defaultAutomationBoardSupervisorRequirement,
  defaultAutoUrgeMessage,
  defaultAutoUrgeProfileId,
  defaultAutoUrgeSuccessKeyword,
  defaultWakeTimerDurationMinutes,
  maxWakeTimerDurationMinutes,
  minWakeTimerDurationMinutes,
  wakeTimerModes,
  autoUrgeJudgeModes,
} from './schema.js'
import { summarizeTurnUsage } from './turn-telemetry-summary.js'
import {
  defaultAppLanguage,
  getLocaleText,
  normalizeLanguage,
} from './i18n.js'
import {
  AUTOMATIONBOARD_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GIT_AGENT_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STATS_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  getDefaultModel,
  isToolCardModel,
  normalizeModel,
  normalizeStoredModel,
} from './models.js'
import { normalizeReasoningEffortForModel } from './reasoning.js'
import { normalizeAccentColor } from './theme.js'
import {
  defaultSystemPrompt,
  normalizeModelPromptRules,
  normalizeSystemPrompt,
} from './system-prompt.js'

const now = () => new Date().toISOString()

export const defaultCardSize = 440
export const minCardSize = 320
export const defaultGitToolCardSize = 100
export const minGitToolCardSize = 1
export const defaultStickyNoteCardSize = 164
export const minStickyNoteCardSize = 96
export const stickyNoteArchiveMaxEntries = 50
export const stickyNoteArchiveMaxContentLength = 64_000
export const defaultWhiteNoiseCardSize = 286
export const minWhiteNoiseCardSize = 208
export const minWeatherCardSize = 160
// The board needs three lanes side by side plus a template strip, so it wants
// noticeably more vertical room than an ordinary chat card.
export const defaultAutomationBoardCardSize = 620
export const minAutomationBoardCardSize = 380
// A GitHub-style calendar needs roughly a year of week columns plus the summary
// tiles above it, so the stats card asks for more height than an ordinary card.
export const defaultStatsCardSize = 520
export const minStatsCardSize = 300
export const minColumnWidth = 130
export const minUiScale = 0.8
export const maxUiScale = 1.35
export const minFontScale = 0.85
export const maxFontScale = 1.35
export const minLineHeightScale = 0.75
export const maxLineHeightScale = 1.5

export const defaultAppFontFamily: AppFontFamily = 'default'

export const appFontFamilyOptions: ReadonlyArray<{
  value: AppFontFamily
  label: string
  labelEn: string
  css: string
}> = [
  {
    value: 'default',
    label: '默认字体',
    labelEn: 'Default font',
    css: "'Aptos', 'IBM Plex Sans', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  {
    value: 'system',
    label: '系统字体',
    labelEn: 'System sans',
    css: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  {
    value: 'aptos',
    label: 'Aptos',
    labelEn: 'Aptos',
    css: "Aptos, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  {
    value: 'segoe-ui',
    label: 'Segoe UI',
    labelEn: 'Segoe UI',
    css: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  {
    value: 'arial',
    label: 'Arial',
    labelEn: 'Arial',
    css: "Arial, Helvetica, sans-serif",
  },
  {
    value: 'microsoft-yahei',
    label: '微软雅黑',
    labelEn: 'Microsoft YaHei',
    css: "'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif",
  },
  {
    value: 'dengxian',
    label: '等线',
    labelEn: 'DengXian',
    css: "DengXian, 'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif",
  },
  {
    value: 'simsun',
    label: '宋体',
    labelEn: 'SimSun',
    css: "SimSun, '宋体', serif",
  },
  {
    value: 'simhei',
    label: '黑体',
    labelEn: 'SimHei',
    css: "SimHei, '黑体', 'Microsoft YaHei', sans-serif",
  },
  {
    value: 'kaiti',
    label: '楷体',
    labelEn: 'KaiTi',
    css: "KaiTi, '楷体', STKaiti, serif",
  },
  {
    value: 'fangsong',
    label: '仿宋',
    labelEn: 'FangSong',
    css: "FangSong, '仿宋', STFangsong, serif",
  },
  {
    value: 'serif',
    label: '衬线字体',
    labelEn: 'Serif',
    css: "Georgia, 'Times New Roman', SimSun, serif",
  },
  {
    value: 'georgia',
    label: 'Georgia',
    labelEn: 'Georgia',
    css: "Georgia, 'Times New Roman', SimSun, serif",
  },
  {
    value: 'times-new-roman',
    label: 'Times New Roman',
    labelEn: 'Times New Roman',
    css: "'Times New Roman', Times, SimSun, serif",
  },
  {
    value: 'mono',
    label: '等宽字体',
    labelEn: 'Monospace',
    css: "'IBM Plex Mono', 'Cascadia Mono', Consolas, monospace",
  },
  {
    value: 'cascadia-code',
    label: 'Cascadia Code',
    labelEn: 'Cascadia Code',
    css: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
  },
  {
    value: 'consolas',
    label: 'Consolas',
    labelEn: 'Consolas',
    css: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
  },
]

export const normalizeAppFontFamily = (value: unknown): AppFontFamily =>
  appFontFamilyOptions.some((option) => option.value === value) ? (value as AppFontFamily) : defaultAppFontFamily

export const resolveAppFontFamilyCss = (value: unknown): string =>
  appFontFamilyOptions.find((option) => option.value === normalizeAppFontFamily(value))?.css ??
  appFontFamilyOptions[0]!.css

export const createId = (): string => crypto.randomUUID()

const normalizePositiveRatio = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const roundSplitRatio = (value: number) => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000

export const normalizeSplitRatios = (ratios: number[] | undefined, childCount: number) => {
  if (childCount <= 0) {
    return []
  }

  const nextRatios =
    Array.isArray(ratios) && ratios.length === childCount
      ? ratios.map(normalizePositiveRatio)
      : Array.from({ length: childCount }, () => 1)
  const total = nextRatios.reduce((sum, ratio) => sum + ratio, 0)

  if (total <= 0) {
    return Array.from({ length: childCount }, () => 1 / childCount)
  }

  const normalized = nextRatios.map((ratio) => roundSplitRatio(ratio / total))
  const correctionIndex = normalized.findLastIndex((ratio) => ratio > 0)

  if (correctionIndex < 0) {
    return normalized
  }

  const correction =
    roundSplitRatio(1 - normalized.reduce((sum, ratio) => sum + ratio, 0))

  if (correction === 0) {
    return normalized
  }

  const nextNormalized = [...normalized]
  nextNormalized[correctionIndex] = roundSplitRatio((nextNormalized[correctionIndex] ?? 0) + correction)
  return nextNormalized
}

const roundScale = (value: number) => Math.round(value * 100) / 100

const clampScale = (value: unknown, min: number, max: number, fallback: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback
  }

  return roundScale(Math.min(max, Math.max(min, value)))
}

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
/**
 * 只用于「下一次发请求用哪个模型」这类设置（`requestModels` / `lastModel`）。
 * 工具卡模型（Git、便签、自动化看板……）不是可发请求的模型，落进这里就会被
 * 新建 tab 继承成一张空壳工具卡，所以一律退回该 provider 的默认模型。
 */
const normalizeRequestModel = (provider: Provider, model?: string | null) =>
  isToolCardModel(model) ? getDefaultModel(provider) : normalizeModel(provider, model)
const normalizeCodexPersonality = (value: unknown): AppSettings['codexPersonality'] =>
  value === 'none' || value === 'friendly' || value === 'pragmatic' ? value : 'default'
const normalizeGitAgentModel = (value: unknown, fallback: string) => {
  const trimmed = normalizeText(value)

  if (!trimmed) {
    return fallback
  }

  const [rawModel = '', ...rest] = trimmed.split(/\s+/)
  const normalizedModel = normalizeStoredModel('codex', rawModel)

  if (!normalizedModel || normalizedModel === rawModel) {
    return trimmed
  }

  return [normalizedModel, ...rest].join(' ')
}
export const createDefaultPmState = () => ({
  provider: 'codex' as const,
  model: DEFAULT_CODEX_MODEL,
})

const normalizeBaseUrl = (value: unknown) => normalizeText(value).replace(/\/+$/g, '')
const normalizeTopTab = (value: unknown): AppSettings['activeTopTab'] =>
  value === 'routing' || value === 'settings' ? value : 'ambience'

const createDefaultProviderProfiles = (): AppSettings['providerProfiles'] => ({
  codex: {
    activeProfileId: '',
    profiles: [],
  },
  claude: {
    activeProfileId: '',
    profiles: [],
  },
})

const createDefaultModelReasoningEfforts = (): AppSettings['modelReasoningEfforts'] => ({
  codex: {},
  claude: {},
})

export const getAutoUrgeProfileFallbackName = (
  language: AppLanguage = defaultAppLanguage,
  index = 0,
) => {
  if (language === 'en') {
    return index === 0 ? 'Default Type' : `Urge Type ${index + 1}`
  }

  return index === 0 ? '默认鞭策' : `鞭策类型 ${index + 1}`
}

const normalizeAutoUrgeMessage = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value : fallback

const normalizeAutoUrgeText = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value : fallback

const normalizeAutoUrgeJudgeMode = (value: unknown): AutoUrgeProfile['judgeMode'] =>
  typeof value === 'string' && (autoUrgeJudgeModes as readonly string[]).includes(value)
    ? (value as AutoUrgeProfile['judgeMode'])
    : 'keyword'

export const createAutoUrgeProfile = (
  language: AppLanguage = defaultAppLanguage,
  overrides: Partial<AutoUrgeProfile> = {},
  options: { index?: number; fallbackId?: string } = {},
): AutoUrgeProfile => ({
  id: normalizeText(overrides.id) || options.fallbackId || createId(),
  name: normalizeText(overrides.name) || getAutoUrgeProfileFallbackName(language, options.index ?? 0),
  message: normalizeAutoUrgeMessage(overrides.message, defaultAutoUrgeMessage),
  successKeyword: normalizeAutoUrgeText(overrides.successKeyword, defaultAutoUrgeSuccessKeyword),
  judgeMode: normalizeAutoUrgeJudgeMode(overrides.judgeMode),
  judgeModel: normalizeText(overrides.judgeModel),
})

const normalizeAutoUrgeSettings = (
  settings: Partial<AppSettings> | null | undefined,
  language: AppLanguage,
) => {
  const explicitProfiles = Array.isArray(settings?.autoUrgeProfiles) ? settings.autoUrgeProfiles : []
  const seenIds = new Set<string>()
  const normalizedProfiles = explicitProfiles.flatMap((profile, index) => {
    if (!profile || typeof profile !== 'object') {
      return []
    }

    const baseProfile = createAutoUrgeProfile(language, profile, {
      index,
      fallbackId: index === 0 ? defaultAutoUrgeProfileId : `auto-urge-profile-${index + 1}`,
    })

    let nextId = baseProfile.id
    let duplicateSuffix = 2
    while (seenIds.has(nextId)) {
      nextId = `${baseProfile.id}-${duplicateSuffix}`
      duplicateSuffix += 1
    }
    seenIds.add(nextId)

    return [{ ...baseProfile, id: nextId }]
  })

  const fallbackProfile = createAutoUrgeProfile(
    language,
    {
      id: defaultAutoUrgeProfileId,
      message: settings?.autoUrgeMessage,
      successKeyword: settings?.autoUrgeSuccessKeyword,
    },
    {
      index: 0,
      fallbackId: defaultAutoUrgeProfileId,
    },
  )

  const autoUrgeProfiles = normalizedProfiles.length > 0 ? normalizedProfiles : [fallbackProfile]
  const requestedActiveProfileId = normalizeText(settings?.autoUrgeActiveProfileId)
  const activeProfile =
    autoUrgeProfiles.find((profile) => profile.id === requestedActiveProfileId) ??
    autoUrgeProfiles[0] ??
    fallbackProfile

  const requestedGlobalProfileId = normalizeText(settings?.autoUrgeGlobalProfileId)
  const globalProfile =
    autoUrgeProfiles.find((profile) => profile.id === requestedGlobalProfileId) ?? activeProfile

  return {
    autoUrgeProfiles,
    autoUrgeActiveProfileId: activeProfile.id,
    autoUrgeMessage: activeProfile.message,
    autoUrgeSuccessKeyword: activeProfile.successKeyword,
    autoUrgeGlobalProfileId: globalProfile.id,
  }
}

const normalizeModelReasoningEfforts = (
  modelReasoningEfforts?: Partial<AppSettings['modelReasoningEfforts']> | null,
): AppSettings['modelReasoningEfforts'] => {
  const normalizeCollection = (provider: Provider) => {
    const collection = modelReasoningEfforts?.[provider]

    if (!collection || typeof collection !== 'object') {
      return {}
    }

    return Object.fromEntries(
      Object.entries(collection).flatMap(([model, reasoningEffort]) => {
        const normalizedModel = normalizeStoredModel(provider, model)

        if (!normalizedModel) {
          return []
        }

        return [[normalizedModel, normalizeReasoningEffortForModel(provider, normalizedModel, reasoningEffort)]]
      }),
    )
  }

  return {
    codex: normalizeCollection('codex'),
    claude: normalizeCollection('claude'),
  }
}

const normalizeProviderProfiles = (
  providerProfiles?: Partial<AppSettings['providerProfiles']> | null,
): AppSettings['providerProfiles'] => {
  const normalizeCollection = (
    collection: Partial<AppSettings['providerProfiles']['codex']> | null | undefined,
    fallbackPrefix: string,
  ) => {
    const profiles = Array.isArray(collection?.profiles)
      ? collection.profiles.map((profile, index) => ({
          id: normalizeText(profile?.id) || createId(),
          name: normalizeText(profile?.name) || `${fallbackPrefix} ${index + 1}`,
          apiKey: normalizeText(profile?.apiKey),
          baseUrl: normalizeBaseUrl(profile?.baseUrl),
        }))
      : []

    const activeProfileId = normalizeText(collection?.activeProfileId)

    return {
      activeProfileId: profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : '',
      profiles,
    }
  }

  return {
    codex: normalizeCollection(providerProfiles?.codex, 'Codex'),
    claude: normalizeCollection(providerProfiles?.claude, 'Claude'),
  }
}

export const createLocalModelEntry = (
  overrides: Partial<LocalModelEntry> = {},
  options: { fallbackId?: string } = {},
): LocalModelEntry => ({
  id: normalizeText(overrides.id) || options.fallbackId || createId(),
  label: normalizeText(overrides.label),
  // 默认 codex：claude harness 连本机模型时开销大一个数量级，且关不掉思考。
  // 详见 localModelEntrySchema 的注释与 docs/specs/local-model-entries/design.md 的实测表。
  harness: overrides.harness === 'claude' ? 'claude' : 'codex',
  baseUrl: normalizeBaseUrl(overrides.baseUrl),
  apiKey: normalizeText(overrides.apiKey),
  model: normalizeText(overrides.model),
})

export const normalizeLocalModelEntries = (
  entries?: LocalModelEntry[] | null,
): LocalModelEntry[] => {
  if (!Array.isArray(entries)) {
    return []
  }

  const seenIds = new Set<string>()
  return entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }

    const normalized = createLocalModelEntry(entry, { fallbackId: `local-model-${index + 1}` })
    // 没有真实模型名的条目跑不起来，留着只会在选择器里多一个选不动的选项。
    if (!normalized.model || seenIds.has(normalized.id)) {
      return []
    }

    seenIds.add(normalized.id)
    return [normalized]
  })
}

export const maxRecentWorkspaces = 20
export const maxSessionHistoryPerWorkspace = 50

const normalizeRecentWorkspaces = (
  items?: AppSettings['recentWorkspaces'] | null,
): AppSettings['recentWorkspaces'] => {
  if (!Array.isArray(items)) return []

  const seen = new Set<string>()
  return items
    .filter((item) => {
      if (!item?.path || typeof item.path !== 'string') return false
      const key = item.path.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (b.openedAt > a.openedAt ? 1 : b.openedAt < a.openedAt ? -1 : 0))
    .slice(0, maxRecentWorkspaces)
}

export const createDefaultEditorSettings = (): AppSettings['editor'] => ({
  fontSize: 13,
  wordWrap: false,
  minimap: false,
  tabSize: 2,
})

const normalizeEditorSettings = (
  editor: Partial<AppSettings['editor']> | null | undefined,
): AppSettings['editor'] => {
  const defaults = createDefaultEditorSettings()

  return {
    fontSize: clampScale(editor?.fontSize, 10, 24, defaults.fontSize),
    wordWrap: typeof editor?.wordWrap === 'boolean' ? editor.wordWrap : defaults.wordWrap,
    minimap: typeof editor?.minimap === 'boolean' ? editor.minimap : defaults.minimap,
    tabSize: editor?.tabSize === 4 ? 4 : defaults.tabSize,
  }
}

export const createDefaultSettings = (language: AppLanguage = defaultAppLanguage): AppSettings => ({
  language: normalizeLanguage(language),
  theme: 'dark',
  customThemeBase: 'dark',
  customBaseColor: null,
  accentColor: null,
  activeTopTab: 'ambience',
  editor: createDefaultEditorSettings(),
  uiScale: 1,
  fontFamily: defaultAppFontFamily,
  fontScale: 1,
  lineHeightScale: 1,
  resilientProxyEnabled: true,
  cliRoutingEnabled: true,
  resilientProxyStallTimeoutSec: 60,
  resilientProxyMaxRetries: 6,
  resilientProxyFirstByteTimeoutSec: 90,
  musicAlbumCoverEnabled: false,
  gitCardEnabled: true,
  fileTreeCardEnabled: true,
  stickyNoteCardEnabled: true,
  automationBoardCardEnabled: true,
  automationBoardCardDefaultApplied: true,
  pmCardEnabled: true,
  brainstormCardEnabled: false,
  experimentalMusicEnabled: false,
  experimentalWhiteNoiseEnabled: false,
  experimentalWeatherEnabled: false,
  experimentalStatsEnabled: false,
  agentDoneSoundEnabled: false,
  agentDoneSoundVolume: 0.7,
  allAgentsDoneSoundEnabled: false,
  allAgentsDoneSoundVolume: 0.7,
  crossProviderSkillReuseEnabled: true,
  accessibilitySupportEnabled: false,
  closeBehavior: 'quit',
  autoUrgeEnabled: false,
  autoUrgeProfiles: [
    createAutoUrgeProfile(language, {}, { index: 0, fallbackId: defaultAutoUrgeProfileId }),
  ],
  autoUrgeActiveProfileId: defaultAutoUrgeProfileId,
  autoUrgeMessage: defaultAutoUrgeMessage,
  autoUrgeSuccessKeyword: defaultAutoUrgeSuccessKeyword,
  autoUrgeGlobalControlEnabled: false,
  autoUrgeGlobalActive: false,
  autoUrgeGlobalProfileId: defaultAutoUrgeProfileId,
  repeatLoopEnabled: false,
  wakeTimerEnabled: true,
  wakeTimerDefaultMode: 'workspace-agents',
  wakeTimerDefaultDurationMinutes: defaultWakeTimerDurationMinutes,
  weatherCity: '',
  systemPrompt: defaultSystemPrompt,
  modelPromptRules: [],
  codexPersonality: 'default',
  codexFastMode: false,
  agentOutsideWorkspaceWriteEnabled: true,
  codexDestructiveCommandProtectionEnabled: true,
  codexIsolatedHomeEnabled: true,
  gitAgentModel: DEFAULT_GIT_AGENT_MODEL,
  requestModels: {
    codex: DEFAULT_CODEX_MODEL,
    claude: DEFAULT_CLAUDE_MODEL,
  },
  modelReasoningEfforts: createDefaultModelReasoningEfforts(),
  providerProfiles: createDefaultProviderProfiles(),
  localModelEntries: [],
  recentWorkspaces: [],
})

/**
 * 自动化看板 2026-08-17 从「实验性，默认关」转正为「默认开」。
 * 缺 `automationBoardCardDefaultApplied` 的存档一律视为转正前写下的，补发一次默认开；
 * 标记落盘之后，`automationBoardCardEnabled` 完全按用户的选择走。
 */
const normalizeAutomationBoardCardSettings = (
  settings: Partial<AppSettings> | null | undefined,
  defaults: AppSettings,
): Pick<AppSettings, 'automationBoardCardEnabled' | 'automationBoardCardDefaultApplied'> => {
  if (settings?.automationBoardCardDefaultApplied !== true) {
    return {
      automationBoardCardEnabled: true,
      automationBoardCardDefaultApplied: true,
    }
  }
  return {
    automationBoardCardEnabled:
      typeof settings.automationBoardCardEnabled === 'boolean'
        ? settings.automationBoardCardEnabled
        : defaults.automationBoardCardEnabled,
    automationBoardCardDefaultApplied: true,
  }
}

// 症状：v0.20.5 之前只有一个「关闭后最小化到任务栏」布尔开关，用户抱怨点 X 与点“—”无异。
// 根因：单一布尔无法表达“藏进托盘”这第三种期望，2026-08-17 改为三态枚举。
// 被否决的替代：直接删掉旧布尔 —— 老存档里勾过的用户会被静默改回“点 X 就退出”，
//   连带杀掉正在跑的 Agent，所以这里保留一次性回落读取。
const resolveCloseBehavior = (
  settings: Partial<AppSettings> | null | undefined,
  fallback: CloseBehavior,
): CloseBehavior => {
  const parsed = closeBehaviorSchema.safeParse(settings?.closeBehavior)
  if (parsed.success) {
    return parsed.data
  }

  if (settings?.minimizeToTaskbarOnCloseEnabled === true) {
    return 'minimize'
  }

  return fallback
}

export const normalizeAppSettings = (settings?: Partial<AppSettings> | null): AppSettings => {
  const language = normalizeLanguage(settings?.language)
  const defaults = createDefaultSettings(language)
  const autoUrgeSettings = normalizeAutoUrgeSettings(settings, language)
  const automationBoardSettings = normalizeAutomationBoardCardSettings(settings, defaults)

  return {
    language,
    theme:
      settings?.theme === 'light' || settings?.theme === 'system' || settings?.theme === 'custom'
        ? settings.theme
        : 'dark',
    customThemeBase: settings?.customThemeBase === 'light' ? 'light' : 'dark',
    customBaseColor: normalizeAccentColor(settings?.customBaseColor),
    accentColor: normalizeAccentColor(settings?.accentColor),
    activeTopTab: normalizeTopTab(settings?.activeTopTab),
    editor: normalizeEditorSettings(settings?.editor),
    uiScale: clampScale(settings?.uiScale, minUiScale, maxUiScale, defaults.uiScale),
    fontFamily: normalizeAppFontFamily(settings?.fontFamily),
    fontScale: clampScale(settings?.fontScale, minFontScale, maxFontScale, defaults.fontScale),
    lineHeightScale: clampScale(
      settings?.lineHeightScale,
      minLineHeightScale,
      maxLineHeightScale,
      defaults.lineHeightScale,
    ),
    resilientProxyEnabled:
      typeof settings?.resilientProxyEnabled === 'boolean'
        ? settings.resilientProxyEnabled
        : defaults.resilientProxyEnabled,
    cliRoutingEnabled:
      typeof settings?.cliRoutingEnabled === 'boolean'
        ? settings.cliRoutingEnabled
        : defaults.cliRoutingEnabled,
    resilientProxyStallTimeoutSec: clampScale(
      settings?.resilientProxyStallTimeoutSec,
      10,
      300,
      defaults.resilientProxyStallTimeoutSec,
    ),
    resilientProxyMaxRetries:
      typeof settings?.resilientProxyMaxRetries === 'number' &&
      Number.isInteger(settings.resilientProxyMaxRetries) &&
      settings.resilientProxyMaxRetries >= -1 &&
      settings.resilientProxyMaxRetries <= 50
        ? settings.resilientProxyMaxRetries
        : defaults.resilientProxyMaxRetries,
    resilientProxyFirstByteTimeoutSec: clampScale(
      settings?.resilientProxyFirstByteTimeoutSec,
      30,
      600,
      defaults.resilientProxyFirstByteTimeoutSec,
    ),
    musicAlbumCoverEnabled:
      typeof settings?.musicAlbumCoverEnabled === 'boolean'
        ? settings.musicAlbumCoverEnabled
        : defaults.musicAlbumCoverEnabled,
    gitCardEnabled:
      typeof settings?.gitCardEnabled === 'boolean'
        ? settings.gitCardEnabled
        : defaults.gitCardEnabled,
    fileTreeCardEnabled:
      typeof settings?.fileTreeCardEnabled === 'boolean'
        ? settings.fileTreeCardEnabled
        : defaults.fileTreeCardEnabled,
    stickyNoteCardEnabled:
      typeof settings?.stickyNoteCardEnabled === 'boolean'
        ? settings.stickyNoteCardEnabled
        : defaults.stickyNoteCardEnabled,
    // 症状：把看板默认值从 false 翻成 true 对已安装用户没有任何效果。
    // 根因：normalizeAppSettings 每次保存都把当时的默认值写回 state.json，所以老存档里的
    //   `automationBoardCardEnabled: false` 既可能是用户关的、也可能只是旧默认，事后无法区分。
    // 被否决的替代：无条件强制 true —— 那样用户永远关不掉。改用一次性迁移标记补发一次默认值。
    automationBoardCardEnabled: automationBoardSettings.automationBoardCardEnabled,
    automationBoardCardDefaultApplied: automationBoardSettings.automationBoardCardDefaultApplied,
    pmCardEnabled:
      typeof settings?.pmCardEnabled === 'boolean'
        ? settings.pmCardEnabled
        : defaults.pmCardEnabled,
    brainstormCardEnabled:
      typeof settings?.brainstormCardEnabled === 'boolean'
        ? settings.brainstormCardEnabled
        : defaults.brainstormCardEnabled,
    experimentalMusicEnabled:
      typeof settings?.experimentalMusicEnabled === 'boolean'
        ? settings.experimentalMusicEnabled
        : defaults.experimentalMusicEnabled,
    experimentalWhiteNoiseEnabled:
      typeof settings?.experimentalWhiteNoiseEnabled === 'boolean'
        ? settings.experimentalWhiteNoiseEnabled
        : defaults.experimentalWhiteNoiseEnabled,
    experimentalWeatherEnabled:
      typeof settings?.experimentalWeatherEnabled === 'boolean'
        ? settings.experimentalWeatherEnabled
        : defaults.experimentalWeatherEnabled,
    experimentalStatsEnabled:
      typeof settings?.experimentalStatsEnabled === 'boolean'
        ? settings.experimentalStatsEnabled
        : defaults.experimentalStatsEnabled,
    agentDoneSoundEnabled:
      typeof settings?.agentDoneSoundEnabled === 'boolean'
        ? settings.agentDoneSoundEnabled
        : defaults.agentDoneSoundEnabled,
    agentDoneSoundVolume: clampScale(settings?.agentDoneSoundVolume, 0, 1, defaults.agentDoneSoundVolume),
    allAgentsDoneSoundEnabled:
      typeof settings?.allAgentsDoneSoundEnabled === 'boolean'
        ? settings.allAgentsDoneSoundEnabled
        : defaults.allAgentsDoneSoundEnabled,
    allAgentsDoneSoundVolume: clampScale(
      settings?.allAgentsDoneSoundVolume,
      0,
      1,
      defaults.allAgentsDoneSoundVolume,
    ),
    crossProviderSkillReuseEnabled:
      typeof settings?.crossProviderSkillReuseEnabled === 'boolean'
        ? settings.crossProviderSkillReuseEnabled
        : defaults.crossProviderSkillReuseEnabled,
    accessibilitySupportEnabled:
      typeof settings?.accessibilitySupportEnabled === 'boolean'
        ? settings.accessibilitySupportEnabled
        : defaults.accessibilitySupportEnabled,
    closeBehavior: resolveCloseBehavior(settings, defaults.closeBehavior),
    autoUrgeEnabled:
      typeof settings?.autoUrgeEnabled === 'boolean'
        ? settings.autoUrgeEnabled
        : defaults.autoUrgeEnabled,
    autoUrgeProfiles: autoUrgeSettings.autoUrgeProfiles,
    autoUrgeActiveProfileId: autoUrgeSettings.autoUrgeActiveProfileId,
    autoUrgeMessage: autoUrgeSettings.autoUrgeMessage,
    autoUrgeSuccessKeyword: autoUrgeSettings.autoUrgeSuccessKeyword,
    autoUrgeGlobalControlEnabled:
      typeof settings?.autoUrgeGlobalControlEnabled === 'boolean'
        ? settings.autoUrgeGlobalControlEnabled
        : defaults.autoUrgeGlobalControlEnabled,
    autoUrgeGlobalActive:
      typeof settings?.autoUrgeGlobalActive === 'boolean'
        ? settings.autoUrgeGlobalActive
        : defaults.autoUrgeGlobalActive,
    autoUrgeGlobalProfileId: autoUrgeSettings.autoUrgeGlobalProfileId,
    repeatLoopEnabled:
      typeof settings?.repeatLoopEnabled === 'boolean'
        ? settings.repeatLoopEnabled
        : defaults.repeatLoopEnabled,
    wakeTimerEnabled:
      typeof settings?.wakeTimerEnabled === 'boolean'
        ? settings.wakeTimerEnabled
        : defaults.wakeTimerEnabled,
    wakeTimerDefaultMode: (wakeTimerModes as readonly string[]).includes(
      settings?.wakeTimerDefaultMode as string,
    )
      ? (settings!.wakeTimerDefaultMode as WakeTimerMode)
      : defaults.wakeTimerDefaultMode,
    wakeTimerDefaultDurationMinutes:
      typeof settings?.wakeTimerDefaultDurationMinutes === 'number' &&
      Number.isFinite(settings.wakeTimerDefaultDurationMinutes) &&
      settings.wakeTimerDefaultDurationMinutes >= minWakeTimerDurationMinutes &&
      settings.wakeTimerDefaultDurationMinutes <= maxWakeTimerDurationMinutes
        ? settings.wakeTimerDefaultDurationMinutes
        : defaults.wakeTimerDefaultDurationMinutes,
    weatherCity: normalizeText(settings?.weatherCity) || defaults.weatherCity,
    systemPrompt: normalizeSystemPrompt(settings?.systemPrompt),
    modelPromptRules: normalizeModelPromptRules(settings?.modelPromptRules),
    codexPersonality: normalizeCodexPersonality(settings?.codexPersonality),
    codexFastMode: typeof settings?.codexFastMode === 'boolean' ? settings.codexFastMode : false,
    agentOutsideWorkspaceWriteEnabled:
      typeof settings?.agentOutsideWorkspaceWriteEnabled === 'boolean'
        ? settings.agentOutsideWorkspaceWriteEnabled
        : defaults.agentOutsideWorkspaceWriteEnabled,
    codexDestructiveCommandProtectionEnabled:
      typeof settings?.codexDestructiveCommandProtectionEnabled === 'boolean'
        ? settings.codexDestructiveCommandProtectionEnabled
        : defaults.codexDestructiveCommandProtectionEnabled,
    codexIsolatedHomeEnabled:
      typeof settings?.codexIsolatedHomeEnabled === 'boolean'
        ? settings.codexIsolatedHomeEnabled
        : defaults.codexIsolatedHomeEnabled,
    gitAgentModel: normalizeGitAgentModel(settings?.gitAgentModel, defaults.gitAgentModel),
    // `lastModel` / `requestModels` 语义上只能是"下一次发请求用哪个模型"，
    // 工具卡模型放进去是非法的。已有存档被写脏过（看板漏出白名单，见
    // shared/models.ts TOOL_CARD_MODELS），所以这里同时承担迁移修复。
    lastModel: settings?.lastModel
      ? {
          provider: settings.lastModel.provider,
          model: normalizeRequestModel(settings.lastModel.provider, settings.lastModel.model),
        }
      : undefined,
    requestModels: {
      codex: normalizeRequestModel('codex', settings?.requestModels?.codex ?? defaults.requestModels.codex),
      claude: normalizeRequestModel('claude', settings?.requestModels?.claude ?? defaults.requestModels.claude),
    },
    modelReasoningEfforts: normalizeModelReasoningEfforts(settings?.modelReasoningEfforts),
    providerProfiles: normalizeProviderProfiles(settings?.providerProfiles),
    localModelEntries: normalizeLocalModelEntries(settings?.localModelEntries),
    recentWorkspaces: normalizeRecentWorkspaces(settings?.recentWorkspaces),
  }
}

export const isQuickToolModelEnabled = (settings: AppSettings, model: string) => {
  switch (model) {
    case GIT_TOOL_MODEL:
      return settings.gitCardEnabled
    case FILETREE_TOOL_MODEL:
      return settings.fileTreeCardEnabled
    case STICKYNOTE_TOOL_MODEL:
      return settings.stickyNoteCardEnabled
    case AUTOMATIONBOARD_TOOL_MODEL:
      return settings.automationBoardCardEnabled
    case BRAINSTORM_TOOL_MODEL:
      return false
    case WEATHER_TOOL_MODEL:
      return settings.experimentalWeatherEnabled
    case STATS_TOOL_MODEL:
      return settings.experimentalStatsEnabled
    case MUSIC_TOOL_MODEL:
      return settings.experimentalMusicEnabled
    case WHITENOISE_TOOL_MODEL:
      return settings.experimentalWhiteNoiseEnabled
    default:
      return true
  }
}

const ambienceQuickToolModels = new Set([
  WEATHER_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
])
const quickToolModelsInOrder = [
  GIT_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  AUTOMATIONBOARD_TOOL_MODEL,
  STATS_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
] as const
const stableQuickToolModelLists = new Map<string, string[]>()

const getStableQuickToolModelList = (models: string[]) => {
  const cacheKey = models.join('|')
  const cachedModels = stableQuickToolModelLists.get(cacheKey)

  if (cachedModels) {
    return cachedModels
  }

  const stableModels = [...models]
  stableQuickToolModelLists.set(cacheKey, stableModels)
  return stableModels
}

export const getAvailableQuickToolModels = (
  settings: AppSettings,
  columns: readonly BoardColumn[] = [],
) => {
  const enabledModels = quickToolModelsInOrder.filter((model) => isQuickToolModelEnabled(settings, model))

  const hasOpenAmbienceTool = columns.some((column) =>
    Object.values(column.cards).some((card) => ambienceQuickToolModels.has(card.model)),
  )

  if (!hasOpenAmbienceTool) {
    return getStableQuickToolModelList([...enabledModels])
  }

  return getStableQuickToolModelList(enabledModels.filter((model) => !ambienceQuickToolModels.has(model)))
}

export const getConfiguredModel = (settings: AppSettings, provider: Provider) =>
  normalizeModel(provider, settings.requestModels[provider])

export const getEffectiveCardModel = (
  settings: AppSettings,
  provider: Provider,
  model?: string | null,
) => normalizeStoredModel(provider, model) || getConfiguredModel(settings, provider)

export const getPreferredReasoningEffort = (
  settings: AppSettings,
  provider: Provider,
  model?: string | null,
) => {
  const effectiveModel = getEffectiveCardModel(settings, provider, model)
  return normalizeReasoningEffortForModel(
    provider,
    effectiveModel,
    settings.modelReasoningEfforts[provider][effectiveModel],
  )
}

export const rememberModelReasoningEffort = (
  settings: AppSettings,
  provider: Provider,
  model: string | undefined,
  reasoningEffort?: string | null,
): AppSettings['modelReasoningEfforts'] => {
  const effectiveModel = getEffectiveCardModel(settings, provider, model)
  const normalizedReasoningEffort = normalizeReasoningEffortForModel(provider, effectiveModel, reasoningEffort)
  const existingReasoningEffort = settings.modelReasoningEfforts[provider][effectiveModel]

  if (existingReasoningEffort === normalizedReasoningEffort) {
    return settings.modelReasoningEfforts
  }

  return {
    ...settings.modelReasoningEfforts,
    [provider]: {
      ...settings.modelReasoningEfforts[provider],
      [effectiveModel]: normalizedReasoningEffort,
    },
  }
}

export const getActiveProviderProfile = (settings: AppSettings, provider: Provider) => {
  const collection = settings.providerProfiles[provider]
  return collection.profiles.find((profile) => profile.id === collection.activeProfileId)
}

export const getCardMinimumSize = (model?: string | null) =>
  model === GIT_TOOL_MODEL
    ? minGitToolCardSize
    : model === STICKYNOTE_TOOL_MODEL
      ? minStickyNoteCardSize
      : model === WHITENOISE_TOOL_MODEL
        ? minWhiteNoiseCardSize
        : model === WEATHER_TOOL_MODEL
          ? minWeatherCardSize
          : model === AUTOMATIONBOARD_TOOL_MODEL
            ? minAutomationBoardCardSize
            : model === STATS_TOOL_MODEL
              ? minStatsCardSize
              : minCardSize

export const getCardDefaultSize = (model?: string | null) =>
  model === GIT_TOOL_MODEL
    ? defaultGitToolCardSize
    : model === STICKYNOTE_TOOL_MODEL
      ? defaultStickyNoteCardSize
      : model === WHITENOISE_TOOL_MODEL
        ? defaultWhiteNoiseCardSize
        : model === AUTOMATIONBOARD_TOOL_MODEL
          ? defaultAutomationBoardCardSize
          : model === STATS_TOOL_MODEL
            ? defaultStatsCardSize
            : defaultCardSize

export const normalizeCardSize = (size?: number, minimumSize = minCardSize, defaultSize = defaultCardSize) => {
  if (!size || Number.isNaN(size)) {
    return defaultSize
  }

  if (size <= 100 && minimumSize >= 100) {
    return Math.max(minimumSize, Math.round(260 + size * 3))
  }

  return Math.max(minimumSize, Math.round(size))
}

export const normalizeColumnWidth = (width?: number) => {
  if (!width || Number.isNaN(width)) {
    return undefined
  }

  return Math.max(minColumnWidth, Math.round(width))
}

export const createMessage = (
  role: ChatRole,
  content: string,
  meta?: ChatMessage['meta'],
): ChatMessage => ({
  id: createId(),
  role,
  content,
  createdAt: now(),
  meta,
})

const normalizePaneTabHistory = (
  tabs: string[],
  activeTabId: string,
  tabHistory?: string[] | null,
) => {
  const nextHistory: string[] = []
  const seen = new Set<string>()

  if (Array.isArray(tabHistory)) {
    for (const tabId of tabHistory) {
      if (!tabs.includes(tabId) || seen.has(tabId)) {
        continue
      }

      seen.add(tabId)
      nextHistory.push(tabId)
    }
  }

  for (const tabId of tabs) {
    if (seen.has(tabId)) {
      continue
    }

    seen.add(tabId)
    nextHistory.push(tabId)
  }

  if (!activeTabId) {
    return nextHistory
  }

  return [...nextHistory.filter((tabId) => tabId !== activeTabId), activeTabId]
}

const resolvePaneActiveTabId = (
  tabs: string[],
  activeTabId?: string | null,
  tabHistory?: string[] | null,
) => {
  if (activeTabId && tabs.includes(activeTabId)) {
    return activeTabId
  }

  if (Array.isArray(tabHistory) && tabHistory.length > 0) {
    const normalizedHistory = normalizePaneTabHistory(tabs, '', tabHistory)
    return normalizedHistory.at(-1) ?? (tabs[0] ?? '')
  }

  return tabs[0] ?? ''
}

export const createPane = (
  tabs: string[] = [],
  activeTabId: string = tabs[0] ?? '',
  id: string = createId(),
  tabHistory?: string[] | null,
): PaneNode => {
  const nextTabs = [...tabs]
  const nextActiveTabId = resolvePaneActiveTabId(nextTabs, activeTabId, tabHistory)

  return {
    type: 'pane',
    id,
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    tabHistory: normalizePaneTabHistory(nextTabs, nextActiveTabId, tabHistory),
  }
}

export const createSplit = (
  direction: SplitDirection,
  children: LayoutNode[],
  ratios?: number[],
  id: string = createId(),
): SplitNode => ({
  type: 'split',
  id,
  direction,
  children,
  ratios: normalizeSplitRatios(ratios, children.length),
})

export const getLayoutTabIds = (layout: LayoutNode): string[] => {
  if (layout.type === 'pane') {
    return [...layout.tabs]
  }

  return layout.children.flatMap(getLayoutTabIds)
}

export const getFirstPane = (layout: LayoutNode): PaneNode =>
  layout.type === 'pane' ? layout : getFirstPane(layout.children[0]!)

export const normalizePaneNode = (
  pane: PaneNode,
  cards: Record<string, ChatCard>,
): PaneNode => {
  const seen = new Set<string>()
  const tabs = pane.tabs.filter((tabId) => {
    if (!(tabId in cards) || seen.has(tabId)) {
      return false
    }

    seen.add(tabId)
    return true
  })

  return createPane(tabs, pane.activeTabId, pane.id, pane.tabHistory)
}

export const normalizeLayoutNode = (
  layout: LayoutNode | undefined,
  cards: Record<string, ChatCard>,
): LayoutNode => {
  if (!layout) {
    return createPane(Object.keys(cards))
  }

  if (layout.type === 'pane') {
    return normalizePaneNode(layout, cards)
  }

  const normalizedChildren = layout.children
    .map((child) => normalizeLayoutNode(child, cards))
    .filter((child) => {
      if (child.type !== 'pane') {
        return true
      }

      return child.tabs.length > 0
    })

  if (normalizedChildren.length === 0) {
    return createPane([])
  }

  if (normalizedChildren.length === 1) {
    return normalizedChildren[0]!
  }

  return createSplit(layout.direction, normalizedChildren, layout.ratios, layout.id)
}

export const getOrderedColumnTabIds = (column: BoardColumn) => {
  const ordered = getLayoutTabIds(column.layout)
  const seen = new Set<string>()
  const result: string[] = []

  for (const tabId of ordered) {
    if (tabId in column.cards && !seen.has(tabId)) {
      seen.add(tabId)
      result.push(tabId)
    }
  }

  for (const tabId of Object.keys(column.cards)) {
    if (!seen.has(tabId)) {
      seen.add(tabId)
      result.push(tabId)
    }
  }

  return result
}

export const getOrderedColumnCards = (column: BoardColumn) =>
  getOrderedColumnTabIds(column)
    .map((tabId) => column.cards[tabId])
    .filter((card): card is ChatCard => Boolean(card))

export const createCard = (
  title: string | undefined = undefined,
  size?: number,
  provider: Provider = 'codex',
  model = getDefaultModel(provider),
  reasoningEffort: string | null | undefined = undefined,
  language: AppLanguage = defaultAppLanguage,
): ChatCard => {
  void language
  const normalizedModel = normalizeStoredModel(provider, model)
  const effectiveSize = size ?? getCardDefaultSize(normalizedModel)

  return {
    id: createId(),
    title: title ?? '',
    status: 'idle',
    size: normalizeCardSize(effectiveSize, getCardMinimumSize(normalizedModel), getCardDefaultSize(normalizedModel)),
    provider,
    model: normalizedModel,
    // Model-aware: an empty tier lands on the model default (high on Fable 5,
    // provider default elsewhere).
    reasoningEffort: normalizeReasoningEffortForModel(provider, normalizedModel, reasoningEffort),
    thinkingEnabled: true,
    planMode: false,
    autoUrgeActive: false,
    autoUrgeProfileId: defaultAutoUrgeProfileId,
    repeatLoopActive: false,
    repeatLoopRemaining: undefined,
    collapsed: false,
    unread: false,
    draft: '',
    draftAttachments: [],
    queuedSends: [],
    wakeTimerActive: false,
    wakeTimerAutoActivated: false,
    wakeTimerMode: 'workspace-agents',
    wakeTimerDurationMinutes: 30,
    wakeTimerQueuedSends: [],
    wakeTimerPendingTargetIds: [],
    stickyNote: '',
    brainstorm: createDefaultBrainstormState(),
    pm: createDefaultPmState(),
    pmTaskCardId: '',
    pmOwnerCardId: '',
    providerSessions: {},
    messages: [],
  }
}

/**
 * 内置"看板监工"模板的固定 id。
 *
 * 固定而不是随机是刻意的：旧存档迁移（把 v1 的工作区级 autoTrigger 折进模板）
 * 与"这个工作区已经种过内置模板了吗"都要靠它定位，随机 id 会让迁移每次都
 * 再种一份出来。
 */
export const automationBoardSupervisorTemplateId = 'automation-board-supervisor'

/**
 * 监工在 v2 里没有任何专属代码路径 —— 它就是这个模板，加上它实例化出来的
 * 一张普通看板项卡。它的全部"监工性"只有两个字段：`adminAccess: true`
 * （拿到工作区 MCP）与 `trigger`（到点自动把自己拖进泳道）。
 *
 * 触发器默认**关闭**：自动起 agent 是有真实成本的行为，不该因为新建了一个
 * 工作区就默默开始跑。
 */
export const createDefaultAutomationBoardSupervisorTemplate = (
  language: AppLanguage = defaultAppLanguage,
): AutomationBoardTemplate => {
  const text = getLocaleText(normalizeLanguage(language))

  return {
    id: automationBoardSupervisorTemplateId,
    name: text.automationBoardSupervisorTemplateName,
    requirement: defaultAutomationBoardSupervisorRequirement,
    // 看板卡本身就是 codex 侧的工具卡，默认监工跟着走 codex；`model: ''` 表示
    // "用用户配好的默认模型"，别在这里钉死某个具体型号。
    provider: 'codex',
    model: '',
    reasoningEffort: 'max',
    thinkingEnabled: true,
    planMode: false,
    adminAccess: true,
    builtIn: true,
    trigger: createDefaultAutomationBoardTemplateTrigger(),
    instanceCardId: '',
    wakeTimerActive: false,
    repeatLoopActive: false,
  }
}

export const createDefaultAutomationBoardWorkspaceState = (
  language: AppLanguage = defaultAppLanguage,
): AutomationBoardWorkspaceState => ({
  templates: [createDefaultAutomationBoardSupervisorTemplate(language)],
})

export const createAutomationBoardCard = (
  title: string | undefined = undefined,
  language: AppLanguage = defaultAppLanguage,
): ChatCard => {
  const text = getLocaleText(normalizeLanguage(language))

  return {
    ...createCard(
      title ?? text.automationBoardTitle,
      defaultAutomationBoardCardSize,
      'codex',
      AUTOMATIONBOARD_TOOL_MODEL,
      undefined,
      language,
    ),
    automationBoard: {
      items: [],
    },
  }
}

/**
 * A board item is an ordinary chat card that simply never enters `pane.tabs`.
 * The requirement text lands in `draft` rather than being sent, so moving the
 * item into the running lane reuses the exact same send path a user typing in
 * a composer would take.
 */
export const createAutomationBoardItemCard = ({
  requirement,
  provider,
  model,
  reasoningEffort,
  thinkingEnabled = true,
  planMode = false,
  adminAccess = false,
  language = defaultAppLanguage,
}: {
  requirement: string
  provider: Provider
  model: string
  reasoningEffort?: string | null
  thinkingEnabled?: boolean
  planMode?: boolean
  adminAccess?: boolean
  language?: AppLanguage
}): ChatCard => ({
  ...createCard(
    // 纯图片需求的文本是空的，标题必然走兜底；不显式传语言的话英文界面会冒出
    // 一句中文 —— `titleFromPrompt` 的默认兜底锁死在 `defaultAppLanguage`。
    titleFromPrompt(requirement, getLocaleText(language).newChat),
    defaultCardSize,
    provider,
    model,
    reasoningEffort,
    language,
  ),
  thinkingEnabled,
  planMode,
  ...(adminAccess ? { adminAccess: true } : {}),
  draft: requirement,
})

export const createAutomationBoardTemplateFromCard = ({
  card,
  requirement,
  name,
  id,
  createdAt,
}: {
  card: ChatCard
  requirement: string
  name?: string
  id: string
  createdAt?: string
}): AutomationBoardTemplate => ({
  id,
  name: (name ?? titleFromPrompt(requirement)).trim(),
  requirement,
  provider: card.provider,
  model: card.model,
  reasoningEffort: card.reasoningEffort,
  thinkingEnabled: card.thinkingEnabled,
  planMode: card.planMode,
  // 超管权限跟着卡片走：从一张监工卡存出来的模板理应还是监工模板。
  adminAccess: card.adminAccess === true,
  builtIn: false,
  // 触发器不从卡片快照 —— 它是模板自己的属性，用户存模板时并没有表达
  // "我要它自动跑"。默认关闭，让用户显式去开。
  trigger: createDefaultAutomationBoardTemplateTrigger(),
  instanceCardId: '',
  wakeTimerActive: card.wakeTimerActive === true,
  ...(card.wakeTimerMode ? { wakeTimerMode: card.wakeTimerMode } : {}),
  ...(typeof card.wakeTimerDurationMinutes === 'number'
    ? { wakeTimerDurationMinutes: card.wakeTimerDurationMinutes }
    : {}),
  repeatLoopActive: card.repeatLoopActive === true,
  ...(typeof card.repeatLoopRemaining === 'number'
    ? { repeatLoopRemaining: card.repeatLoopRemaining }
    : {}),
  createdAt: createdAt ?? now(),
})

export const createAutomationBoardCardFromTemplate = ({
  template,
  language = defaultAppLanguage,
}: {
  template: AutomationBoardTemplate
  language?: AppLanguage
}): ChatCard => ({
  ...createAutomationBoardItemCard({
    requirement: template.requirement,
    provider: template.provider,
    model: template.model,
    reasoningEffort: template.reasoningEffort,
    thinkingEnabled: template.thinkingEnabled,
    planMode: template.planMode,
    // 这一行就是"监工"的全部：模板勾了超管权限，实例化出来的卡才拿得到
    // 工作区 MCP。没有任何监工专属的建卡路径。
    adminAccess: template.adminAccess,
    language,
  }),
  wakeTimerActive: template.wakeTimerActive,
  ...(template.wakeTimerMode ? { wakeTimerMode: template.wakeTimerMode } : {}),
  ...(typeof template.wakeTimerDurationMinutes === 'number'
    ? { wakeTimerDurationMinutes: template.wakeTimerDurationMinutes }
    : {}),
  repeatLoopActive: template.repeatLoopActive,
  ...(typeof template.repeatLoopRemaining === 'number'
    ? { repeatLoopRemaining: template.repeatLoopRemaining }
    : {}),
})

export const automationBoardLaneOrder: readonly AutomationBoardLane[] = [
  'standby',
  'running',
  'done',
]

/**
 * 一个 `automationBoard` blob **只在卡片确实是看板时才作数**。
 *
 * 症状（要防的）：把看板卡切成普通聊天模型后，它的项卡片继续被"拥有"，于是
 *   既不出现在看板里（卡片已经不是看板了）也永远不会被恢复成 tab —— 变成
 *   看不见也删不掉的孤儿。
 * 被否决：切走时直接删掉 blob。那样切回来就什么都没了，一次误点不可逆。
 * 现在的做法：blob 保留（可逆），但读取一律经这个出口；切走之后那些卡片成为
 *   真正的孤儿，下次加载由 `resolveRecoveredColumnLayout` 恢复成 tab。
 */
export const getAutomationBoard = (card: ChatCard | undefined) =>
  card?.model === AUTOMATIONBOARD_TOOL_MODEL ? card.automationBoard : undefined

/**
 * Every card id that an automation board in this column claims. These cards
 * live in `column.cards` on purpose but must never be treated as pane tabs.
 */
export const collectAutomationBoardOwnedCardIds = (
  cards: Record<string, ChatCard>,
): Set<string> => {
  const owned = new Set<string>()

  for (const card of Object.values(cards)) {
    const board = getAutomationBoard(card)
    if (!board) {
      continue
    }

    for (const item of board.items) {
      owned.add(item.cardId)
    }
  }

  return owned
}

/**
 * 症状：一列的 layout 归一化后变成空 pane 时，兜底会把 `Object.keys(cards)`
 *   整个塞进一个 pane —— 自动化看板的需求卡与监工卡会因此全部曝光成 tab。
 * 根因：那条兜底写在"卡片一定都是 tab"的假设上，而看板项刻意不是。
 * 被否决：不要卡片就不救。空 layout + 有卡片说明 layout 真的坏了，
 *   仍然必须救回来，只是救的范围要排除看板自己拥有的卡片。
 */
export const resolveRecoveredColumnLayout = (
  layout: LayoutNode,
  cards: Record<string, ChatCard>,
  boardOwnedCardIds: ReadonlySet<string> = collectAutomationBoardOwnedCardIds(cards),
): LayoutNode => {
  if (layout.type !== 'pane' || layout.tabs.length > 0) {
    return layout
  }

  const recoverable = Object.keys(cards).filter((cardId) => !boardOwnedCardIds.has(cardId))

  return recoverable.length > 0 ? createPane(recoverable) : layout
}

const createCardRecord = (...cards: ChatCard[]): Record<string, ChatCard> =>
  Object.fromEntries(cards.map((card) => [card.id, card]))

export const createColumn = (
  overrides: Partial<BoardColumn> = {},
  language: AppLanguage = defaultAppLanguage,
): BoardColumn => {
  const provider = overrides.provider ?? 'codex'
  const model = normalizeStoredModel(provider, overrides.model ?? getDefaultModel(provider))
  const text = getLocaleText(normalizeLanguage(language))
  const cards =
    overrides.cards && Object.keys(overrides.cards).length > 0
      ? createCardRecord(...Object.values(overrides.cards))
      : createCardRecord(
          createCard(
            undefined,
            defaultCardSize,
            provider,
            model,
            undefined,
            language,
          ),
        )

  return {
    id: overrides.id ?? createId(),
    title: overrides.title ?? text.genericWorkspaceChannel,
    provider,
    workspacePath: overrides.workspacePath ?? '',
    model,
    width: normalizeColumnWidth(overrides.width),
    layout: normalizeLayoutNode(overrides.layout, cards),
    cards,
  }
}

export const createDefaultState = (
  workspacePath = '',
  language: AppLanguage = defaultAppLanguage,
): AppState => {
  const normalizedLanguage = normalizeLanguage(language)
  const text = getLocaleText(normalizedLanguage)

  return {
    version: 1,
    settings: createDefaultSettings(normalizedLanguage),
    updatedAt: now(),
    sessionHistory: [],
    stickyNoteArchive: {},
    automationBoards: {},
    columns: [
      createColumn(
        {
          title: text.developmentChannel,
          provider: 'codex',
          workspacePath,
          cards: createCardRecord(
            createCard(
              undefined,
              560,
              'codex',
              DEFAULT_CODEX_MODEL,
              undefined,
              normalizedLanguage,
            ),
          ),
        },
        normalizedLanguage,
      ),
      createColumn(
        {
          title: text.reviewChannel,
          provider: 'claude',
          workspacePath,
          cards: createCardRecord(
            createCard(
              undefined,
              470,
              'claude',
              undefined,
              undefined,
              normalizedLanguage,
            ),
            createCard(
              undefined,
              380,
              'claude',
              undefined,
              undefined,
              normalizedLanguage,
            ),
          ),
        },
        normalizedLanguage,
      ),
    ],
  }
}

export const resetCardSessions = (cards: Record<string, ChatCard>): Record<string, ChatCard> =>
  Object.fromEntries(
    Object.entries(cards).map(([cardId, card]) => [
      cardId,
      {
        ...card,
        sessionId: undefined,
        sessionModel: undefined,
        providerSessions: {},
        contextTransfer: undefined,
        streamId: undefined,
        status: 'idle',
      },
    ]),
  )

/** Strip XML-like tags (e.g. `<command-name>...</command-name>`) and return inner text. */
export const stripXmlTags = (text: string) => text.replace(/<\/?[a-zA-Z][\w-]*[^>]*>/g, '')

export const titleFromPrompt = (
  prompt: string,
  fallback = getLocaleText(defaultAppLanguage).newChat,
) => {
  const compact = stripXmlTags(prompt).replace(/\s+/g, ' ').trim()

  if (!compact) {
    return fallback
  }

  return compact.length > 38 ? `${compact.slice(0, 38)}...` : compact
}

export const touchState = (state: AppState): AppState => ({
  ...state,
  updatedAt: now(),
})

export const upsertStickyNoteArchiveEntry = (
  archive: Record<string, StickyNoteArchiveEntry>,
  workspacePath: string,
  content: string,
): Record<string, StickyNoteArchiveEntry> => {
  const key = workspacePath.trim()
  if (!key) {
    return archive
  }

  const next = { ...archive }
  if (!content.trim()) {
    if (!(key in next)) {
      return archive
    }
    delete next[key]
    return next
  }

  next[key] = {
    content: content.slice(0, stickyNoteArchiveMaxContentLength),
    updatedAt: now(),
    viewState: archive[key]?.viewState,
  }

  const keys = Object.keys(next)
  if (keys.length > stickyNoteArchiveMaxEntries) {
    keys.sort((a, b) => next[a].updatedAt.localeCompare(next[b].updatedAt))
    for (const staleKey of keys.slice(0, keys.length - stickyNoteArchiveMaxEntries)) {
      delete next[staleKey]
    }
  }

  return next
}

export const updateStickyNoteArchiveViewState = (
  archive: Record<string, StickyNoteArchiveEntry>,
  workspacePath: string,
  viewState: StickyNoteViewState,
): Record<string, StickyNoteArchiveEntry> => {
  const key = workspacePath.trim()
  const current = archive[key]
  if (!key || !current) {
    return archive
  }

  const contentLength = current.content.length
  const selectionStart = Math.min(contentLength, Math.max(0, Math.round(viewState.selectionStart)))
  const selectionEnd = Math.min(contentLength, Math.max(selectionStart, Math.round(viewState.selectionEnd)))
  const normalized = {
    scrollTop: Math.max(0, viewState.scrollTop),
    selectionStart,
    selectionEnd,
  }

  if (
    current.viewState?.scrollTop === normalized.scrollTop &&
    current.viewState.selectionStart === normalized.selectionStart &&
    current.viewState.selectionEnd === normalized.selectionEnd
  ) {
    return archive
  }

  return {
    ...archive,
    [key]: {
      ...current,
      updatedAt: now(),
      viewState: normalized,
    },
  }
}

export const archiveCardToHistory = (
  history: SessionHistoryEntry[] | undefined,
  card: ChatCard,
  workspacePath: string,
  workspaceCloseId?: string,
): SessionHistoryEntry[] => {
  const entry = createSessionHistoryEntry(card, workspacePath, now(), workspaceCloseId)
  if (!entry) {
    return history ?? []
  }

  return prependSessionHistoryEntry(history, entry)
}

const prependSessionHistoryEntry = (
  history: SessionHistoryEntry[] | undefined,
  entry: SessionHistoryEntry,
) => {
  const base = history ?? []
  const updated = [entry, ...base]
  const workspacePath = entry.workspacePath

  let count = 0
  return updated.filter((e) => {
    if (e.workspacePath.toLowerCase() !== workspacePath.toLowerCase()) {
      return true
    }
    count += 1
    return count <= maxSessionHistoryPerWorkspace
  })
}

const getSessionHistoryTitle = (card: ChatCard) => {
  const trimmedTitle = card.title.trim()
  if (trimmedTitle.length > 0) {
    return trimmedTitle
  }

  const firstUserMessage = card.messages.find((message) => message.role === 'user')?.content ?? ''
  return titleFromPrompt(firstUserMessage)
}

const createSessionHistoryEntry = (
  card: ChatCard,
  workspacePath: string,
  archivedAt = now(),
  workspaceCloseId?: string,
): SessionHistoryEntry | null => {
  if (card.messages.length === 0) {
    return null
  }

  return {
    id: createId(),
    title: getSessionHistoryTitle(card),
    sessionId: card.sessionId,
    sessionModel: card.sessionModel,
    contextTransfer: card.contextTransfer,
    provider: card.provider,
    model: card.model,
    workspacePath,
    messageCount: card.messages.length,
    messages: card.messages,
    // 归档这一刻是最后一次能看到每条消息的 `meta`：送进渲染进程的历史条目会被裁成
    // 预览并剥掉 meta（server/state-store.ts 的 renderSessionHistoryForRenderer），
    // 不在这里汇总，这段会话的 token 与花费就再也回不到统计卡上。
    usageTotals: summarizeTurnUsage(card.messages) ?? undefined,
    workspaceCloseId,
    archivedAt,
  }
}

const matchesCrashArchivedEntry = (
  entry: SessionHistoryEntry,
  card: ChatCard,
  workspacePath: string,
) => {
  if (entry.workspacePath.toLowerCase() !== workspacePath.toLowerCase()) {
    return false
  }

  if (entry.provider !== card.provider || entry.model !== card.model) {
    return false
  }

  if ((entry.sessionId ?? '') !== (card.sessionId ?? '')) {
    return false
  }

  if ((entry.sessionModel ?? '') !== (card.sessionModel ?? '')) {
    return false
  }

  if (JSON.stringify(entry.contextTransfer ?? null) !== JSON.stringify(card.contextTransfer ?? null)) {
    return false
  }

  const entryLastMessage = entry.messages.at(-1)
  const cardLastMessage = card.messages.at(-1)
  if (!entryLastMessage || !cardLastMessage) {
    return false
  }

  return (
    entry.messages.length === card.messages.length &&
    entryLastMessage.id === cardLastMessage.id &&
    entryLastMessage.content === cardLastMessage.content
  )
}

export const archiveOpenChatsForCrashRecovery = (
  state: AppState,
  errorSummary: string,
  crashedAt = now(),
): { state: AppState; recovery: RecentCrashRecovery | null } => {
  let sessionHistory = normalizeSessionHistory(state.sessionHistory)
  const sessionHistoryEntryIds: string[] = []

  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex += 1) {
    const column = state.columns[columnIndex]
    if (!column) {
      continue
    }

    const workspacePath = column.workspacePath.trim() || `Recovered workspace ${columnIndex + 1}`

    for (const card of getOrderedColumnCards(column)) {
      if (card.messages.length === 0) {
        continue
      }

      const existing = sessionHistory.find((entry) => matchesCrashArchivedEntry(entry, card, workspacePath))
      if (existing) {
        sessionHistoryEntryIds.push(existing.id)
        continue
      }

      const entry = createSessionHistoryEntry(card, workspacePath, crashedAt)
      if (!entry) {
        continue
      }

      sessionHistory = prependSessionHistoryEntry(sessionHistory, entry)
      sessionHistoryEntryIds.push(entry.id)
    }
  }

  if (sessionHistoryEntryIds.length === 0) {
    return {
      state,
      recovery: null,
    }
  }

  return {
    state: touchState({
      ...state,
      sessionHistory: normalizeSessionHistory(sessionHistory),
    }),
    recovery: {
      crashedAt,
      errorSummary,
      sessionHistoryEntryIds,
    },
  }
}

export const normalizeSessionHistory = (
  items?: SessionHistoryEntry[] | null,
): SessionHistoryEntry[] => {
  if (!Array.isArray(items)) return []
  return items
    .filter((item) => item?.id && item?.workspacePath && Array.isArray(item.messages))
    .map((item) => ({
      ...item,
      messageCount: Math.max(typeof item.messageCount === 'number' ? item.messageCount : 0, item.messages.length),
    }))
    .sort((a, b) => (b.archivedAt > a.archivedAt ? 1 : b.archivedAt < a.archivedAt ? -1 : 0))
}

export const defaultProviderByIndex = (index: number): Provider =>
  index % 2 === 0 ? 'codex' : 'claude'
