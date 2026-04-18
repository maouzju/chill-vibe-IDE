import type {
  AppLanguage,
  AppSettings,
  AppState,
  AutoUrgeProfile,
  BoardColumn,
  ChatCard,
  ChatMessage,
  ChatRole,
  LayoutNode,
  PaneNode,
  Provider,
  RecentCrashRecovery,
  SessionHistoryEntry,
  SplitDirection,
  SplitNode,
} from './schema.js'
import { createDefaultBrainstormState } from './brainstorm.js'
import {
  defaultAutoUrgeMessage,
  defaultAutoUrgeProfileId,
  defaultAutoUrgeSuccessKeyword,
} from './schema.js'
import {
  defaultAppLanguage,
  getLocaleText,
  normalizeLanguage,
} from './i18n.js'
import {
  BRAINSTORM_TOOL_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GIT_AGENT_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  SPEC_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  getDefaultModel,
  normalizeModel,
  normalizeStoredModel,
} from './models.js'
import { getDefaultReasoningEffort, normalizeReasoningEffort } from './reasoning.js'
import { defaultSystemPrompt, normalizeSystemPrompt } from './system-prompt.js'

const now = () => new Date().toISOString()

export const defaultCardSize = 440
export const minCardSize = 320
export const defaultGitToolCardSize = 100
export const minGitToolCardSize = 1
export const defaultStickyNoteCardSize = 164
export const minStickyNoteCardSize = 96
export const defaultWhiteNoiseCardSize = 286
export const minWhiteNoiseCardSize = 208
export const minWeatherCardSize = 160
export const minColumnWidth = 260
export const minUiScale = 0.8
export const maxUiScale = 1.35
export const minFontScale = 0.85
export const maxFontScale = 1.35
export const minLineHeightScale = 0.75
export const maxLineHeightScale = 1.5

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

const normalizeAutoUrgeText = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value : fallback

export const createAutoUrgeProfile = (
  language: AppLanguage = defaultAppLanguage,
  overrides: Partial<AutoUrgeProfile> = {},
  options: { index?: number; fallbackId?: string } = {},
): AutoUrgeProfile => ({
  id: normalizeText(overrides.id) || options.fallbackId || createId(),
  name: normalizeText(overrides.name) || getAutoUrgeProfileFallbackName(language, options.index ?? 0),
  message: normalizeAutoUrgeText(overrides.message, defaultAutoUrgeMessage),
  successKeyword: normalizeAutoUrgeText(overrides.successKeyword, defaultAutoUrgeSuccessKeyword),
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

  return {
    autoUrgeProfiles,
    autoUrgeActiveProfileId: activeProfile.id,
    autoUrgeMessage: activeProfile.message,
    autoUrgeSuccessKeyword: activeProfile.successKeyword,
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

        return [[normalizedModel, normalizeReasoningEffort(provider, reasoningEffort)]]
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

export const createDefaultSettings = (language: AppLanguage = defaultAppLanguage): AppSettings => ({
  language: normalizeLanguage(language),
  theme: 'dark',
  activeTopTab: 'ambience',
  uiScale: 1,
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
  pmCardEnabled: true,
  brainstormCardEnabled: false,
  experimentalMusicEnabled: false,
  experimentalWhiteNoiseEnabled: false,
  experimentalWeatherEnabled: false,
  agentDoneSoundEnabled: false,
  agentDoneSoundVolume: 0.7,
  crossProviderSkillReuseEnabled: true,
  autoUrgeEnabled: false,
  autoUrgeProfiles: [
    createAutoUrgeProfile(language, {}, { index: 0, fallbackId: defaultAutoUrgeProfileId }),
  ],
  autoUrgeActiveProfileId: defaultAutoUrgeProfileId,
  autoUrgeMessage: defaultAutoUrgeMessage,
  autoUrgeSuccessKeyword: defaultAutoUrgeSuccessKeyword,
  weatherCity: '',
  systemPrompt: defaultSystemPrompt,
  gitAgentModel: DEFAULT_GIT_AGENT_MODEL,
  requestModels: {
    codex: DEFAULT_CODEX_MODEL,
    claude: DEFAULT_CLAUDE_MODEL,
  },
  modelReasoningEfforts: createDefaultModelReasoningEfforts(),
  providerProfiles: createDefaultProviderProfiles(),
  recentWorkspaces: [],
})

export const normalizeAppSettings = (settings?: Partial<AppSettings> | null): AppSettings => {
  const language = normalizeLanguage(settings?.language)
  const defaults = createDefaultSettings(language)
  const autoUrgeSettings = normalizeAutoUrgeSettings(settings, language)

  return {
    language,
    theme: settings?.theme === 'light' ? 'light' : 'dark',
    activeTopTab: normalizeTopTab(settings?.activeTopTab),
    uiScale: clampScale(settings?.uiScale, minUiScale, maxUiScale, defaults.uiScale),
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
    agentDoneSoundEnabled:
      typeof settings?.agentDoneSoundEnabled === 'boolean'
        ? settings.agentDoneSoundEnabled
        : defaults.agentDoneSoundEnabled,
    agentDoneSoundVolume: clampScale(settings?.agentDoneSoundVolume, 0, 1, defaults.agentDoneSoundVolume),
    crossProviderSkillReuseEnabled:
      typeof settings?.crossProviderSkillReuseEnabled === 'boolean'
        ? settings.crossProviderSkillReuseEnabled
        : defaults.crossProviderSkillReuseEnabled,
    autoUrgeEnabled:
      typeof settings?.autoUrgeEnabled === 'boolean'
        ? settings.autoUrgeEnabled
        : defaults.autoUrgeEnabled,
    autoUrgeProfiles: autoUrgeSettings.autoUrgeProfiles,
    autoUrgeActiveProfileId: autoUrgeSettings.autoUrgeActiveProfileId,
    autoUrgeMessage: autoUrgeSettings.autoUrgeMessage,
    autoUrgeSuccessKeyword: autoUrgeSettings.autoUrgeSuccessKeyword,
    weatherCity: normalizeText(settings?.weatherCity) || defaults.weatherCity,
    systemPrompt: normalizeSystemPrompt(settings?.systemPrompt),
    gitAgentModel: normalizeText(settings?.gitAgentModel) || defaults.gitAgentModel,
    lastModel: settings?.lastModel ?? undefined,
    requestModels: {
      codex: normalizeModel('codex', settings?.requestModels?.codex ?? defaults.requestModels.codex),
      claude: normalizeModel('claude', settings?.requestModels?.claude ?? defaults.requestModels.claude),
    },
    modelReasoningEfforts: normalizeModelReasoningEfforts(settings?.modelReasoningEfforts),
    providerProfiles: normalizeProviderProfiles(settings?.providerProfiles),
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
    case BRAINSTORM_TOOL_MODEL:
      return false
    case WEATHER_TOOL_MODEL:
      return settings.experimentalWeatherEnabled
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
  SPEC_TOOL_MODEL,
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
  return normalizeReasoningEffort(provider, settings.modelReasoningEfforts[provider][effectiveModel])
}

export const rememberModelReasoningEffort = (
  settings: AppSettings,
  provider: Provider,
  model: string | undefined,
  reasoningEffort?: string | null,
): AppSettings['modelReasoningEfforts'] => {
  const effectiveModel = getEffectiveCardModel(settings, provider, model)
  const normalizedReasoningEffort = normalizeReasoningEffort(provider, reasoningEffort)
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
          : minCardSize

export const getCardDefaultSize = (model?: string | null) =>
  model === GIT_TOOL_MODEL
    ? defaultGitToolCardSize
    : model === STICKYNOTE_TOOL_MODEL
      ? defaultStickyNoteCardSize
      : model === WHITENOISE_TOOL_MODEL
        ? defaultWhiteNoiseCardSize
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
  reasoningEffort: string | null | undefined = getDefaultReasoningEffort(provider),
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
    reasoningEffort: normalizeReasoningEffort(provider, reasoningEffort),
    thinkingEnabled: true,
    planMode: false,
    autoUrgeActive: false,
    autoUrgeProfileId: defaultAutoUrgeProfileId,
    collapsed: false,
    unread: false,
    draft: '',
    draftAttachments: [],
    stickyNote: '',
    brainstorm: createDefaultBrainstormState(),
    pm: createDefaultPmState(),
    pmTaskCardId: '',
    pmOwnerCardId: '',
    providerSessions: {},
    messages: [],
  }
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
        providerSessions: {},
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

export const archiveCardToHistory = (
  history: SessionHistoryEntry[] | undefined,
  card: ChatCard,
  workspacePath: string,
): SessionHistoryEntry[] => {
  const entry = createSessionHistoryEntry(card, workspacePath)
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
): SessionHistoryEntry | null => {
  if (card.messages.length === 0) {
    return null
  }

  return {
    id: createId(),
    title: getSessionHistoryTitle(card),
    sessionId: card.sessionId,
    provider: card.provider,
    model: card.model,
    workspacePath,
    messageCount: card.messages.length,
    messages: card.messages,
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
