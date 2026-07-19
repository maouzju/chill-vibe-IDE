import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type WheelEvent,
} from 'react'
import {
  BaseStyles,
  ThemeProvider,
} from '@primer/react'

import {
  createAutoUrgeProfile,
  createDefaultState,
  createMessage,
  appFontFamilyOptions,
  getAvailableQuickToolModels,
  getFirstPane,
  isQuickToolModelEnabled,
  getOrderedColumnCards,
  maxFontScale,
  maxLineHeightScale,
  maxUiScale,
  minFontScale,
  minLineHeightScale,
  minUiScale,
  resolveAppFontFamilyCss,
  titleFromPrompt,
} from '../shared/default-state'
import { attachImagesToMessageMeta } from '../shared/chat-attachments'
import { buildCodexChatRequestOverrides } from '../shared/codex-chat-settings'
import { formatLocalizedDateTime, getLocaleText, getProviderLabel } from '../shared/i18n'
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  FILETREE_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  MODEL_PICKER_HIDDEN_TOOL_MODELS,
  TEXTEDITOR_TOOL_MODEL,
  getModelOptions,
  isModelPickerOptionVisible,
  normalizeModel,
  resolveSlashModel,
} from '../shared/models'
import { isImageFilePath } from './components/image-file-routing'
import {
  mergeImportedProviderProfiles,
  summarizeImportedProfiles,
} from '../shared/provider-profile-import'
import { getReasoningLabel, normalizeReasoningEffort } from '../shared/reasoning'
import { getInterruptedSessionResumeRequest } from '../shared/interrupted-session-recovery'
import { formatLocalSlashHelp, parseSlashCommandInput } from '../shared/slash-commands'
import {
  buildSystemPromptForModel,
  defaultSystemPrompt,
  type ModelPromptRule,
} from '../shared/system-prompt'
import {
  createThemeAccentTokens,
  createThemeSurfaceTokens,
  getDefaultThemeAccentColor,
  getDefaultThemeSurfaceColor,
  getSurfaceBaseAppearance,
} from '../shared/theme'
import {
  getRecoverableStreamRetryLimit,
  getRecoverableStreamErrorSessionId,
  resolveStreamRecoveryCheckpointTurn,
  resolveStreamRecoveryMode,
  shouldKeepRecoveringResumeWithFreshSession,
  shouldResetStreamRecoveryAttemptsForActivity,
  shouldResetStreamRecoveryAttemptsForText,
} from './stream-recovery'
import {
  beginOrContinueLocalRecoveryStatsRun,
  continueLocalRecoveryStatsRun,
  noteLocalRecoveryDisconnect,
  settleLocalRecoveryStatsRun,
  type LocalRecoveryStatsState,
} from './stream-recovery-stats'
import {
  computeRecoveryStatusAfterFinalFailure,
  computeRecoveryStatusAfterRetryScheduled,
  computeRecoveryStatusAfterSuccess,
  shouldClearRecoveryStatusOnStreamIdle,
  type CardRecoveryStatus,
} from './stream-recovery-feedback'
import {
  consumeRunDurationMessage,
  recordRunStart,
} from './run-duration-summary'
import type {
  AppState,
  AutoUrgeProfile,
  CcSwitchImportProfile,
  ChatCard,
  ChatMessage,
  ImageAttachment,
  InterruptedSessionEntry,
  InterruptedSessionRecovery,
  OnboardingStatus,
  Provider,
  ProviderStatus,
  RecentCrashRecovery,
  SessionHistoryEntry,
  SetupStatus,
  OllamaStatus,
  StartupStateRecovery,
  StateRecoveryIssue,
  StateRecoveryOption,
  TopTabName,
} from '../shared/schema'
import {
  closeWindow,
  type ChatStreamSource,
  flashWindowOnce,
  fetchOnboardingStatus,
  fetchProviders,
  fetchProxyStats,
  recordProxyStatsEvent,
  fetchSetupStatus,
  hideInternalSessionHistory,
  loadSessionHistoryEntry,
  fetchState,
  importCcSwitchRouting,
  isWindowMaximized,
  minimizeWindow,
  onWindowMaximizedChanged,
  openChatStream,
  requestChat,
  forkProviderSession,
  getNativeTurnCompletion,
  resetState,
  runEnvironmentSetup,
  fetchOllamaStatus,
  runOllamaInstall,
  runOllamaPull,
  stopChat,
  subscribeUnsolicitedStreams,
  syncRuntimeSettings,
  toggleMaximizeWindow,
  type ProxyStatsCounts,
  type ProxyStatsSummary,
  type UpdateCheckResult,
  getAppVersion,
  checkForUpdate,
  clearUserData,
  dismissRecentCrashRecovery,
  downloadUpdate,
  installUpdate,
  onUpdateDownloadProgress,
  resolveStateRecoveryOption,
  searchCities,
  type CitySuggestion,
  fetchRemoteMonitorStatus,
  isRemoteMonitorSupported,
  startRemoteMonitor,
  stopRemoteMonitor,
  subscribeRemoteCommands,
  type RemoteMonitorStartResponse,
} from './api'
import { resolveAppLoadError } from './app-load-error'
import {
  isProviderStatusExplicitlyUnavailable,
  startInitialAppLoad,
} from './app-initial-load'
import { getResolvedAppTheme, subscribeToSystemThemeChange } from './theme'
import { WeatherAmbientOverlay } from './components/WeatherAmbientOverlay'
import {
  type ActiveStream,
  type LoadStatus,
  type OnboardingImportState,
  type OnboardingStage,
  type ProfileDraft,
  type SaveStatus,
  type StoppedRunReason,
  createStoppedRunMessage,
  createLogMessages,
  createStructuredActivityMessage,
  createStructuredMessageId,
  emptyProfileDraft,
  errorMessage,
  finalizeStructuredActivityMessage,
  finalizeStreamedAssistantMessage,
  canSendEmptyContinuation,
  getAgentDoneSoundUrl,
  getColumnById,
  getResumeSessionIdForModel,
  resolveChatReplayMode,
  getRoutingImportText,
  importErrorMessage,
  isFirstOpenState,
  onboardingLanguages,
  onboardingStorageKey,
  readFileAsBase64,
  resolveStreamedAssistantMessageTarget,
} from './app-helpers'
import {
  clearPendingCompactBoundaryMessage,
  finalizePendingCompactBoundaryMessage,
  getPendingCompactBoundaryMessage,
  isCompactBoundaryMessage,
  markCompactBoundaryMessage,
} from './components/chat-card-compaction'
import { collectChangesSummaryFilesForStream } from './components/chat-card-parsing'
import {
  buildQueuedSendRuntimeState,
  resolveQueuedSendTargetColumnId,
  shouldSuppressStreamOutputAfterAskUserActivity,
  shouldStopStreamForAskUserActivity,
  summarizeQueuedSends,
  type QueuedSendRequest,
  type QueuedSendSummary,
  type SendMessageOptions,
} from './components/deferred-send-queue'
import { shouldExitPlanModeForAskUserAnswer } from './components/ask-user-answer-state'
import { getAutoReadCardIdsForVisiblePanes, shouldMarkCardUnreadOnStreamDone } from './components/pane-read-state'
import { clearFileTreeCacheForCard } from './components/tool-card-state'
import { evictTextEditorModel } from './components/text-editor-model-cache'
import { publishTextEditorSettings } from './components/text-editor-settings'
import { buildSeededChatPrompt, collectSeededChatAttachments, hasSeededChatTranscript } from './chat-request-seeding'
import { buildArchiveRecallSnapshot } from './archive-recall'
import { getOnboardingText, getPanelText, getResilientProxyText, getTopTabText } from './app-panel-text'
import { AppButton } from './components/AppButton'
import { dispatchComposerFocusRequest } from './components/composer-focus'
import {
  installStuckPaneForensics,
  recordAppliedActionsForForensics,
  registerForensicsAppStateTruth,
} from './diagnostics/stuck-pane-forensics'
import {
  getStableSettingsPanelColumnCount,
  splitSettingsGroupsIntoStableColumns,
} from './settings-layout'
import {
  CloseIcon,
  MaximizeWindowIcon,
  MinimizeWindowIcon,
  ModelIcon,
  PhoneMonitorIcon,
  PlusIcon,
  RestoreWindowIcon,
  EyeIcon,
  EyeOffIcon,
} from './components/Icons'
import { WorkspaceColumn } from './components/WorkspaceColumn'
import {
  drainStreamRenderBufferActionsForColumn,
  enqueueStreamDeltaBufferEntry,
  getPersistenceVersion,
  getStreamRenderBufferColumnIds,
  getStreamRenderFlushIntervalMs,
  getStreamRenderInteractionDelayMs,
  shouldPersistActionImmediately,
  shouldSyncRuntimeSettings,
  shouldUseQueuedPersistenceForAction,
  streamRenderColumnYieldMs,
  takeStreamDeltaBufferEntriesForCard,
  type StreamActivityBufferEntry,
  type StreamDeltaBufferEntry,
} from './hooks/persistence-queue'
import { usePersistence } from './hooks/usePersistence'
import { getBoardWheelDisposition, getVerticalScrollLimit, overflowScrollablePattern } from './board-wheel'
import { updateLatestKnownAppState } from './renderer-crash-state'
import { resolveSessionHistoryEntryForRestore } from './session-history-restore'
import { findPaneForTab, findPaneInLayout, ideReducer, resolveForkPointMessage, type IdeAction } from './state'

const emptyProxyStatsCounts: ProxyStatsCounts = {
  requests: 0,
  disconnects: 0,
  recoverySuccesses: 0,
  recoveryFailures: 0,
}
const emptySessionHistory: SessionHistoryEntry[] = []
const maxResumeSessionLoopAttempts = 2
const defaultRecoverableStreamRetryLimit = 6
const maxConcurrentInterruptedSessionResumes = 2
const interruptedSessionResumeBatchDelayMs = 350

const normalizeWorkspaceHistoryKey = (workspacePath: string) => workspacePath.trim().toLowerCase()
const findSessionRestoreColumnId = (state: AppState, entry: Pick<SessionHistoryEntry, 'workspacePath'>) =>
  state.columns.find(
    (column) => normalizeWorkspaceHistoryKey(column.workspacePath) === normalizeWorkspaceHistoryKey(entry.workspacePath),
  )?.id ?? state.columns[0]?.id

const getStateRecoveryOptionLabel = (
  language: AppState['settings']['language'],
  option: StateRecoveryOption,
) => {
  if (language === 'zh-CN') {
    switch (option.source) {
      case 'current-state':
        return '\u5f53\u524d\u4e3b\u72b6\u6001'
      case 'temp-state':
        return '\u672a\u5b8c\u6210\u4fdd\u5b58\u7684\u4e34\u65f6\u72b6\u6001'
      case 'snapshot':
        return '\u6700\u8fd1\u5feb\u7167'
      default:
        return option.fileName
    }
  }

  switch (option.source) {
    case 'current-state':
      return 'Current state'
    case 'temp-state':
      return 'Interrupted temp state'
    case 'snapshot':
      return 'Recent snapshot'
    default:
      return option.fileName
  }
}

const delayInterruptedSessionResumeBatch = () =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, interruptedSessionResumeBatchDelayMs)
  })

const getStateRecoveryIssueLabel = (
  language: AppState['settings']['language'],
  issue: StateRecoveryIssue,
) => {
  if (language === 'zh-CN') {
    return issue.kind === 'corrupted-wal'
      ? 'state.wal \u5df2\u635f\u574f'
      : '\u53d1\u73b0\u6bd4 state.json \u66f4\u65b0\u7684\u4e34\u65f6\u72b6\u6001\u6587\u4ef6'
  }

  return issue.kind === 'corrupted-wal'
    ? 'state.wal is corrupted'
    : 'A newer temp state file was found'
}

const getAutoCompactStatusMessage = (language: AppState['settings']['language']) =>
  language === 'en'
    ? 'Codex auto-compacted earlier session context, including hidden history and tool output, before continuing this reply.'
    : 'Codex 已自动压缩更早的会话上下文（包括已折叠的历史和工具输出），然后继续当前回复。'

const getCompactionStatusMessage = (
  language: AppState['settings']['language'],
  trigger: 'manual' | 'auto',
) => {
  if (trigger === 'auto') {
    return getAutoCompactStatusMessage(language)
  }

  return language === 'en'
    ? 'Codex compacted the current session context.'
    : '\u5df2\u5b8c\u6210 Codex \u4f1a\u8bdd\u4e0a\u4e0b\u6587\u538b\u7f29\u3002'
}

const getModelPromptRulesSummary = (
  rules: ModelPromptRule[],
  language: AppState['settings']['language'],
) => {
  if (rules.length === 0) {
    return language === 'zh-CN' ? '还没有规则' : 'No rules yet'
  }

  if (language === 'zh-CN') {
    return `已配置 ${rules.length} 条规则`
  }

  return `${rules.length} rule${rules.length === 1 ? '' : 's'} configured`
}

const createCompactionStatusMessage = ({
  provider,
  streamId,
  itemId,
  language,
  trigger,
}: {
  provider: Provider
  streamId: string
  itemId: string
  language: AppState['settings']['language']
  trigger: 'manual' | 'auto'
}): ChatMessage => ({
  id: `${provider}:${streamId}:compaction-status:${itemId}`,
  role: 'system',
  content: getCompactionStatusMessage(language, trigger),
  createdAt: new Date().toISOString(),
  meta: {
    kind: 'log',
    provider,
  },
})

const createAutoCompactionBoundaryMessage = ({
  provider,
  streamId,
  itemId,
}: {
  provider: Provider
  streamId: string
  itemId: string
}): ChatMessage =>
  markCompactBoundaryMessage(
    {
      id: `${provider}:${streamId}:compact-boundary:${itemId}`,
      role: 'user',
      content: '/compact',
      createdAt: new Date().toISOString(),
    },
    {
      trigger: 'auto',
      hidden: true,
    },
  )

function getAppScrollHost() {
  const appShell = document.querySelector('.app-shell')
  if (appShell instanceof HTMLElement) {
    const shellStyle = getComputedStyle(appShell)
    if (overflowScrollablePattern.test(shellStyle.overflowY) && appShell.scrollHeight > appShell.clientHeight + 1) {
      return appShell
    }
  }

  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement
}

function isInteractiveEscapeTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    (target.closest(
      [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[contenteditable="true"]',
        '[role="button"]',
        '[role="combobox"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="tab"]',
        '[role="textbox"]',
      ].join(', '),
    ) !== null ||
      target.closest('#app-panel-routing, #app-panel-settings') !== null)
  )
}

type PaneTarget = {
  columnId: string
  paneId: string
}

type StreamRecoveryTurnSnapshot = {
  forkPoint: {
    content: string
    createdAt: string
  }
  prompt: string
  attachments: ImageAttachment[]
}

type RecoverLiveStreamOptions = {
  clearSessionId?: boolean
  preferNativeCheckpoint?: boolean
}

const hasPendingAskUserMessage = (messages: ChatMessage[]) =>
  messages.findLastIndex((message) => message.meta?.kind === 'ask-user') >
  messages.findLastIndex((message) => message.role === 'user')

const hasLatestPendingAskUserMessage = (
  messages: ChatMessage[],
  latestPrompt?: string,
) => {
  const lastAskUserIndex = messages.findLastIndex((message) => message.meta?.kind === 'ask-user')

  if (lastAskUserIndex < 0) {
    return false
  }

  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')

  const trimmedLatestPrompt = latestPrompt?.trim()

  if (lastAskUserIndex > lastUserIndex) {
    return true
  }

  if (lastUserIndex < 0 || lastUserIndex < lastAskUserIndex) {
    return true
  }

  if (!trimmedLatestPrompt) {
    return false
  }

  return messages
    .slice(lastAskUserIndex + 1)
    .some((message) => message.role === 'user' && message.content.trim() === trimmedLatestPrompt)
}

function App() {
  const [appState, dispatch] = useReducer(ideReducer, createDefaultState(''))
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [, setSaveStatus] = useState<SaveStatus>('idle')
  const [startupRecovery, setStartupRecovery] = useState<StartupStateRecovery | null>(null)
  const [recentCrashRecovery, setRecentCrashRecovery] = useState<RecentCrashRecovery | null>(null)
  const [interruptedSessionRecovery, setInterruptedSessionRecovery] = useState<InterruptedSessionRecovery | null>(null)
  const [stateRecoveryPending, setStateRecoveryPending] = useState(false)
  const [stateRecoveryError, setStateRecoveryError] = useState<string | null>(null)
  const [recentCrashActionPending, setRecentCrashActionPending] = useState(false)
  const [recentCrashActionError, setRecentCrashActionError] = useState<string | null>(null)
  const [interruptedSessionActionPending, setInterruptedSessionActionPending] = useState(false)
  const [interruptedSessionActionError, setInterruptedSessionActionError] = useState<string | null>(null)
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const [routingSubTab, setRoutingSubTab] = useState<'providers' | 'proxy'>('providers')
  const [visibleApiKeys, setVisibleApiKeys] = useState<Set<string>>(() => new Set())
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)
  const [resolvedTheme, setResolvedTheme] = useState(() => getResolvedAppTheme('dark'))
  const [modelPromptRulesDialogOpen, setModelPromptRulesDialogOpen] = useState(false)
  const [modelPromptRulesDraft, setModelPromptRulesDraft] = useState<ModelPromptRule[]>([])
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  const [setupStatusPending, setSetupStatusPending] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [ollamaActionPending, setOllamaActionPending] = useState(false)
  const [cliUpdateTarget, setCliUpdateTarget] = useState<'all' | 'claude' | 'codex'>('all')
  const [cliUpdateVersion, setCliUpdateVersion] = useState('')
  const [routingImportPending, setRoutingImportPending] = useState(false)
  const [onboardingCandidate, setOnboardingCandidate] = useState(false)
  const [onboardingInitialized, setOnboardingInitialized] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingLanguage, setOnboardingLanguage] = useState<AppState['settings']['language']>(
    appState.settings.language,
  )
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [onboardingStatusPending, setOnboardingStatusPending] = useState(false)
  const [onboardingSetupSkipped, setOnboardingSetupSkipped] = useState(false)
  const [onboardingImportState, setOnboardingImportState] = useState<OnboardingImportState>('idle')
  const [onboardingImportNotice, setOnboardingImportNotice] = useState<string | null>(null)
  const [onboardingImportError, setOnboardingImportError] = useState<string | null>(null)
  const [profileDrafts, setProfileDrafts] = useState<Record<Provider, ProfileDraft>>({
    codex: emptyProfileDraft(),
    claude: emptyProfileDraft(),
  })
  const text = useMemo(() => getLocaleText(appState.settings.language), [appState.settings.language])
  const codexChatSettings = useMemo(
    () => ({
      codexPersonality: appState.settings.codexPersonality,
      codexFastMode: appState.settings.codexFastMode,
      codexDestructiveCommandProtectionEnabled:
        appState.settings.codexDestructiveCommandProtectionEnabled,
      codexIsolatedHomeEnabled: appState.settings.codexIsolatedHomeEnabled,
    }),
    [
      appState.settings.codexDestructiveCommandProtectionEnabled,
      appState.settings.codexFastMode,
      appState.settings.codexIsolatedHomeEnabled,
      appState.settings.codexPersonality,
    ],
  )
  const panelText = useMemo(() => getPanelText(appState.settings.language), [appState.settings.language])
  const topTabText = useMemo(() => getTopTabText(appState.settings.language), [appState.settings.language])
  const autoUrgeDescription = appState.settings.language === 'zh-CN'
    ? '\u5728\u8fd9\u91cc\u4fdd\u5b58\u591a\u4e2a\u547d\u540d\u7684\u97ad\u7b56\u7c7b\u578b\uff1b\u5f00\u542f\u540e\u53ea\u4f1a\u8ba9\u6bcf\u4e2a\u4f1a\u8bdd\u53ef\u4ee5\u624b\u52a8\u542f\u7528\uff0c\u5177\u4f53\u4f7f\u7528\u54ea\u79cd\u7c7b\u578b\u5728\u4f1a\u8bdd\u5185\u5355\u72ec\u9009\u3002'
    : 'Save multiple named urge types here. Enabling the feature only makes it available per chat, and each chat still chooses its own type manually.'
  const resilientProxyText = useMemo(() => getResilientProxyText(panelText), [panelText])
  const modelPromptRulesSummary = useMemo(
    () => getModelPromptRulesSummary(appState.settings.modelPromptRules ?? [], appState.settings.language),
    [appState.settings.language, appState.settings.modelPromptRules],
  )
  const [proxyStats, setProxyStats] = useState<ProxyStatsSummary | null>(null)
  const [proxyStatsRange, setProxyStatsRange] = useState<'all' | 'session' | '1h' | '24h'>('all')
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'ready' | 'no-update' | 'error'>('idle')
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null)
  const [codexFastModeDialogOpen, setCodexFastModeDialogOpen] = useState(false)
  const [remoteMonitorDialogOpen, setRemoteMonitorDialogOpen] = useState(false)
  const [remoteMonitorInfo, setRemoteMonitorInfo] = useState<RemoteMonitorStartResponse | null>(null)
  const [remoteMonitorError, setRemoteMonitorError] = useState<string | null>(null)
  const [remoteMonitorClientCount, setRemoteMonitorClientCount] = useState(0)
  const [remoteMonitorLinkCopied, setRemoteMonitorLinkCopied] = useState(false)
  const [clearUserDataDialogOpen, setClearUserDataDialogOpen] = useState(false)
  const [clearUserDataPending, setClearUserDataPending] = useState(false)
  const [closeWorkspaceDialogColumnId, setCloseWorkspaceDialogColumnId] = useState<string | null>(null)
  const [closeWorkspacePending, setCloseWorkspacePending] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [weatherCityDraft, setWeatherCityDraft] = useState('')
  const [weatherCitySuggestions, setWeatherCitySuggestions] = useState<CitySuggestion[]>([])
  const [weatherCitySuggestionsOpen, setWeatherCitySuggestionsOpen] = useState(false)
  const [weatherCitySelectedIndex, setWeatherCitySelectedIndex] = useState(0)
  const weatherCityTimerRef = useRef<number>(0)
  const weatherCityWrapperRef = useRef<HTMLDivElement>(null)
  const onboardingText = useMemo(() => getOnboardingText(onboardingLanguage), [onboardingLanguage])
  const activeTab = appState.settings.activeTopTab
  const settingsOpen = activeTab === 'settings'
  const routingOpen = activeTab === 'routing'
  const historyProxyStats = proxyStats?.history ?? emptyProxyStatsCounts
  const currentProxyStats = proxyStats?.currentSession ?? emptyProxyStatsCounts
  const displayedProxyStats = proxyStatsRange === 'session' ? currentProxyStats : historyProxyStats
  const topTabs = useMemo<ReadonlyArray<{ id: TopTabName; label: string }>>(
    () => [
      { id: 'ambience', label: topTabText.ambience },
      { id: 'routing', label: topTabText.routing },
      { id: 'settings', label: topTabText.settings },
    ],
    [topTabText],
  )
  const availableQuickToolModels = useMemo(
    () => getAvailableQuickToolModels(appState.settings, appState.columns),
    [appState.settings, appState.columns],
  )
  const autoUrgeProfileTemplate =
    appState.settings.autoUrgeProfiles[appState.settings.autoUrgeProfiles.length - 1] ?? null
  const activeAutoUrgeProfile =
    appState.settings.autoUrgeProfiles.find(
      (profile) => profile.id === appState.settings.autoUrgeActiveProfileId,
    ) ??
    appState.settings.autoUrgeProfiles[0] ??
    null
  const isDesktopRuntime = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'
  const desktopPlatform = useMemo(() => {
    if (!isDesktopRuntime || typeof navigator === 'undefined') {
      return 'unknown'
    }

    const userAgent = navigator.userAgent.toLowerCase()

    if (userAgent.includes('windows')) {
      return 'win32'
    }

    if (userAgent.includes('mac os')) {
      return 'darwin'
    }

    if (userAgent.includes('linux')) {
      return 'linux'
    }

    return 'unknown'
  }, [isDesktopRuntime])
  const usesCustomWindowFrame = desktopPlatform === 'win32' || desktopPlatform === 'linux'
  const desktopPlatformClass = desktopPlatform === 'unknown' ? '' : ` is-${desktopPlatform}`

  const activeStreamsRef = useRef(new Map<string, ActiveStream>())
  const queuedSendRequestsRef = useRef(
    new Map<string, QueuedSendRequest[]>(),
  )
  const queueFollowUpDuringStreamRef = useRef(new Map<string, boolean>())
  const pendingAskUserDuringStreamRef = useRef(new Map<string, boolean>())
  const stopCompletionFallbackTimersRef = useRef(
    new Map<string, number>(),
  )
  const stoppedRunReasonRef = useRef(new Map<string, StoppedRunReason>())
  const runStartedAtRef = useRef(new Map<string, number>())
  const appStateRef = useRef(appState)
  const activePaneTargetRef = useRef<PaneTarget | null>(null)
  const streamRetryCountRef = useRef(new Map<string, number>())
  const resumeSessionLoopCountRef = useRef(new Map<string, number>())
  const streamRecoveryTurnRef = useRef(new Map<string, StreamRecoveryTurnSnapshot>())
  const localRecoveryStatsRef = useRef(new Map<string, LocalRecoveryStatsState>())
  const [cardRecoveryStatuses, setCardRecoveryStatuses] = useState<
    ReadonlyMap<string, CardRecoveryStatus>
  >(() => new Map())
  const [queuedSendSummaries, setQueuedSendSummaries] = useState<
    ReadonlyMap<string, QueuedSendSummary>
  >(() => new Map())
  const recoveryResumedTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const updateRecoveryStatus = useCallback(
    (
      cardId: string,
      updater: (previous: CardRecoveryStatus | undefined) => CardRecoveryStatus | undefined,
    ) => {
      setCardRecoveryStatuses((current) => {
        const previous = current.get(cardId)
        const next = updater(previous)
        if (previous === next) return current
        const copy = new Map(current)
        if (next === undefined) copy.delete(cardId)
        else copy.set(cardId, next)
        return copy
      })
    },
    [],
  )
  const clearRecoveryResumedTimer = useCallback((cardId: string) => {
    const timer = recoveryResumedTimersRef.current.get(cardId)
    if (timer !== undefined) {
      clearTimeout(timer)
      recoveryResumedTimersRef.current.delete(cardId)
    }
  }, [])
  const markRecoveryReconnecting = useCallback(
    (cardId: string, retryCount: number, maxAttempts = defaultRecoverableStreamRetryLimit) => {
      clearRecoveryResumedTimer(cardId)
      updateRecoveryStatus(cardId, (previous) =>
        computeRecoveryStatusAfterRetryScheduled(retryCount, maxAttempts, previous),
      )
    },
    [clearRecoveryResumedTimer, updateRecoveryStatus],
  )
  const markRecoveryResumedIfActive = useCallback(
    (cardId: string) => {
      updateRecoveryStatus(cardId, (previous) => {
        const next = computeRecoveryStatusAfterSuccess(previous)
        if (next?.kind === 'resumed' && previous?.kind === 'reconnecting') {
          clearRecoveryResumedTimer(cardId)
          const timer = setTimeout(() => {
            recoveryResumedTimersRef.current.delete(cardId)
            updateRecoveryStatus(cardId, (inner) =>
              inner?.kind === 'resumed' ? undefined : inner,
            )
          }, 2000)
          recoveryResumedTimersRef.current.set(cardId, timer)
        }
        return next
      })
    },
    [clearRecoveryResumedTimer, updateRecoveryStatus],
  )
  const markRecoveryFailed = useCallback(
    (cardId: string) => {
      clearRecoveryResumedTimer(cardId)
      updateRecoveryStatus(cardId, () => computeRecoveryStatusAfterFinalFailure())
    },
    [clearRecoveryResumedTimer, updateRecoveryStatus],
  )
  const clearRecoveryStatusIfAllowed = useCallback(
    (cardId: string) => {
      updateRecoveryStatus(cardId, (previous) =>
        shouldClearRecoveryStatusOnStreamIdle(previous) ? undefined : previous,
      )
      clearRecoveryResumedTimer(cardId)
    },
    [clearRecoveryResumedTimer, updateRecoveryStatus],
  )
  const forceResetRecoveryStatus = useCallback(
    (cardId: string) => {
      clearRecoveryResumedTimer(cardId)
      updateRecoveryStatus(cardId, () => undefined)
    },
    [clearRecoveryResumedTimer, updateRecoveryStatus],
  )
  const sendMessageRef = useRef<(
    (
      columnId: string,
      cardId: string,
      prompt: string,
      attachments: ImageAttachment[],
      options?: SendMessageOptions,
    ) => Promise<void>
  ) | null>(null)
  const recoverLiveStreamRef = useRef<(
    (
      columnId: string,
      cardId: string,
      options?: RecoverLiveStreamOptions,
    ) => Promise<boolean>
  ) | null>(null)
  const routingImportInputRef = useRef<HTMLInputElement | null>(null)
  const onboardingAutoSetupStartedRef = useRef(false)
  const setupRunStatusRef = useRef<SetupStatus | null>(null)
  const hydrateRequestIdRef = useRef(0)
  const hydrateRef = useRef<(() => Promise<void>) | null>(null)
  // Streaming delta buffer: coalesces per-token SSE deltas into a single
  // dispatch window to avoid re-rendering on every character when several
  // sessions stream at once.
  const deltaBufferRef = useRef(
    new Map<string, StreamDeltaBufferEntry>(),
  )
  const streamRenderFlushHandleRef = useRef<number | null>(null)
  const streamRenderCycleColumnIdsRef = useRef<string[]>([])
  const streamRenderInteractionDeferralStartedAtRef = useRef<number | null>(null)
  const lastStreamRenderInteractionAtRef = useRef(Number.NEGATIVE_INFINITY)
  const activityBufferRef = useRef(
    new Map<string, StreamActivityBufferEntry>(),
  )
  // Forensics counter: edits activities received per card during the live
  // stream. If the turn ends with edits received but zero edits messages in
  // state, something between onActivity and the reducer ate them — log loudly
  // so the next occurrence in the wild is attributable (真实事故取证缺口).
  const streamEditsActivityCountRef = useRef(new Map<string, number>())

  useEffect(() => {
    appStateRef.current = appState
    updateLatestKnownAppState(appState)
  }, [appState])

  // Stuck-pane crime-scene capture: Ctrl+Shift+F9 dumps focus/pane/hit-test
  // state to logs/, and repeated rescue firings auto-dump. This is how a
  // misroute recurrence in the wild finally becomes attributable instead of
  // symptom-guessed (docs/specs/composer-focus-loss/investigation.md §3.8).
  useEffect(() => installStuckPaneForensics(), [])

  useEffect(() => {
    const markInteraction = () => {
      lastStreamRenderInteractionAtRef.current = performance.now()
    }
    const interactionEvents: Array<keyof WindowEventMap> = [
      'pointerdown',
      'click',
      'keydown',
      'input',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'wheel',
    ]
    const listenerOptions: AddEventListenerOptions = { capture: true, passive: true }

    for (const eventName of interactionEvents) {
      window.addEventListener(eventName, markInteraction, listenerOptions)
    }

    return () => {
      for (const eventName of interactionEvents) {
        window.removeEventListener(eventName, markInteraction, true)
      }
    }
  }, [])

  // The panel-unmount probe needs the data-layer truth (appStateRef, updated
  // synchronously in applyActions) to tell "render dropped a tab the data
  // still holds" (React lane divergence) apart from a real tab removal.
  useEffect(() => {
    registerForensicsAppStateTruth(() => appStateRef.current)
    return () => registerForensicsAppStateTruth(null)
  }, [])

  const handleBoardWheelCapture = useCallback((event: WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) {
      return
    }

    const disposition = getBoardWheelDisposition(
      event.target,
      event.currentTarget,
      event.deltaY,
      event.nativeEvent.composedPath?.() ?? null,
    )
    if (disposition.type === 'pass') {
      return
    }

    if (disposition.type === 'scroll-card') {
      const maxScrollTop = Math.max(getVerticalScrollLimit(disposition.node), 0)
      const nextScrollTop = Math.min(Math.max(disposition.node.scrollTop + event.deltaY, 0), maxScrollTop)
      if (Math.abs(nextScrollTop - disposition.node.scrollTop) >= 1) {
        disposition.node.scrollTop = nextScrollTop
      }
      event.preventDefault()
      return
    }

    if (disposition.type === 'trap') {
      event.preventDefault()
      return
    }

    const scrollHost = getAppScrollHost()
    const maxScrollTop = Math.max(scrollHost.scrollHeight - scrollHost.clientHeight, 0)
    if (maxScrollTop <= 0) {
      return
    }

    const nextScrollTop = Math.min(Math.max(scrollHost.scrollTop + event.deltaY, 0), maxScrollTop)
    if (Math.abs(nextScrollTop - scrollHost.scrollTop) < 1) {
      return
    }

    scrollHost.scrollTop = nextScrollTop
    event.preventDefault()
  }, [])

  useEffect(() => {
    if (!usesCustomWindowFrame) {
      return
    }

    let cancelled = false
    void isWindowMaximized().then((maximized) => {
      if (!cancelled) {
        setWindowMaximized(maximized)
      }
    }).catch(() => undefined)

    const unsubscribe = onWindowMaximizedChanged((maximized) => {
      if (!cancelled) {
        setWindowMaximized(maximized)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [usesCustomWindowFrame])

  useEffect(() => {
    if (!routingOpen || routingSubTab !== 'proxy') {
      return
    }

    let cancelled = false
    const since = proxyStatsRange === '1h' ? Date.now() - 3_600_000
      : proxyStatsRange === '24h' ? Date.now() - 86_400_000
      : undefined

    const poll = () => {
      void fetchProxyStats(since).then((stats) => {
        if (!cancelled) setProxyStats(stats)
      }).catch(() => undefined)
    }

    poll()
    const handle = window.setInterval(poll, 5_000)
    return () => { cancelled = true; window.clearInterval(handle) }
  }, [routingOpen, routingSubTab, proxyStatsRange])

  useEffect(() => {
    let cancelled = false

    void getAppVersion().then((version) => {
      if (!cancelled) setAppVersion(version)
    }).catch(() => undefined)

    setUpdateStatus('checking')
    void checkForUpdate().then((result) => {
      if (cancelled) return
      setUpdateResult(result)

      if (result.error) {
        setUpdateStatus('error')
        return
      }

        if (result.hasUpdate && result.assetUrl) {
          setUpdateStatus('downloading')
          setDownloadProgress(0)
          void downloadUpdate(result.assetUrl).then((path) => {
            if (cancelled) return
            setDownloadedUpdatePath(path)
            setUpdateStatus('ready')
          }).catch(() => {
            if (!cancelled) setUpdateStatus('error')
        })
      } else {
        setUpdateStatus('no-update')
      }
    }).catch(() => {
      if (!cancelled) setUpdateStatus('error')
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (updateStatus !== 'downloading') return
    const unsubscribe = onUpdateDownloadProgress((progress) => {
      setDownloadProgress(progress)
    })
    return unsubscribe
  }, [updateStatus])

  useEffect(() => {
    if (!clearUserDataDialogOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !clearUserDataPending) {
        setClearUserDataDialogOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [clearUserDataDialogOpen, clearUserDataPending])

  useEffect(() => {
    if (!codexFastModeDialogOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCodexFastModeDialogOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [codexFastModeDialogOpen])

  const handleCheckForUpdate = useCallback(() => {
    setUpdateStatus('checking')
    setDownloadProgress(0)
    setDownloadedUpdatePath(null)

    void checkForUpdate().then((result) => {
      setUpdateResult(result)

      if (result.error) {
        setUpdateStatus('error')
        return
      }

      if (result.hasUpdate && result.assetUrl) {
        setUpdateStatus('downloading')
        void downloadUpdate(result.assetUrl).then((path) => {
          setDownloadedUpdatePath(path)
          setUpdateStatus('ready')
        }).catch(() => setUpdateStatus('error'))
      } else {
        setUpdateStatus('no-update')
      }
    }).catch(() => setUpdateStatus('error'))
  }, [])

  const handleInstallUpdate = useCallback(() => {
    if (!downloadedUpdatePath) return
    void installUpdate(downloadedUpdatePath).catch(() => setUpdateStatus('error'))
  }, [downloadedUpdatePath])

  const openClearUserDataDialog = useCallback(() => {
    setClearUserDataDialogOpen(true)
  }, [])

  const closeClearUserDataDialog = useCallback(() => {
    if (clearUserDataPending) {
      return
    }
    setClearUserDataDialogOpen(false)
  }, [clearUserDataPending])

  const handleClearUserData = useCallback(() => {
    setClearUserDataPending(true)
    void clearUserData().catch(() => {
      setClearUserDataPending(false)
      setClearUserDataDialogOpen(false)
    })
  }, [])

  const {
    persistImmediately,
    persistQueued,
    lastSavedSnapshot,
    lastQueuedSnapshot,
    lastSavedState,
    lastQueuedState,
  } = usePersistence(appState, appStateRef, loadStatus, setSaveStatus)

  const commitLoadedState = useCallback((
    state: AppState,
    recovery: {
      startup: StartupStateRecovery | null
      recentCrash: RecentCrashRecovery | null
      interruptedSessions: InterruptedSessionRecovery | null
    } = {
      startup: null,
      recentCrash: null,
      interruptedSessions: null,
    },
  ) => {
    const restoredQueuedSends = buildQueuedSendRuntimeState(state.columns)
    queuedSendRequestsRef.current = restoredQueuedSends.queues
    setQueuedSendSummaries(restoredQueuedSends.summaries)
    appStateRef.current = state
    updateLatestKnownAppState(state)
    void syncRuntimeSettings(state.settings).catch(() => undefined)
    const snapshot = getPersistenceVersion(state)
    lastSavedSnapshot.current = snapshot
    lastQueuedSnapshot.current = snapshot
    lastSavedState.current = state
    lastQueuedState.current = state
    setOnboardingCandidate(isFirstOpenState(state))
    setOnboardingInitialized(false)
    setOnboardingOpen(false)
    setOnboardingLanguage(state.settings.language)
    setOnboardingStatus(null)
    setOnboardingImportState('idle')
    setOnboardingImportNotice(null)
    setOnboardingImportError(null)
    setOnboardingSetupSkipped(false)
    setLoadError(null)
    setSaveStatus('saved')
    setStartupRecovery(recovery.startup)
    setRecentCrashRecovery(recovery.recentCrash)
    setInterruptedSessionRecovery(recovery.interruptedSessions)
    setStateRecoveryError(null)
    setRecentCrashActionError(null)
    setInterruptedSessionActionError(null)
    setInterruptedSessionActionPending(false)

    dispatch({ type: 'replace', state })
    setLoadStatus('ready')
  }, [
    lastQueuedSnapshot,
    lastQueuedState,
    lastSavedSnapshot,
    lastSavedState,
  ])

  const applyActions = useCallback((actions: IdeAction[]) => {
    if (actions.length === 0) {
      return appStateRef.current
    }

    const nextState = actions.reduce(ideReducer, appStateRef.current)
    appStateRef.current = nextState
    recordAppliedActionsForForensics(actions.map((action) => action.type))
    if (actions.some((action) => shouldSyncRuntimeSettings(action))) {
      void syncRuntimeSettings(nextState.settings).catch(() => undefined)
    }

    for (const action of actions) {
      dispatch(action)
    }

    return nextState
  }, [])

  const applyAction = useCallback((action: IdeAction) => applyActions([action]), [applyActions])

  const closeCodexFastModeDialog = useCallback(() => {
    setCodexFastModeDialogOpen(false)
  }, [])

  // 手机远程监工：打开弹窗即启动只读服务（幂等），关闭弹窗不停服务 ——
  // 用户扫完码就去沙发了，服务要一直挂着；只有点"停止监工"才真正关。
  const openRemoteMonitorDialog = useCallback(() => {
    setRemoteMonitorDialogOpen(true)
    setRemoteMonitorError(null)
    setRemoteMonitorLinkCopied(false)
    void startRemoteMonitor()
      .then((info) => {
        setRemoteMonitorInfo(info)
      })
      .catch((error: unknown) => {
        setRemoteMonitorError(error instanceof Error ? error.message : String(error))
      })
  }, [])

  const closeRemoteMonitorDialog = useCallback(() => {
    setRemoteMonitorDialogOpen(false)
  }, [])

  const handleStopRemoteMonitor = useCallback(() => {
    void stopRemoteMonitor().catch(() => undefined)
    setRemoteMonitorInfo(null)
    setRemoteMonitorClientCount(0)
    setRemoteMonitorDialogOpen(false)
  }, [])

  const handleCopyRemoteMonitorLink = useCallback(() => {
    const url = remoteMonitorInfo?.url
    if (!url) {
      return
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setRemoteMonitorLinkCopied(true)
        window.setTimeout(() => setRemoteMonitorLinkCopied(false), 2000)
      })
      .catch(() => undefined)
  }, [remoteMonitorInfo])

  useEffect(() => {
    if (!remoteMonitorDialogOpen || !remoteMonitorInfo) {
      return
    }

    const timer = window.setInterval(() => {
      void fetchRemoteMonitorStatus()
        .then((status) => {
          setRemoteMonitorClientCount(status.clientCount)
          if (!status.running) {
            setRemoteMonitorInfo(null)
          }
        })
        .catch(() => undefined)
    }, 4000)

    return () => window.clearInterval(timer)
  }, [remoteMonitorDialogOpen, remoteMonitorInfo])

  const handleCodexFastModeToggle = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        setCodexFastModeDialogOpen(true)
        return
      }

      setCodexFastModeDialogOpen(false)
      applyAction({
        type: 'updateSettings',
        patch: { codexFastMode: false },
      })
    },
    [applyAction],
  )

  const confirmCodexFastMode = useCallback(() => {
    applyAction({
      type: 'updateSettings',
      patch: { codexFastMode: true },
    })
    setCodexFastModeDialogOpen(false)
  }, [applyAction])

  const persistAfterAction = useCallback(
    (actionType: IdeAction['type'], nextState: AppState) => {
      if (shouldUseQueuedPersistenceForAction(actionType)) {
        persistQueued(nextState)
        return
      }

      persistImmediately(nextState)
    },
    [persistImmediately, persistQueued],
  )

  const persistAfterActions = useCallback(
    (actions: IdeAction[], nextState: AppState) => {
      if (actions.length > 0 && actions.every((action) => shouldUseQueuedPersistenceForAction(action.type))) {
        persistQueued(nextState)
        return
      }

      persistImmediately(nextState)
    },
    [persistImmediately, persistQueued],
  )

  const flushBufferedAssistantDeltaForCard = useCallback(
    (cardId: string) => {
      const bufferEntries = takeStreamDeltaBufferEntriesForCard(deltaBufferRef.current, cardId)
      if (bufferEntries.length === 0) {
        return appStateRef.current
      }

      if (
        deltaBufferRef.current.size === 0 &&
        activityBufferRef.current.size === 0 &&
        streamRenderCycleColumnIdsRef.current.length === 0 &&
        streamRenderFlushHandleRef.current !== null
      ) {
        window.clearTimeout(streamRenderFlushHandleRef.current)
        streamRenderFlushHandleRef.current = null
        streamRenderInteractionDeferralStartedAtRef.current = null
      }

      const actions: IdeAction[] = bufferEntries
        .filter((entry) => entry.buffer.length > 0)
        .map((entry) => ({
          type: 'appendAssistantDelta',
          columnId: entry.columnId,
          cardId: entry.cardId,
          messageId: entry.messageId,
          delta: entry.buffer,
          model: entry.model,
        }))
      if (actions.length === 0) {
        return appStateRef.current
      }

      return applyActions(actions)
    },
    [applyActions],
  )

  const flushStreamRenderBuffers = useCallback(() => {
    streamRenderFlushHandleRef.current = null
    const cycleColumnIds = streamRenderCycleColumnIdsRef.current
    const hasBufferedRenderWork =
      cycleColumnIds.length > 0 ||
      deltaBufferRef.current.size > 0 ||
      activityBufferRef.current.size > 0
    if (!hasBufferedRenderWork) {
      streamRenderInteractionDeferralStartedAtRef.current = null
      return
    }

    const nowMs = performance.now()
    const firstAttemptAtMs = streamRenderInteractionDeferralStartedAtRef.current ?? nowMs
    const interactionDelayMs = getStreamRenderInteractionDelayMs({
      nowMs,
      lastInteractionAtMs: lastStreamRenderInteractionAtRef.current,
      firstAttemptAtMs,
    })
    if (interactionDelayMs > 0) {
      streamRenderInteractionDeferralStartedAtRef.current = firstAttemptAtMs
      streamRenderFlushHandleRef.current = window.setTimeout(
        flushStreamRenderBuffers,
        interactionDelayMs,
      )
      return
    }
    streamRenderInteractionDeferralStartedAtRef.current = null

    if (cycleColumnIds.length === 0) {
      cycleColumnIds.push(...getStreamRenderBufferColumnIds(
        deltaBufferRef.current,
        activityBufferRef.current,
      ))
    }

    const columnId = cycleColumnIds.shift()
    if (columnId) {
      const actions = drainStreamRenderBufferActionsForColumn(
        deltaBufferRef.current,
        activityBufferRef.current,
        columnId,
      )
      if (actions.length > 0) {
        // Delta and activity timers used to race independently and flush every
        // streaming column in one full-board commit. On the production
        // software compositor that saturated the GPU process and eventually
        // entered BrowserWindow unresponsive with no JS stack. Keep one urgent
        // React lane, but isolate each commit to one column and yield between
        // columns so input/compositor work can run between paint slices.
        persistAfterActions(actions, applyActions(actions))
      }
    }

    if (cycleColumnIds.length > 0) {
      streamRenderFlushHandleRef.current = window.setTimeout(
        flushStreamRenderBuffers,
        streamRenderColumnYieldMs,
      )
      return
    }

    if (deltaBufferRef.current.size > 0 || activityBufferRef.current.size > 0) {
      streamRenderFlushHandleRef.current = window.setTimeout(
        flushStreamRenderBuffers,
        getStreamRenderFlushIntervalMs(activeStreamsRef.current.size),
      )
    }
  }, [applyActions, persistAfterActions])

  const flushBufferedActivitiesForCard = useCallback(
    (cardId: string) => {
      const entry = activityBufferRef.current.get(cardId)
      if (!entry || entry.messages.length === 0) {
        return appStateRef.current
      }

      activityBufferRef.current.delete(cardId)
      if (
        activityBufferRef.current.size === 0 &&
        deltaBufferRef.current.size === 0 &&
        streamRenderCycleColumnIdsRef.current.length === 0 &&
        streamRenderFlushHandleRef.current !== null
      ) {
        window.clearTimeout(streamRenderFlushHandleRef.current)
        streamRenderFlushHandleRef.current = null
        streamRenderInteractionDeferralStartedAtRef.current = null
      }

      const action: IdeAction = {
        type: 'upsertMessages',
        columnId: entry.columnId,
        cardId: entry.cardId,
        messages: entry.messages,
      }
      return applyAction(action)
    },
    [applyAction],
  )

  const enqueueActivityMessage = useCallback(
    (columnId: string, cardId: string, message: ChatMessage) => {
      const buffer = activityBufferRef.current
      const existing = buffer.get(cardId)
      if (existing) {
        const existingIndex = existing.messages.findIndex((current) => current.id === message.id)
        if (existingIndex >= 0) {
          existing.messages[existingIndex] = message
        } else {
          existing.messages.push(message)
        }
      } else {
        buffer.set(cardId, { columnId, cardId, messages: [message] })
      }

      if (
        streamRenderFlushHandleRef.current === null &&
        streamRenderCycleColumnIdsRef.current.length === 0
      ) {
        streamRenderFlushHandleRef.current = window.setTimeout(
          flushStreamRenderBuffers,
          getStreamRenderFlushIntervalMs(activeStreamsRef.current.size),
        )
      }
    },
    [flushStreamRenderBuffers],
  )

  const updateAutoUrgeProfiles = useCallback(
    (
      autoUrgeProfiles: AutoUrgeProfile[],
      autoUrgeActiveProfileId: string = appState.settings.autoUrgeActiveProfileId,
    ) => {
      applyAction({
        type: 'updateSettings',
        patch: {
          autoUrgeProfiles,
          autoUrgeActiveProfileId,
        },
      })
    },
    [applyAction, appState.settings.autoUrgeActiveProfileId],
  )

  const refreshOllamaStatus = useCallback(async () => {
    try {
      setOllamaStatus(await fetchOllamaStatus())
    } catch {
      setOllamaStatus(null)
    }
  }, [])

  const handleOllamaInstall = useCallback(async () => {
    setOllamaActionPending(true)
    try {
      await runOllamaInstall()
    } catch {
      // status refresh below surfaces the failure
    } finally {
      setOllamaActionPending(false)
      void refreshOllamaStatus()
    }
  }, [refreshOllamaStatus])

  const handleOllamaPullRecommended = useCallback(async () => {
    const model = ollamaStatus?.recommendedModel.name
    if (!model) {
      return
    }

    setOllamaActionPending(true)
    try {
      await runOllamaPull(model)
    } catch {
      // status refresh below surfaces the failure
    } finally {
      setOllamaActionPending(false)
      void refreshOllamaStatus()
    }
  }, [ollamaStatus?.recommendedModel.name, refreshOllamaStatus])

  const ollamaTaskState = ollamaStatus?.task.state
  useEffect(() => {
    if (!appState.settings.autoUrgeEnabled || appState.settings.activeTopTab !== 'settings') {
      return
    }

    let cancelled = false
    const sync = async () => {
      try {
        const status = await fetchOllamaStatus()
        if (!cancelled) {
          setOllamaStatus(status)
        }
      } catch {
        if (!cancelled) {
          setOllamaStatus(null)
        }
      }
    }

    void sync()
    const timer =
      ollamaTaskState === 'running' ? window.setInterval(() => void sync(), 2000) : null

    return () => {
      cancelled = true
      if (timer !== null) {
        window.clearInterval(timer)
      }
    }
  }, [appState.settings.autoUrgeEnabled, appState.settings.activeTopTab, ollamaTaskState])

  const updateAutoUrgeProfile = useCallback(
    (
      profileId: string,
      patch: Partial<
        Pick<AutoUrgeProfile, 'name' | 'message' | 'successKeyword' | 'judgeMode' | 'judgeModel'>
      >,
    ) => {
      updateAutoUrgeProfiles(
        appState.settings.autoUrgeProfiles.map((profile) =>
          profile.id === profileId
            ? {
                ...profile,
                ...patch,
              }
            : profile,
        ),
      )
    },
    [appState.settings.autoUrgeProfiles, updateAutoUrgeProfiles],
  )

  const setActiveAutoUrgeProfile = useCallback(
    (profileId: string) => {
      if (profileId === appState.settings.autoUrgeActiveProfileId) {
        return
      }

      updateAutoUrgeProfiles(appState.settings.autoUrgeProfiles, profileId)
    },
    [
      appState.settings.autoUrgeActiveProfileId,
      appState.settings.autoUrgeProfiles,
      updateAutoUrgeProfiles,
    ],
  )

  const addAutoUrgeProfile = useCallback(() => {
    const nextProfile = createAutoUrgeProfile(
      appState.settings.language,
      {
        message: autoUrgeProfileTemplate?.message,
        successKeyword: autoUrgeProfileTemplate?.successKeyword,
      },
      { index: appState.settings.autoUrgeProfiles.length },
    )

    updateAutoUrgeProfiles(
      [...appState.settings.autoUrgeProfiles, nextProfile],
      nextProfile.id,
    )
  }, [
    appState.settings.autoUrgeProfiles,
    appState.settings.language,
    autoUrgeProfileTemplate,
    updateAutoUrgeProfiles,
  ])

  const removeAutoUrgeProfile = useCallback(
    (profileId: string) => {
      const remainingProfiles = appState.settings.autoUrgeProfiles.filter((profile) => profile.id !== profileId)

      if (remainingProfiles.length === 0) {
        const fallbackProfile = createAutoUrgeProfile(appState.settings.language, {}, { index: 0 })
        updateAutoUrgeProfiles([fallbackProfile], fallbackProfile.id)
        return
      }

      updateAutoUrgeProfiles(
        remainingProfiles,
        appState.settings.autoUrgeActiveProfileId === profileId
          ? remainingProfiles[0]?.id
          : appState.settings.autoUrgeActiveProfileId,
      )
    },
    [
      appState.settings.autoUrgeActiveProfileId,
      appState.settings.autoUrgeProfiles,
      appState.settings.language,
      updateAutoUrgeProfiles,
    ],
  )

  const renderAutoUrgeSettings = () => (
    <>
      <label className="settings-toggle" htmlFor="auto-urge-toggle">
        <span>{text.autoUrgeLabel}</span>
        <input
          id="auto-urge-toggle"
          type="checkbox"
          checked={appState.settings.autoUrgeEnabled}
          onChange={(event) =>
            applyAction({
              type: 'updateSettings',
              patch: { autoUrgeEnabled: event.target.checked },
            })
          }
        />
      </label>
      <p className="settings-note">{autoUrgeDescription}</p>

      {appState.settings.autoUrgeEnabled && (
        <div className="settings-sub-field auto-urge-settings">
          <label className="settings-toggle" htmlFor="global-urge-control-toggle">
            <span>{text.autoUrgeGlobalControlLabel}</span>
            <input
              id="global-urge-control-toggle"
              type="checkbox"
              checked={appState.settings.autoUrgeGlobalControlEnabled}
              onChange={(event) =>
                applyAction({
                  type: 'updateSettings',
                  patch: { autoUrgeGlobalControlEnabled: event.target.checked },
                })
              }
            />
          </label>
          <p className="settings-note">{text.autoUrgeGlobalControlHint}</p>

          <div className="auto-urge-settings-header">
            <div className="settings-row-copy auto-urge-types-header">
              <label>{text.autoUrgeTypesLabel}</label>
            </div>
            <div className="settings-actions auto-urge-settings-actions">
              <AppButton type="button" onClick={addAutoUrgeProfile}>
                {text.autoUrgeAddType}
              </AppButton>
            </div>
          </div>

          <div className="auto-urge-profile-list">
            {appState.settings.autoUrgeProfiles.map((profile) => {
              const active = profile.id === activeAutoUrgeProfile?.id
              const displayName = profile.name.trim() || text.autoUrgeTypeNamePlaceholder
              const messagePreview = profile.message.trim()
              const usesLocalModelJudge = profile.judgeMode === 'local-model'
              const successKeyword = usesLocalModelJudge
                ? profile.judgeModel.trim() || text.autoUrgeJudgeModeLocalModel
                : profile.successKeyword.trim() || '-'
              const successKeywordLabel = usesLocalModelJudge
                ? text.autoUrgeJudgeModeLabel
                : text.autoUrgeSuccessKeywordLabel

              return (
                <div
                  key={profile.id}
                  className={`auto-urge-profile-card${active ? ' is-active' : ' is-inactive'}`}
                >
                  <div className="auto-urge-profile-card-header">
                    {active ? (
                      <div className="auto-urge-profile-card-heading">
                        <div className="auto-urge-profile-card-title-row">
                          <div className="auto-urge-profile-card-title">{displayName}</div>
                          <span className="auto-urge-profile-card-state">{text.autoUrgeCurrentType}</span>
                        </div>
                        <div className="auto-urge-profile-card-meta">
                          <span className="auto-urge-profile-card-keyword-label">
                            {successKeywordLabel}
                          </span>
                          <span className="auto-urge-profile-card-keyword">{successKeyword}</span>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="auto-urge-profile-card-select"
                        onClick={() => setActiveAutoUrgeProfile(profile.id)}
                      >
                        <div className="auto-urge-profile-card-heading">
                          <div className="auto-urge-profile-card-title">{displayName}</div>
                          <div className="auto-urge-profile-card-meta">
                            <span className="auto-urge-profile-card-keyword-label">
                              {successKeywordLabel}
                            </span>
                            <span className="auto-urge-profile-card-keyword">{successKeyword}</span>
                          </div>
                          {messagePreview ? (
                            <p className="auto-urge-profile-card-preview">{messagePreview}</p>
                          ) : null}
                        </div>
                      </button>
                    )}
                    <div className="settings-actions auto-urge-profile-actions">
                      <AppButton
                        type="button"
                        disabled={appState.settings.autoUrgeProfiles.length === 1}
                        onClick={() => removeAutoUrgeProfile(profile.id)}
                      >
                        {text.autoUrgeRemoveType}
                      </AppButton>
                    </div>
                  </div>

                  {active ? (
                    <div className="auto-urge-profile-card-body">
                      <div className="auto-urge-profile-field-grid">
                        <div className="auto-urge-profile-field">
                          <label className="settings-label" htmlFor={`auto-urge-name-${profile.id}`}>
                            {text.autoUrgeTypeNameLabel}
                          </label>
                          <input
                            id={`auto-urge-name-${profile.id}`}
                            className="control settings-input"
                            value={profile.name}
                            onChange={(event) =>
                              updateAutoUrgeProfile(profile.id, { name: event.target.value })
                            }
                            placeholder={text.autoUrgeTypeNamePlaceholder}
                          />
                        </div>

                        <div className="auto-urge-profile-field">
                          <label className="settings-label" htmlFor={`auto-urge-judge-mode-${profile.id}`}>
                            {text.autoUrgeJudgeModeLabel}
                          </label>
                          <select
                            id={`auto-urge-judge-mode-${profile.id}`}
                            className="control settings-input"
                            value={profile.judgeMode}
                            onChange={(event) =>
                              updateAutoUrgeProfile(profile.id, {
                                judgeMode:
                                  event.target.value === 'local-model' ? 'local-model' : 'keyword',
                              })
                            }
                          >
                            <option value="keyword">{text.autoUrgeJudgeModeKeyword}</option>
                            <option value="local-model">{text.autoUrgeJudgeModeLocalModel}</option>
                          </select>
                        </div>

                        {usesLocalModelJudge ? (
                          <div className="auto-urge-profile-field">
                            <label
                              className="settings-label"
                              htmlFor={`auto-urge-judge-model-${profile.id}`}
                            >
                              {text.autoUrgeJudgeModelLabel}
                            </label>
                            {(() => {
                              const installedModels = ollamaStatus?.models.map((model) => model.name) ?? []
                              const currentModel = profile.judgeModel.trim()
                              const options = currentModel && !installedModels.includes(currentModel)
                                ? [currentModel, ...installedModels]
                                : installedModels

                              if (options.length === 0) {
                                return <p className="settings-note">{text.autoUrgeJudgeModelEmpty}</p>
                              }

                              return (
                                <select
                                  id={`auto-urge-judge-model-${profile.id}`}
                                  className="control settings-input"
                                  value={currentModel}
                                  onChange={(event) =>
                                    updateAutoUrgeProfile(profile.id, { judgeModel: event.target.value })
                                  }
                                >
                                  {currentModel ? null : <option value="">—</option>}
                                  {options.map((modelName) => (
                                    <option key={modelName} value={modelName}>
                                      {modelName}
                                    </option>
                                  ))}
                                </select>
                              )
                            })()}
                          </div>
                        ) : (
                          <div className="auto-urge-profile-field">
                            <label className="settings-label" htmlFor={`auto-urge-keyword-${profile.id}`}>
                              {text.autoUrgeSuccessKeywordLabel}
                            </label>
                            <input
                              id={`auto-urge-keyword-${profile.id}`}
                              className="control settings-input"
                              value={profile.successKeyword}
                              onChange={(event) =>
                                updateAutoUrgeProfile(profile.id, { successKeyword: event.target.value })
                              }
                              placeholder={text.autoUrgeSuccessKeywordPlaceholder}
                            />
                          </div>
                        )}

                        <div className="auto-urge-profile-field auto-urge-profile-field-message">
                          <label className="settings-label" htmlFor={`auto-urge-message-${profile.id}`}>
                            {text.autoUrgeMessageLabel}
                          </label>
                          <textarea
                            id={`auto-urge-message-${profile.id}`}
                            className="control settings-input settings-textarea"
                            value={profile.message}
                            onChange={(event) =>
                              updateAutoUrgeProfile(profile.id, { message: event.target.value })
                            }
                            placeholder={text.autoUrgeMessagePlaceholder}
                            rows={4}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>

          <div className="ollama-settings">
            <div className="auto-urge-settings-header">
              <div className="settings-row-copy">
                <label>{text.ollamaSectionTitle}</label>
              </div>
              <div className="settings-actions">
                <AppButton
                  type="button"
                  disabled={ollamaActionPending}
                  onClick={() => void refreshOllamaStatus()}
                >
                  {text.ollamaRefreshButton}
                </AppButton>
              </div>
            </div>
            <p className="settings-note">{text.ollamaSectionHint}</p>
            <p className="settings-note ollama-status-line">
              {ollamaStatus === null
                ? text.ollamaStatusNotInstalled
                : ollamaStatus.running
                  ? `${text.ollamaStatusRunning}${ollamaStatus.version ? ` · v${ollamaStatus.version}` : ''}`
                  : ollamaStatus.installed
                    ? text.ollamaStatusNotRunning
                    : text.ollamaStatusNotInstalled}
            </p>
            {ollamaStatus?.running ? (
              <p className="settings-note">
                {text.ollamaModelsLabel}
                {': '}
                {ollamaStatus.models.length > 0
                  ? ollamaStatus.models.map((model) => model.name).join(', ')
                  : '-'}
              </p>
            ) : null}
            <div className="settings-actions ollama-actions">
              {!ollamaStatus?.running ? (
                <AppButton
                  type="button"
                  disabled={ollamaActionPending || ollamaStatus?.task.state === 'running'}
                  onClick={() => void handleOllamaInstall()}
                >
                  {ollamaStatus?.installed ? text.ollamaStartButton : text.ollamaInstallButton}
                </AppButton>
              ) : null}
              {ollamaStatus?.running &&
              !ollamaStatus.models.some(
                (model) => model.name === ollamaStatus.recommendedModel.name,
              ) ? (
                <AppButton
                  type="button"
                  disabled={ollamaActionPending || ollamaStatus.task.state === 'running'}
                  onClick={() => void handleOllamaPullRecommended()}
                >
                  {`${text.ollamaPullRecommendedButton} ${ollamaStatus.recommendedModel.name}（${text.ollamaRecommendHint} ${ollamaStatus.recommendedModel.totalMemoryGb}GB）`}
                </AppButton>
              ) : null}
            </div>
            {ollamaStatus && ollamaStatus.task.state !== 'idle' ? (
              <p
                className={`settings-note ollama-task-line${ollamaStatus.task.state === 'error' ? ' is-error' : ''}`}
              >
                {ollamaStatus.task.state === 'running'
                  ? text.ollamaTaskRunningLabel
                  : ollamaStatus.task.state === 'error'
                    ? text.ollamaTaskErrorLabel
                    : text.ollamaTaskSuccessLabel}
                {ollamaStatus.task.logs.length > 0
                  ? ` — ${ollamaStatus.task.logs[ollamaStatus.task.logs.length - 1]?.message ?? ''}`
                  : ''}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </>
  )

  const setAutoUrgeEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled === appState.settings.autoUrgeEnabled) {
        return
      }

      applyAction({
        type: 'updateSettings',
        patch: { autoUrgeEnabled: enabled },
      })
    },
    [appState.settings.autoUrgeEnabled, applyAction],
  )

  const setActiveTopTab = useCallback(
    (nextTab: TopTabName) => {
      if (appStateRef.current.settings.activeTopTab === nextTab) {
        return
      }

      applyAction({
        type: 'updateSettings',
        patch: { activeTopTab: nextTab },
      })
    },
    [applyAction],
  )

  const handleToggleWindowMaximize = useCallback(() => {
    void toggleMaximizeWindow().then((maximized) => {
      setWindowMaximized(maximized)
    }).catch(() => undefined)
  }, [])

  const syncProviderStatuses = useCallback(async () => {
    try {
      setProviders(await fetchProviders())
    } catch {
      // Ignore background refresh failures and keep the last known CLI status.
    }
  }, [])

  const loadSetup = useCallback(async () => {
    setSetupStatusPending(true)
    try {
      setSetupStatus(await fetchSetupStatus())
    } catch (error) {
      setSetupStatus({
        state: 'error',
        message: errorMessage(error, text.unexpectedError),
        logs: [],
      })
    } finally {
      setSetupStatusPending(false)
    }
  }, [text.unexpectedError])

  const loadOnboarding = useCallback(async () => {
    setOnboardingStatusPending(true)
    try {
      const status = await fetchOnboardingStatus()
      setOnboardingStatus(status)
      return status
    } finally {
      setOnboardingStatusPending(false)
    }
  }, [])

  const openRemediationPanel = useCallback(
    (provider: Provider, hint: 'switch-config' | 'env-setup') => {
      const providerLabel = getProviderLabel(appStateRef.current.settings.language, provider)

      if (hint === 'switch-config') {
        setSettingsNotice(null)
        setSwitchNotice(panelText.switchReminder(providerLabel))
        setActiveTopTab('routing')
        return
      }

      setSwitchNotice(null)
      setSettingsNotice(panelText.setupReminder(providerLabel))
      setActiveTopTab('settings')
    },
    [panelText, setActiveTopTab],
  )

  const updateDraft = useCallback((provider: Provider, patch: Partial<ProfileDraft>) => {
    setProfileDrafts((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        ...patch,
      },
    }))
  }, [])

  const addProviderProfile = useCallback(
    (provider: Provider) => {
      const draft = profileDrafts[provider]
      const apiKey = draft.apiKey.trim()

      if (!apiKey) {
        return
      }

      const profiles = appStateRef.current.settings.providerProfiles[provider].profiles
      const profile = {
        id: crypto.randomUUID(),
        name: draft.name.trim() || `${provider === 'claude' ? 'Claude' : 'Codex'} ${profiles.length + 1}`,
        baseUrl: draft.baseUrl.trim(),
        apiKey,
      }

      const actions: IdeAction[] = [
        {
          type: 'upsertProviderProfile',
          provider,
          profile,
        },
        {
          type: 'setActiveProviderProfile',
          provider,
          profileId: profile.id,
        },
      ]
      persistAfterActions(actions, applyActions(actions))

      setSwitchNotice(null)
      setProfileDrafts((current) => ({
        ...current,
        [provider]: emptyProfileDraft(),
      }))
    },
    [applyActions, persistAfterActions, profileDrafts],
  )

  const updateProviderProfile = useCallback(
    (
      provider: Provider,
      profileId: string,
      patch: Partial<Pick<ProfileDraft, 'name' | 'baseUrl' | 'apiKey'>>,
    ) => {
      const existing = appStateRef.current.settings.providerProfiles[provider].profiles.find(
        (profile) => profile.id === profileId,
      )

      if (!existing) {
        return
      }

      applyAction({
        type: 'upsertProviderProfile',
        provider,
        profile: {
          ...existing,
          ...patch,
        },
      })
      setSwitchNotice(null)
    },
    [applyAction],
  )

  const applyImportedRoutingProfiles = useCallback(
    (
      source: string,
      importedProfiles: readonly CcSwitchImportProfile[],
      language: AppState['settings']['language'] = appStateRef.current.settings.language,
    ) => {
      const currentProfiles = appStateRef.current.settings.providerProfiles
      const nextClaude = mergeImportedProviderProfiles(currentProfiles.claude, 'claude', importedProfiles)
      const nextCodex = mergeImportedProviderProfiles(currentProfiles.codex, 'codex', importedProfiles)
      const counts = summarizeImportedProfiles(importedProfiles)
      const importText = getRoutingImportText(language)

      applyAction({
        type: 'updateSettings',
        patch: {
          providerProfiles: {
            claude: nextClaude.collection,
            codex: nextCodex.collection,
          },
        },
      })

      setSwitchNotice(
        importText.importSummary(
          source,
          importedProfiles.length,
          counts.claude,
          counts.codex,
          nextClaude.added + nextCodex.added,
          nextClaude.updated + nextCodex.updated,
        ),
      )

      return importText.importSummary(
        source,
        importedProfiles.length,
        counts.claude,
        counts.codex,
        nextClaude.added + nextCodex.added,
        nextClaude.updated + nextCodex.updated,
      )
    },
    [applyAction],
  )

  const runCcSwitchImport = useCallback(
    async (
      request: { mode: 'default' } | { mode: 'upload'; fileName: string; dataBase64: string },
      language: AppState['settings']['language'] = appStateRef.current.settings.language,
    ) => {
      const importText = getRoutingImportText(language)
      setRoutingImportPending(true)

      try {
        const result = await importCcSwitchRouting(request)
        return {
          summary: applyImportedRoutingProfiles(result.source, result.importedProfiles, language),
        }
      } catch (error) {
        const message = importErrorMessage(error, importText.importError, importText.importTooLarge)
        setSwitchNotice(message)
        throw new Error(message)
      } finally {
        setRoutingImportPending(false)
      }
    },
    [applyImportedRoutingProfiles],
  )

  const openCcSwitchImportPicker = useCallback(() => {
    routingImportInputRef.current?.click()
  }, [])

  const handleCcSwitchFileImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''

      if (!file) {
        return
      }

      try {
        const dataBase64 = await readFileAsBase64(file)
        await runCcSwitchImport({
          mode: 'upload',
          fileName: file.name,
          dataBase64,
        })
      } catch (error) {
        setSwitchNotice(importErrorMessage(error, panelText.importError, panelText.importTooLarge))
      }
    },
    [panelText.importError, panelText.importTooLarge, runCcSwitchImport],
  )

  const clearStopCompletionFallbackTimer = useCallback((cardId: string) => {
    const fallbackTimer = stopCompletionFallbackTimersRef.current.get(cardId)
    if (fallbackTimer === undefined) {
      return
    }

    window.clearTimeout(fallbackTimer)
    stopCompletionFallbackTimersRef.current.delete(cardId)
  }, [])

  const closeStream = useCallback(async (cardId: string, stopRemote = false) => {
    const active = activeStreamsRef.current.get(cardId)
    if (!active) {
      runStartedAtRef.current.delete(cardId)
      streamRetryCountRef.current.delete(cardId)
      resumeSessionLoopCountRef.current.delete(cardId)
      streamRecoveryTurnRef.current.delete(cardId)
      queueFollowUpDuringStreamRef.current.delete(cardId)
      pendingAskUserDuringStreamRef.current.delete(cardId)
      return
    }

    // Flush any buffered streaming deltas for this card before tearing down
    // the stream. Otherwise a follow-up stream can overwrite the per-card
    // buffer before the next animation-frame flush and make visible text vanish.
    flushBufferedAssistantDeltaForCard(cardId)
    flushBufferedActivitiesForCard(cardId)

    active.source.close()
    activeStreamsRef.current.delete(cardId)
    runStartedAtRef.current.delete(cardId)
    clearStopCompletionFallbackTimer(cardId)
    streamRetryCountRef.current.delete(cardId)
    resumeSessionLoopCountRef.current.delete(cardId)
    streamRecoveryTurnRef.current.delete(cardId)
    queueFollowUpDuringStreamRef.current.delete(cardId)
    pendingAskUserDuringStreamRef.current.delete(cardId)
    const settledRecoveryStats = settleLocalRecoveryStatsRun(
      localRecoveryStatsRef.current.get(cardId),
      'abandoned',
    )
    localRecoveryStatsRef.current.delete(cardId)
    for (const event of settledRecoveryStats.events) {
      void recordProxyStatsEvent({
        provider: active.provider,
        event,
        endpoint: '/cli/local-stream',
      }).catch(() => undefined)
    }

    if (stopRemote) {
      await stopChat(active.streamId).catch(() => undefined)
    }
  }, [clearStopCompletionFallbackTimer, flushBufferedActivitiesForCard, flushBufferedAssistantDeltaForCard])

  const requestStopForCard = useCallback(
    async (cardId: string, reason: StoppedRunReason = 'manual') => {
      const active = activeStreamsRef.current.get(cardId)
      const owner = appStateRef.current.columns.find((column) => Boolean(column.cards[cardId]))
      const liveCard = owner?.cards[cardId]
      const streamId = active?.streamId ?? liveCard?.streamId

      if (!streamId) {
        return false
      }

      try {
        stoppedRunReasonRef.current.set(streamId, reason)
        await stopChat(streamId)
        return true
      } catch (error) {
        stoppedRunReasonRef.current.delete(streamId)
        flushBufferedAssistantDeltaForCard(cardId)
        flushBufferedActivitiesForCard(cardId)
        active?.source.close()
        activeStreamsRef.current.delete(cardId)
        clearStopCompletionFallbackTimer(cardId)
        streamRetryCountRef.current.delete(cardId)
        resumeSessionLoopCountRef.current.delete(cardId)
        streamRecoveryTurnRef.current.delete(cardId)
        queueFollowUpDuringStreamRef.current.delete(cardId)
        pendingAskUserDuringStreamRef.current.delete(cardId)

        if (!owner) {
          runStartedAtRef.current.delete(cardId)
          return false
        }

        const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
        const actions: IdeAction[] = [
          {
            type: 'appendMessages',
            columnId: owner.id,
            cardId,
            messages: [createMessage('system', errorMessage(error, text.unexpectedError))],
          },
          {
            type: 'updateCard',
            columnId: owner.id,
            cardId,
            patch: { status: 'error', streamId: undefined },
          },
        ]
        if (durationMessage) {
          actions.push({
            type: 'appendMessages',
            columnId: owner.id,
            cardId,
            messages: [durationMessage],
          })
        }
        persistAfterActions(actions, applyActions(actions))
        return false
      }
    },
    [
      applyActions,
      clearStopCompletionFallbackTimer,
      flushBufferedActivitiesForCard,
      flushBufferedAssistantDeltaForCard,
      persistAfterActions,
      text.unexpectedError,
    ],
  )

  const commitQueuedSends = useCallback((cardId: string, queue: readonly QueuedSendRequest[]) => {
    const nextQueue = queue.map((request) => ({
      ...request,
      attachments: request.attachments.map((attachment) => ({ ...attachment })),
    }))
    if (nextQueue.length > 0) {
      queuedSendRequestsRef.current.set(cardId, nextQueue)
    } else {
      queuedSendRequestsRef.current.delete(cardId)
    }

    setQueuedSendSummaries((current) => {
      const nextSummary = summarizeQueuedSends(nextQueue)
      const previousSummary = current.get(cardId)
      if (
        previousSummary &&
        nextSummary &&
        previousSummary.count === nextSummary.count &&
        previousSummary.nextPreview === nextSummary.nextPreview &&
        previousSummary.nextAttachmentCount === nextSummary.nextAttachmentCount
      ) {
        return current
      }

      const copy = new Map(current)
      if (nextSummary) copy.set(cardId, nextSummary)
      else copy.delete(cardId)
      return copy
    })

    const owner = appStateRef.current.columns.find((column) => Boolean(column.cards[cardId]))
    if (!owner) {
      return
    }

    const action: IdeAction = {
      type: 'updateCard',
      columnId: owner.id,
      cardId,
      patch: { queuedSends: nextQueue },
    }
    persistImmediately(applyAction(action))
  }, [applyAction, persistImmediately])

  const enqueueQueuedSend = useCallback((cardId: string, request: QueuedSendRequest) => {
    const currentQueue = queuedSendRequestsRef.current.get(cardId) ?? []
    commitQueuedSends(cardId, [...currentQueue, request])
  }, [commitQueuedSends])

  const clearQueuedSends = useCallback((cardId: string) => {
    commitQueuedSends(cardId, [])
  }, [commitQueuedSends])

  const resolveQueuedSendColumnId = useCallback((fallbackColumnId: string, cardId: string) => {
    return resolveQueuedSendTargetColumnId(appStateRef.current.columns, fallbackColumnId, cardId)
  }, [])

  const dispatchNextQueuedSend = useCallback((columnId: string, cardId: string) => {
    const currentQueue = queuedSendRequestsRef.current.get(cardId)
    if (!currentQueue || currentQueue.length === 0) {
      return
    }

    const targetColumnId = resolveQueuedSendColumnId(columnId, cardId)
    if (!targetColumnId) {
      clearQueuedSends(cardId)
      return
    }

    const nextRequest = currentQueue[0]
    if (!nextRequest) {
      return
    }

    commitQueuedSends(cardId, currentQueue.slice(1))

    queueMicrotask(() => {
      void sendMessageRef.current?.(targetColumnId, cardId, nextRequest.prompt, nextRequest.attachments)
    })
  }, [clearQueuedSends, commitQueuedSends, resolveQueuedSendColumnId])

  const finalizeStoppedStreamWithoutServerAck = useCallback((
    columnId: string,
    cardId: string,
    reason: StoppedRunReason,
  ) => {
    const active = activeStreamsRef.current.get(cardId)
    flushBufferedAssistantDeltaForCard(cardId)
    flushBufferedActivitiesForCard(cardId)
    active?.source.close()
    activeStreamsRef.current.delete(cardId)
    clearStopCompletionFallbackTimer(cardId)
    streamRetryCountRef.current.delete(cardId)
    resumeSessionLoopCountRef.current.delete(cardId)
    streamRecoveryTurnRef.current.delete(cardId)
    queueFollowUpDuringStreamRef.current.delete(cardId)
    pendingAskUserDuringStreamRef.current.delete(cardId)

    if (active?.streamId) {
      stoppedRunReasonRef.current.delete(active.streamId)
    }

    const liveCard = appStateRef.current.columns.find((column) => column.id === columnId)?.cards[cardId]
    if (!liveCard) {
      return
    }

    const actions: IdeAction[] = [
      {
        type: 'finishStoppedStream',
        columnId,
        cardId,
        stoppedMessage:
          reason !== 'ask-user-answer'
            ? createStoppedRunMessage(appStateRef.current.settings.language, reason)
            : undefined,
      },
    ]
    const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
    if (durationMessage) {
      actions.push({
        type: 'appendMessages',
        columnId,
        cardId,
        messages: [durationMessage],
      })
    }

    persistAfterActions(actions, applyActions(actions))
    dispatchNextQueuedSend(columnId, cardId)
  }, [
    applyActions,
    clearStopCompletionFallbackTimer,
    dispatchNextQueuedSend,
    flushBufferedActivitiesForCard,
    flushBufferedAssistantDeltaForCard,
    persistAfterActions,
  ])

  const sendNextQueuedNow = useCallback((columnId: string, cardId: string) => {
    const currentQueue = queuedSendRequestsRef.current.get(cardId)
    if (!currentQueue || currentQueue.length === 0) {
      return
    }

    const targetColumnId = resolveQueuedSendColumnId(columnId, cardId)
    if (!targetColumnId) {
      clearQueuedSends(cardId)
      return
    }

    const nextRequest = currentQueue[0]
    if (!nextRequest) {
      return
    }

    commitQueuedSends(cardId, currentQueue.slice(1))

    queueMicrotask(() => {
      void sendMessageRef.current?.(targetColumnId, cardId, nextRequest.prompt, nextRequest.attachments, {
        mode: 'interrupt',
      })
    })
  }, [clearQueuedSends, commitQueuedSends, resolveQueuedSendColumnId])

  const finalizeStoppedAskUserWithoutServerAck = useCallback(async (
    columnId: string,
    cardId: string,
  ) => {
    finalizeStoppedStreamWithoutServerAck(columnId, cardId, 'ask-user-answer')
  }, [
    finalizeStoppedStreamWithoutServerAck,
  ])

  const providerByName = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.provider, provider])),
    [providers],
  )
  const sessionHistoryByWorkspacePath = useMemo(() => {
    const grouped = new Map<string, SessionHistoryEntry[]>()

    for (const entry of appState.sessionHistory ?? []) {
      const key = normalizeWorkspaceHistoryKey(entry.workspacePath)
      if (!key) {
        continue
      }

      const existing = grouped.get(key)
      if (existing) {
        existing.push(entry)
      } else {
        grouped.set(key, [entry])
      }
    }

    return grouped
  }, [appState.sessionHistory])
  const getColumn = useCallback(
    (columnId: string) => appStateRef.current.columns.find((column) => column.id === columnId),
    [],
  )

  const getColumnCard = useCallback(
    (columnId: string, cardId: string) => getColumn(columnId)?.cards[cardId],
    [getColumn],
  )

  const getFallbackPaneTarget = useCallback((): PaneTarget | null => {
    for (const column of appStateRef.current.columns) {
      const pane = getFirstPane(column.layout)
      if (pane) {
        return { columnId: column.id, paneId: pane.id }
      }
    }

    return null
  }, [])

  const rememberPaneTarget = useCallback((columnId: string, paneId: string) => {
    activePaneTargetRef.current = { columnId, paneId }
  }, [])

  const resolvePaneTarget = useCallback((): PaneTarget | null => {
    const current = activePaneTargetRef.current
    if (current) {
      const column = getColumn(current.columnId)
      if (column && findPaneInLayout(column.layout, current.paneId)) {
        return current
      }
    }

    const fallback = getFallbackPaneTarget()
    activePaneTargetRef.current = fallback
    return fallback
  }, [getColumn, getFallbackPaneTarget])

  const resolveColumnPaneTarget = useCallback((columnId: string): string | undefined => {
    const current = activePaneTargetRef.current
    if (!current || current.columnId !== columnId) {
      return undefined
    }

    const column = getColumn(columnId)
    return column && findPaneInLayout(column.layout, current.paneId)
      ? current.paneId
      : undefined
  }, [getColumn])

  const openTextEditorTab = useCallback(
    (columnId: string, paneId: string, relativePath: string, title: string) => {
      rememberPaneTarget(columnId, paneId)
      applyAction({
        type: 'addTab',
        columnId,
        paneId,
        title,
        model: isImageFilePath(relativePath) ? IMAGEEDITOR_TOOL_MODEL : TEXTEDITOR_TOOL_MODEL,
        stickyNote: relativePath,
      })
    },
    [applyAction, rememberPaneTarget],
  )

  const openModelPromptRulesDialog = useCallback(() => {
    setModelPromptRulesDraft(
      (appStateRef.current.settings.modelPromptRules ?? []).map((rule) => ({ ...rule })),
    )
    setModelPromptRulesDialogOpen(true)
  }, [])

  const closeModelPromptRulesDialog = useCallback(() => {
    setModelPromptRulesDialogOpen(false)
    setModelPromptRulesDraft([])
  }, [])

  const saveModelPromptRulesDialog = useCallback(() => {
    applyAction({
      type: 'updateSettings',
      patch: {
        modelPromptRules: modelPromptRulesDraft,
      },
    })
    closeModelPromptRulesDialog()
  }, [applyAction, closeModelPromptRulesDialog, modelPromptRulesDraft])

  const renderModelPromptRulesDialog = () => {
    if (!modelPromptRulesDialogOpen) {
      return null
    }

    const dialogTitle = appState.settings.language === 'zh-CN' ? '基于模型的提示词' : 'Model prompt rules'
    const dialogDescription = appState.settings.language === 'zh-CN'
      ? '按模型关键字匹配，例如 claude 会命中 claude-sonnet-4-6。多条命中时会按顺序依次追加。'
      : 'Match by model keyword substring. For example, claude matches claude-sonnet-4-6. When multiple rules match, prompts are appended in order.'
    const keywordLabel = appState.settings.language === 'zh-CN' ? '模型关键字' : 'Model keyword'
    const keywordPlaceholder = appState.settings.language === 'zh-CN'
      ? '例如：claude / sonnet / gpt-5.6'
      : 'For example: claude / sonnet / gpt-5.6'
    const promptLabel = appState.settings.language === 'zh-CN' ? '追加提示词' : 'Prompt to append'
    const promptPlaceholder = appState.settings.language === 'zh-CN'
      ? '命中这个模型时追加的系统提示词'
      : 'System prompt text to append when this rule matches'
    const addLabel = appState.settings.language === 'zh-CN' ? '新增规则' : 'Add rule'
    const saveLabel = appState.settings.language === 'zh-CN' ? '保存规则' : 'Save rules'
    const cancelLabel = appState.settings.language === 'zh-CN' ? '取消' : 'Cancel'
    const deleteLabel = appState.settings.language === 'zh-CN' ? '删除' : 'Delete'

    return (
      <div className="structured-preview-layer">
        <div className="structured-preview-backdrop" onClick={closeModelPromptRulesDialog} />
        <section
          className="structured-preview-dialog model-prompt-rules-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-prompt-rules-dialog-title"
        >
          <div className="structured-preview-card model-prompt-rules-card">
            <div className="structured-preview-header">
              <div className="structured-preview-copy">
                <h3 id="model-prompt-rules-dialog-title">{dialogTitle}</h3>
                <p className="settings-note">{dialogDescription}</p>
              </div>

              <button
                type="button"
                className="btn btn-ghost structured-preview-close"
                onClick={closeModelPromptRulesDialog}
                aria-label={cancelLabel}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="structured-preview-body">
              <div className="model-prompt-rules-list">
                {modelPromptRulesDraft.map((rule, index) => (
                  <div key={rule.id} className="model-prompt-rule-card">
                    <label className="settings-field">
                      <span className="settings-field-label">
                        <span className="settings-field-label-text">{keywordLabel}</span>
                      </span>
                      <input
                        className="control settings-input"
                        value={rule.modelMatch}
                        placeholder={keywordPlaceholder}
                        onChange={(event) =>
                          setModelPromptRulesDraft((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, modelMatch: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>

                    <label className="settings-field">
                      <span className="settings-field-label">
                        <span className="settings-field-label-text">{promptLabel}</span>
                      </span>
                      <textarea
                        className="control settings-input settings-textarea"
                        rows={4}
                        value={rule.prompt}
                        placeholder={promptPlaceholder}
                        onChange={(event) =>
                          setModelPromptRulesDraft((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, prompt: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>

                    <div className="settings-actions model-prompt-rule-actions">
                      <AppButton
                        type="button"
                        onClick={() =>
                          setModelPromptRulesDraft((current) =>
                            current.filter((entry) => entry.id !== rule.id),
                          )
                        }
                      >
                        {deleteLabel}
                      </AppButton>
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-actions">
                <AppButton
                  type="button"
                  onClick={() =>
                    setModelPromptRulesDraft((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        modelMatch: '',
                        prompt: '',
                      },
                    ])
                  }
                >
                  {addLabel}
                </AppButton>
              </div>

              <div className="settings-actions model-prompt-rules-dialog-actions">
                <AppButton type="button" onClick={closeModelPromptRulesDialog}>
                  {cancelLabel}
                </AppButton>
                <AppButton tone="primary" type="button" onClick={saveModelPromptRulesDialog}>
                  {saveLabel}
                </AppButton>
              </div>
            </div>
          </div>
        </section>
      </div>
    )
  }

  const changeCardModelSelection = useCallback(
    (columnId: string, cardId: string, provider: Provider, model: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      const action: IdeAction = {
        type: 'selectCardModel',
        columnId,
        cardId,
        provider,
        model,
      }
      const nextState = applyAction(action)

      if (shouldPersistActionImmediately(action.type, nextState)) {
        persistAfterAction(action.type, nextState)
      }
    },
    [applyAction, getColumnCard, persistAfterAction],
  )

  const changeCardReasoningEffort = useCallback(
    (columnId: string, cardId: string, reasoningEffort: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      const normalizedReasoningEffort = normalizeReasoningEffort(card.provider, reasoningEffort)

      const actions: IdeAction[] = [
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: {
            reasoningEffort: normalizedReasoningEffort,
          },
        },
        {
          type: 'rememberModelReasoningEffort',
          provider: card.provider,
          model: card.model,
          reasoningEffort: normalizedReasoningEffort,
        },
      ]
      persistAfterActions(actions, applyActions(actions))
    },
    [applyActions, getColumnCard, persistAfterActions],
  )

  const toggleCardPlanMode = useCallback(
    (columnId: string, cardId: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      const action: IdeAction = {
        type: 'updateCard',
        columnId,
        cardId,
        patch: { planMode: !card.planMode },
      }
      persistAfterAction(action.type, applyAction(action))
    },
    [applyAction, getColumnCard, persistAfterAction],
  )

  const toggleCardThinking = useCallback(
    (columnId: string, cardId: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      const action: IdeAction = {
        type: 'updateCard',
        columnId,
        cardId,
        patch: { thinkingEnabled: card.thinkingEnabled === false ? true : false },
      }
      persistAfterAction(action.type, applyAction(action))
    },
    [applyAction, getColumnCard, persistAfterAction],
  )

  const toggleCardCollapsed = useCallback(
    (columnId: string, cardId: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      const action: IdeAction = {
        type: 'updateCard',
        columnId,
        cardId,
        patch: { collapsed: !card.collapsed },
      }
      persistAfterAction(action.type, applyAction(action))
    },
    [applyAction, getColumnCard, persistAfterAction],
  )

  const appendCardLogs = useCallback(
    (columnId: string, cardId: string, provider: Provider, message: string) => {
      const messages = createLogMessages(provider, message)
      if (messages.length === 0) {
        return
      }

      // Urgent on purpose — see flushStreamRenderBuffers: reducer updates must stay in
      // one React lane or interleaved commits can render rebased intermediate
      // states (2026-07-11 panel delete/remount oscillation).
      const action: IdeAction = {
        type: 'appendMessages',
        columnId,
        cardId,
        messages,
      }
      persistAfterAction(action.type, applyAction(action))
    },
    [applyAction, persistAfterAction],
  )

  const ensureAssistantMessage = useCallback(
    (
      columnId: string,
      cardId: string,
      provider: Provider,
      streamId: string,
      source: ChatStreamSource,
      itemId?: string,
      model?: string,
    ) => {
      const active = activeStreamsRef.current.get(cardId)
      const messages = getColumn(columnId)?.cards[cardId]?.messages ?? []
      const target = resolveStreamedAssistantMessageTarget({
        messages,
        provider,
        streamId,
        itemId,
        activeMessageId: active?.assistantMessageId,
        activeItemId: active?.assistantItemId,
        model,
      })

      activeStreamsRef.current.set(cardId, {
        cardId,
        streamId,
        provider,
        source,
        assistantMessageId: target.messageId,
        assistantItemId: target.assistantItemId,
        suppressOutputAfterAskUser: active?.suppressOutputAfterAskUser,
      })

      if (!target.messageToAppend) {
        return target.messageId
      }

      const action: IdeAction = {
        type: 'appendMessages',
        columnId,
        cardId,
        messages: [target.messageToAppend],
      }
      persistAfterAction(action.type, applyAction(action))

      return target.messageId
    },
    [applyAction, getColumn, persistAfterAction],
  )

  const enqueueAssistantDelta = useCallback(
    (columnId: string, cardId: string, messageId: string, delta: string, model?: string) => {
      if (!delta) return
      const buffer = deltaBufferRef.current
      enqueueStreamDeltaBufferEntry(buffer, {
        columnId,
        cardId,
        messageId,
        buffer: delta,
        model,
      })

      if (
        streamRenderFlushHandleRef.current === null &&
        streamRenderCycleColumnIdsRef.current.length === 0
      ) {
        streamRenderFlushHandleRef.current = window.setTimeout(
          flushStreamRenderBuffers,
          getStreamRenderFlushIntervalMs(activeStreamsRef.current.size),
        )
      }
    },
    [flushStreamRenderBuffers],
  )

  const attachStream = useCallback(
    function attachStreamToCard(columnId: string, card: ChatCard) {
      if (!card.streamId) {
        return
      }

      const latestUserCreatedAt = [...card.messages]
        .reverse()
        .find((message) => message.role === 'user')
        ?.createdAt
      const restoredStartedAtMs = latestUserCreatedAt ? Date.parse(latestUserCreatedAt) : Number.NaN
      recordRunStart(
        runStartedAtRef.current,
        card.id,
        Number.isFinite(restoredStartedAtMs) ? restoredStartedAtMs : Date.now(),
      )

      const existing = activeStreamsRef.current.get(card.id)
      if (existing?.streamId === card.streamId) {
        return
      }

      if (existing) {
        flushBufferedAssistantDeltaForCard(card.id)
        flushBufferedActivitiesForCard(card.id)
        existing.source.close()
        activeStreamsRef.current.delete(card.id)
      }

      const source = openChatStream(card.streamId, {
        onSession: ({ sessionId }) => {
          if (shouldResetStreamRecoveryAttemptsForActivity('session')) {
            streamRetryCountRef.current.delete(card.id)
            markRecoveryResumedIfActive(card.id)
          }
          const action: IdeAction = {
            type: 'updateCard',
            columnId,
            cardId: card.id,
            patch: { sessionId, sessionModel: card.model },
          }
          persistAfterAction(action.type, applyAction(action))
        },
        onDelta: ({ content, itemId }) => {
          const active = activeStreamsRef.current.get(card.id)
          if (active?.suppressOutputAfterAskUser) {
            return
          }

          const messageId = ensureAssistantMessage(
            columnId,
            card.id,
            card.provider,
            card.streamId!,
            source,
            itemId,
            card.model,
          )

          if (shouldResetStreamRecoveryAttemptsForText(content)) {
            streamRetryCountRef.current.delete(card.id)
            markRecoveryResumedIfActive(card.id)
          }
          enqueueAssistantDelta(columnId, card.id, messageId, content, card.model)
        },
        onLog: ({ message }) => {
          const active = activeStreamsRef.current.get(card.id)
          if (active?.suppressOutputAfterAskUser) {
            return
          }

          const messages = createLogMessages(card.provider, message)
          if (messages.length === 0) {
            return
          }

          if (shouldResetStreamRecoveryAttemptsForActivity('log')) {
            streamRetryCountRef.current.delete(card.id)
            markRecoveryResumedIfActive(card.id)
          }
          const action: IdeAction = {
            type: 'appendMessages',
            columnId,
            cardId: card.id,
            messages,
          }
          persistAfterAction(action.type, applyAction(action))
        },
        onAssistantMessage: (payload) => {
          const active = activeStreamsRef.current.get(card.id)
          if (active?.suppressOutputAfterAskUser) {
            return
          }

          flushBufferedActivitiesForCard(card.id)
          if (
            shouldResetStreamRecoveryAttemptsForActivity('assistant_message') &&
            shouldResetStreamRecoveryAttemptsForText(payload.content)
          ) {
            streamRetryCountRef.current.delete(card.id)
            markRecoveryResumedIfActive(card.id)
          }
          const assistantMessageId =
            active?.assistantMessageId &&
            (!active.assistantItemId || active.assistantItemId === payload.itemId)
              ? active.assistantMessageId
              : createStructuredMessageId(card.provider, card.streamId!, payload.itemId)
          deltaBufferRef.current.delete(assistantMessageId)
          flushBufferedAssistantDeltaForCard(card.id)
          if (active) {
            activeStreamsRef.current.set(card.id, {
              ...active,
              assistantMessageId,
              assistantItemId: payload.itemId,
            })
          }

          const liveCard = getColumn(columnId)?.cards[card.id]
          const nextMessages = liveCard
            ? finalizeStreamedAssistantMessage(
                liveCard.messages,
                assistantMessageId,
                card.provider,
                card.streamId!,
                payload,
                card.model,
              )
            : null

          if (nextMessages) {
            const action: IdeAction = {
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: {
                messages: nextMessages,
              },
            }
            persistAfterAction(action.type, applyAction(action))
            return
          }

          const action: IdeAction = {
            type: 'updateCard',
            columnId,
            cardId: card.id,
            patch: {
              messages: finalizeStreamedAssistantMessage(
                [],
                undefined,
                card.provider,
                card.streamId!,
                payload,
                card.model,
              ),
            },
          }
          persistAfterAction(action.type, applyAction(action))
        },
        onActivity: (payload) => {
          const currentActive = activeStreamsRef.current.get(card.id)
          if (currentActive?.suppressOutputAfterAskUser && payload.kind !== 'ask-user') {
            return
          }

          if (shouldResetStreamRecoveryAttemptsForActivity('activity', payload.kind)) {
            streamRetryCountRef.current.delete(card.id)
            markRecoveryResumedIfActive(card.id)
          }

          // Make the structured block decision against the full live text, not a
          // stale state snapshot while token deltas are still sitting in the
          // coalescing buffer. This is especially important for Claude ask-user
          // XML: the XML may arrive as buffered text right before the structured
          // ask-user activity, and delayed flushing would otherwise leak or
          // preserve the wrong bubble.
          flushBufferedAssistantDeltaForCard(card.id)

          // Clear the current assistant message so that any subsequent onDelta
          // (the agent's final answer after tool calls) creates a new message
          // instead of appending to the one that sits *before* the tool calls.
          const active = activeStreamsRef.current.get(card.id)
          const streamingMessageId = active?.assistantMessageId
          if (active) {
            activeStreamsRef.current.set(card.id, {
              ...active,
              assistantMessageId: undefined,
              assistantItemId: undefined,
            })
          }

          if (payload.kind === 'compaction') {
            const liveCard = getColumn(columnId)?.cards[card.id]
            const pendingCompactBoundary = liveCard
              ? getPendingCompactBoundaryMessage(liveCard.messages)
              : null
            const boundaryMessage = pendingCompactBoundary
              ? finalizePendingCompactBoundaryMessage(pendingCompactBoundary)
              : payload.trigger === 'auto'
                ? createAutoCompactionBoundaryMessage({
                    provider: card.provider,
                    streamId: card.streamId!,
                    itemId: payload.itemId,
                  })
                : markCompactBoundaryMessage({
                    id: `${card.provider}:${card.streamId!}:compact-boundary:${payload.itemId}`,
                    role: 'user',
                    content: '/compact',
                    createdAt: new Date().toISOString(),
                  })

            const action: IdeAction = {
              type: 'upsertMessages',
              columnId,
              cardId: card.id,
              messages: [
                boundaryMessage,
                createCompactionStatusMessage({
                  provider: card.provider,
                  streamId: card.streamId!,
                  itemId: payload.itemId,
                  language: appStateRef.current.settings.language,
                  trigger: payload.trigger,
                }),
              ],
            }
            persistAfterAction(action.type, applyAction(action))
            return
          }

          if (payload.kind === 'ask-user') {
            const liveCard = getColumn(columnId)?.cards[card.id]
            pendingAskUserDuringStreamRef.current.set(card.id, true)
            const activityFlushedState = flushBufferedActivitiesForCard(card.id)
            const liveMessages = activityFlushedState.columns
              .find((column) => column.id === columnId)
              ?.cards[card.id]?.messages

            const action: IdeAction = {
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: {
                messages: finalizeStructuredActivityMessage(
                  liveMessages ?? liveCard?.messages ?? [],
                  streamingMessageId,
                  card.provider,
                  card.streamId!,
                  payload,
                ),
              },
            }
            persistAfterAction(action.type, applyAction(action))

            // When ExitPlanMode provides a plan file, open it as a TextEditor card
            if (payload.planFile) {
              const col = getColumnById(appStateRef.current.columns, columnId)
              const sourcePane = col ? findPaneForTab(col.layout, card.id) : null
              if (sourcePane) {
                openTextEditorTab(columnId, sourcePane.id, payload.planFile, 'Plan')
              }
            }

            if (shouldStopStreamForAskUserActivity(payload)) {
              const activeAfterAskUser = activeStreamsRef.current.get(card.id)
              if (activeAfterAskUser && shouldSuppressStreamOutputAfterAskUserActivity(payload)) {
                activeStreamsRef.current.set(card.id, {
                  ...activeAfterAskUser,
                  suppressOutputAfterAskUser: true,
                })
              }
              queueMicrotask(() => {
                void requestStopForCard(card.id, 'ask-user-answer')
              })
            }

            return
          }

          if (payload.kind === 'edits') {
            streamEditsActivityCountRef.current.set(
              card.id,
              (streamEditsActivityCountRef.current.get(card.id) ?? 0) + 1,
            )
          }

          enqueueActivityMessage(
            columnId,
            card.id,
            createStructuredActivityMessage(card.provider, card.streamId!, payload),
          )
        },
        onStats: (payload) => {
          const previousLocalRecoveryStats = localRecoveryStatsRef.current.get(card.id)
          const disconnectedLocalRecoveryStats = payload.event === 'disconnect'
            ? noteLocalRecoveryDisconnect(previousLocalRecoveryStats)
            : {
                state: previousLocalRecoveryStats ?? { hadRecoverableDisconnect: false },
                events: [payload.event],
              }
          localRecoveryStatsRef.current.set(card.id, disconnectedLocalRecoveryStats.state)
          if (payload.alreadyRecorded) {
            return
          }
          for (const event of disconnectedLocalRecoveryStats.events) {
            void recordProxyStatsEvent({
              provider: card.provider,
              event,
              endpoint: payload.endpoint,
              attempt: payload.attempt,
              errorType: payload.errorType,
            }).catch(() => undefined)
          }
        },
        onDone: ({ stopped }) => {
          flushBufferedAssistantDeltaForCard(card.id)
          const activityFlushedState = flushBufferedActivitiesForCard(card.id)
          const receivedEditsActivities = streamEditsActivityCountRef.current.get(card.id) ?? 0
          streamEditsActivityCountRef.current.delete(card.id)
          source.close()
          activeStreamsRef.current.delete(card.id)
          const fallbackTimer = stopCompletionFallbackTimersRef.current.get(card.id)
          if (fallbackTimer !== undefined) {
            window.clearTimeout(fallbackTimer)
            stopCompletionFallbackTimersRef.current.delete(card.id)
          }
          streamRetryCountRef.current.delete(card.id)
          resumeSessionLoopCountRef.current.delete(card.id)
          streamRecoveryTurnRef.current.delete(card.id)
          queueFollowUpDuringStreamRef.current.delete(card.id)
          pendingAskUserDuringStreamRef.current.delete(card.id)
          const settledLocalRecoveryStats = settleLocalRecoveryStatsRun(
            localRecoveryStatsRef.current.get(card.id),
            stopped ? 'abandoned' : 'success',
          )
          localRecoveryStatsRef.current.delete(card.id)
          for (const event of settledLocalRecoveryStats.events) {
            void recordProxyStatsEvent({
              provider: card.provider,
              event,
              endpoint: '/cli/local-stream',
            }).catch(() => undefined)
          }
          // Normal completion clears reconnecting/resumed but preserves failed
          // (failed should only clear when a brand-new stream starts on this card).
          clearRecoveryStatusIfAllowed(card.id)
          const stoppedRunReason = card.streamId
            ? (stoppedRunReasonRef.current.get(card.streamId) ?? 'manual')
            : 'manual'
          if (card.streamId) {
            stoppedRunReasonRef.current.delete(card.streamId)
          }

          if (!stopped && appStateRef.current.settings.agentDoneSoundEnabled) {
            const audio = new Audio(getAgentDoneSoundUrl())
            audio.volume = appStateRef.current.settings.agentDoneSoundVolume
            audio.play().catch(() => {})
          }

          if (!stopped) {
            void flashWindowOnce().catch(() => undefined)
          }

          const liveColumn = getColumnById(activityFlushedState.columns, columnId)
          const unread =
            liveColumn
              ? shouldMarkCardUnreadOnStreamDone(
                  liveColumn.layout,
                  card.id,
                  appStateRef.current.settings.activeTopTab === 'ambience',
                )
              : true

          const liveCard = liveColumn?.cards[card.id]
          const pendingCompactBoundary = liveCard
            ? getPendingCompactBoundaryMessage(liveCard.messages)
            : null
          const actions: IdeAction[] = []

          if (stopped) {
            actions.push({
              type: 'finishStoppedStream',
              columnId,
              cardId: card.id,
              unread,
              stoppedMessage:
                stoppedRunReason !== 'ask-user-answer'
                  ? createStoppedRunMessage(appStateRef.current.settings.language, stoppedRunReason)
                  : undefined,
            })
          } else {
            actions.push({
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: { status: 'idle', streamId: undefined, unread, completionGlow: true, sessionModel: card.model },
            })
          }

          if (pendingCompactBoundary) {
            actions.unshift({
              type: 'upsertMessages',
              columnId,
              cardId: card.id,
              messages: [
                stopped
                  ? clearPendingCompactBoundaryMessage(pendingCompactBoundary)
                  : finalizePendingCompactBoundaryMessage(pendingCompactBoundary),
              ],
            })
          }

          // Collect all file edits from this conversation and append a changes summary
          if (liveCard && !stopped) {
            const summaryFiles = collectChangesSummaryFilesForStream(
              liveCard.messages,
              card.provider,
              card.streamId!,
            )

            if (receivedEditsActivities > 0 && summaryFiles.length === 0) {
              // Received live edits activities but none survived into card
              // state — the exact silent-loss shape we could not attribute in
              // the wild. Keep this loud so main.log captures the next hit.
              console.error(
                `[chill-vibe] stream ${card.streamId} on card ${card.id} received ${receivedEditsActivities} edits activities but zero edits messages survived to stream completion`,
              )
            }

            if (summaryFiles.length > 0) {
              actions.push({
                type: 'appendMessages',
                columnId,
                cardId: card.id,
                messages: [
                  createMessage('assistant', '', {
                    kind: 'changes-summary',
                    structuredData: JSON.stringify(summaryFiles),
                  }),
                ],
              })
            }
          }

          const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, card.id)
          if (durationMessage) {
            actions.push({
              type: 'appendMessages',
              columnId,
              cardId: card.id,
              messages: [durationMessage],
            })
          }

          persistAfterActions(actions, applyActions(actions))
          dispatchNextQueuedSend(columnId, card.id)
        },
        onError: ({ message, recoverable, recoveryMode, transientOnly, hint, sessionId }) => {
          flushBufferedAssistantDeltaForCard(card.id)
          flushBufferedActivitiesForCard(card.id)
          streamEditsActivityCountRef.current.delete(card.id)
          source.close()
          activeStreamsRef.current.delete(card.id)
          const fallbackTimer = stopCompletionFallbackTimersRef.current.get(card.id)
          if (fallbackTimer !== undefined) {
            window.clearTimeout(fallbackTimer)
            stopCompletionFallbackTimersRef.current.delete(card.id)
          }
          if (card.streamId) {
            stoppedRunReasonRef.current.delete(card.streamId)
          }

          if (recoverable) {
            if (!streamRecoveryTurnRef.current.has(card.id)) {
              const liveCard = getColumn(columnId)?.cards[card.id] ?? card
              const inferredCheckpointTurn = resolveStreamRecoveryCheckpointTurn({
                messages: liveCard.messages,
                streamId: card.streamId,
              })
              if (inferredCheckpointTurn) {
                streamRecoveryTurnRef.current.set(card.id, {
                  forkPoint: {
                    content: inferredCheckpointTurn.message.content,
                    createdAt: inferredCheckpointTurn.message.createdAt,
                  },
                  prompt: inferredCheckpointTurn.prompt,
                  attachments: inferredCheckpointTurn.attachments,
                })
              }
            }
            const recoverySessionId = getRecoverableStreamErrorSessionId({
              recoverable,
              recoveryMode,
              sessionId,
            })
            if (recoverySessionId) {
              const liveCard = getColumn(columnId)?.cards[card.id]
              if (liveCard?.sessionId?.trim() !== recoverySessionId) {
                const action: IdeAction = {
                  type: 'updateCard',
                  columnId,
                  cardId: card.id,
                  patch: { sessionId: recoverySessionId, sessionModel: card.model },
                }
                persistAfterAction(action.type, applyAction(action))
              }
            }
            const disconnectedLocalRecoveryStats = noteLocalRecoveryDisconnect(
              localRecoveryStatsRef.current.get(card.id),
            )
            localRecoveryStatsRef.current.set(card.id, disconnectedLocalRecoveryStats.state)
            for (const event of disconnectedLocalRecoveryStats.events) {
              void recordProxyStatsEvent({
                provider: card.provider,
                event,
                endpoint: '/cli/local-stream',
                attempt: streamRetryCountRef.current.get(card.id) ?? 0,
                errorType: 'local-provider-recoverable',
              }).catch(() => undefined)
            }
            const retryCount = streamRetryCountRef.current.get(card.id) ?? 0
            const maxRecoverableRetries = getRecoverableStreamRetryLimit(
              appStateRef.current.settings.resilientProxyMaxRetries,
            )

            if (retryCount < maxRecoverableRetries) {
              const shouldCountAgainstBudget = transientOnly !== true
              // This counter tracks failed resume turns, not visible progress.
              // A poisoned Codex session can emit reasoning (or even partial
              // output) and still end in the stall watchdog; only a terminal
              // completion proves that the resumed session is healthy again.
              const resumeSessionAttempt =
                recoveryMode === 'resume-session'
                  ? (resumeSessionLoopCountRef.current.get(card.id) ?? 0) + 1
                  : 0
              if (resumeSessionAttempt > 0) {
                resumeSessionLoopCountRef.current.set(card.id, resumeSessionAttempt)
              } else {
                resumeSessionLoopCountRef.current.delete(card.id)
              }
              if (shouldCountAgainstBudget) {
                streamRetryCountRef.current.set(card.id, retryCount + 1)
              }
              // Show the reconnecting banner. The helper adds 1 internally so the
              // visible label becomes "n/max" where n is the attempt about to run.
              // Transient placeholder-only errors do not move the retry budget,
              // but the visible counter still advances so unlimited recovery does
              // not look stuck on "1/unlimited".
              markRecoveryReconnecting(card.id, retryCount, maxRecoverableRetries)

              window.setTimeout(() => {
                const liveCard = getColumn(columnId)?.cards[card.id]
                if (liveCard && liveCard.streamId === card.streamId) {
                  const hasLiveSessionId =
                    typeof liveCard.sessionId === 'string' &&
                    liveCard.sessionId.trim().length > 0
                  if (
                    shouldKeepRecoveringResumeWithFreshSession({
                      recoverable,
                      recoveryMode,
                      hasSessionId: hasLiveSessionId,
                      resumeAttempt: resumeSessionAttempt,
                      maxResumeAttempts: maxResumeSessionLoopAttempts,
                    })
                  ) {
                    resumeSessionLoopCountRef.current.delete(card.id)
                    void recoverLiveStreamRef.current?.(columnId, card.id, {
                      clearSessionId: true,
                      preferNativeCheckpoint: true,
                    })
                    return
                  }

                  const nextRecoveryMode = resolveStreamRecoveryMode(
                    {
                      recoverable,
                      recoveryMode,
                    },
                    hasLiveSessionId,
                  )

                  if (nextRecoveryMode === 'resume-session') {
                    void recoverLiveStreamRef.current?.(columnId, card.id)
                    return
                  }

                  attachStreamToCard(columnId, liveCard)
                }
              }, Math.min(1500, 250 * (shouldCountAgainstBudget ? retryCount + 1 : 1)))

              return
            }
          }

          streamRetryCountRef.current.delete(card.id)
          resumeSessionLoopCountRef.current.delete(card.id)
          queueFollowUpDuringStreamRef.current.delete(card.id)
          pendingAskUserDuringStreamRef.current.delete(card.id)
          const settledLocalRecoveryStats = settleLocalRecoveryStatsRun(
            localRecoveryStatsRef.current.get(card.id),
            'failure',
          )
          localRecoveryStatsRef.current.delete(card.id)
          for (const event of settledLocalRecoveryStats.events) {
            void recordProxyStatsEvent({
              provider: card.provider,
              event,
              endpoint: '/cli/local-stream',
              errorType: 'local-provider-final',
            }).catch(() => undefined)
          }

          // Stream expired or server restarted — gracefully return to idle
          // so the user can continue chatting with their existing messages.
          if (message === 'Stream not found.') {
            forceResetRecoveryStatus(card.id)
            const activityFlushedState = flushBufferedActivitiesForCard(card.id)
            const liveCard = getColumnById(activityFlushedState.columns, columnId)?.cards[card.id]
            const pendingCompactBoundary = liveCard
              ? getPendingCompactBoundaryMessage(liveCard.messages)
              : null
            const actions: IdeAction[] = [
              {
                type: 'updateCard',
                columnId,
                cardId: card.id,
                patch: { status: 'idle', streamId: undefined },
              },
            ]
            const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, card.id)
            if (durationMessage) {
              actions.push({
                type: 'appendMessages',
                columnId,
                cardId: card.id,
                messages: [durationMessage],
              })
            }

            if (pendingCompactBoundary) {
              actions.unshift({
                type: 'upsertMessages',
                columnId,
                cardId: card.id,
                messages: [clearPendingCompactBoundaryMessage(pendingCompactBoundary)],
              })
            }

            persistAfterActions(actions, applyActions(actions))
            dispatchNextQueuedSend(columnId, card.id)
            return
          }

          if (hint === 'switch-config' || hint === 'env-setup') {
            openRemediationPanel(card.provider, hint)
          }
          // Final, unrecoverable failure (or recoverable retries exhausted) —
          // show the failed recovery banner so the user isn't left wondering.
          markRecoveryFailed(card.id)
          const activityFlushedState = flushBufferedActivitiesForCard(card.id)
          const liveCard = getColumnById(activityFlushedState.columns, columnId)?.cards[card.id]
          const pendingCompactBoundary = liveCard
            ? getPendingCompactBoundaryMessage(liveCard.messages)
            : null
          const actions: IdeAction[] = [
            {
              type: 'appendMessages',
              columnId,
              cardId: card.id,
              messages: [createMessage('system', message)],
            },
            {
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: { status: 'error', streamId: undefined },
            },
          ]
          const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, card.id)
          if (durationMessage) {
            actions.push({
              type: 'appendMessages',
              columnId,
              cardId: card.id,
              messages: [durationMessage],
            })
          }

          if (pendingCompactBoundary) {
            actions.unshift({
              type: 'upsertMessages',
              columnId,
              cardId: card.id,
              messages: [clearPendingCompactBoundaryMessage(pendingCompactBoundary)],
            })
          }

          persistAfterActions(actions, applyActions(actions))
          dispatchNextQueuedSend(columnId, card.id)
        },
      })

      activeStreamsRef.current.set(card.id, {
        cardId: card.id,
        streamId: card.streamId,
        provider: card.provider,
        source,
      })
    },
    [
      applyAction,
      applyActions,
      clearRecoveryStatusIfAllowed,
      dispatchNextQueuedSend,
      enqueueAssistantDelta,
      enqueueActivityMessage,
      ensureAssistantMessage,
      forceResetRecoveryStatus,
      flushBufferedActivitiesForCard,
      flushBufferedAssistantDeltaForCard,
      getColumn,
      markRecoveryFailed,
      markRecoveryReconnecting,
      markRecoveryResumedIfActive,
      openTextEditorTab,
      openRemediationPanel,
      persistAfterAction,
      persistAfterActions,
      requestStopForCard,
    ],
  )

  const clearTransientRuntimeState = useCallback(() => {
    activeStreamsRef.current.forEach((stream) => {
      stream.source.close()
    })
    activeStreamsRef.current.clear()
    runStartedAtRef.current.clear()
    queuedSendRequestsRef.current.clear()
    setQueuedSendSummaries(new Map())
    queueFollowUpDuringStreamRef.current.clear()
    pendingAskUserDuringStreamRef.current.clear()
    stopCompletionFallbackTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    stopCompletionFallbackTimersRef.current.clear()
    if (streamRenderFlushHandleRef.current !== null) {
      window.clearTimeout(streamRenderFlushHandleRef.current)
      streamRenderFlushHandleRef.current = null
    }
    streamRenderInteractionDeferralStartedAtRef.current = null
    deltaBufferRef.current.clear()
    activityBufferRef.current.clear()
    streamRenderCycleColumnIdsRef.current.length = 0
    stoppedRunReasonRef.current.clear()
    streamRetryCountRef.current.clear()
    resumeSessionLoopCountRef.current.clear()
    streamRecoveryTurnRef.current.clear()
    localRecoveryStatsRef.current.clear()
  }, [])

  const attachStreamsForState = useCallback((state: AppState) => {
    for (const column of state.columns) {
      for (const card of getOrderedColumnCards(column)) {
        if (card.status === 'streaming' && card.streamId) {
          attachStream(column.id, card)
        }
      }
    }
  }, [attachStream])

  // Claude keepalive: a pooled CLI process woke itself between turns (a
  // background task finished and re-invoked the agent). The server wrapped the
  // new turn in a fresh stream — attach the owning card so the unsolicited
  // report renders exactly like a normal streamed reply.
  useEffect(() => {
    return subscribeUnsolicitedStreams(({ cardId, streamId }) => {
      for (const column of appStateRef.current.columns) {
        const card = column.cards[cardId]
        if (!card) {
          continue
        }

        if (card.status === 'streaming' && card.streamId) {
          // The card already has a live stream (the user just sent a follow-up
          // in parallel); that request supersedes the unsolicited turn.
          return
        }

        const action: IdeAction = {
          type: 'updateCard',
          columnId: column.id,
          cardId,
          patch: { status: 'streaming', streamId },
        }
        persistAfterAction(action.type, applyAction(action))

        const liveCard = getColumn(column.id)?.cards[cardId]
        if (liveCard && liveCard.streamId === streamId) {
          attachStream(column.id, liveCard)
        }
        return
      }

      // The card is gone (closed/deleted): stop the orphaned stream so the
      // pooled process is not left running an unobserved turn.
      void stopChat(streamId).catch(() => undefined)
    })
  }, [applyAction, attachStream, getColumn, persistAfterAction])

  // 手机监工的写命令执行器：与电脑端共用同一批 handler，保证行为一致
  //（模型切换的 session 作废在 selectCardModel reducer，发送的 session
  // 续传在 sendMessage 内部 —— 这里绝不自己另写一条捷径）。
  useEffect(() => {
    return subscribeRemoteCommands((command) => {
      const findColumnIdForCard = (cardId: string) =>
        appStateRef.current.columns.find((column) => Boolean(column.cards[cardId]))?.id

      switch (command.type) {
        case 'send-message': {
          const columnId = findColumnIdForCard(command.cardId)
          if (columnId) {
            void sendMessageRef.current?.(columnId, command.cardId, command.prompt, [])
          }
          return
        }
        case 'stop-stream': {
          void requestStopForCard(command.cardId, 'manual')
          return
        }
        case 'add-tab': {
          const column = appStateRef.current.columns.find((entry) => entry.id === command.columnId)
          if (column) {
            applyAction({
              type: 'addTab',
              columnId: column.id,
              paneId: getFirstPane(column.layout).id,
            })
          }
          return
        }
        case 'set-card-model': {
          const columnId = findColumnIdForCard(command.cardId)
          if (columnId) {
            changeCardModelSelection(columnId, command.cardId, command.provider, command.model)
          }
          return
        }
        case 'set-card-reasoning-effort': {
          const columnId = findColumnIdForCard(command.cardId)
          if (columnId) {
            changeCardReasoningEffort(columnId, command.cardId, command.reasoningEffort)
          }
          return
        }
      }
    })
  }, [applyAction, changeCardModelSelection, changeCardReasoningEffort, requestStopForCard])

  const hydrate = useCallback(async () => {
    clearTransientRuntimeState()
    const requestId = hydrateRequestIdRef.current + 1
    hydrateRequestIdRef.current = requestId

    try {
      const { state, recovery, providersPromise } = await startInitialAppLoad({ fetchState, fetchProviders })

      if (hydrateRequestIdRef.current !== requestId) {
        return
      }

      commitLoadedState(state, recovery)

      void providersPromise.then((nextProviders) => {
        if (hydrateRequestIdRef.current !== requestId) {
          return
        }

        if (nextProviders) {
          setProviders(nextProviders)
        } else {
          void syncProviderStatuses()
        }
      })

      if (!recovery.startup && !recovery.interruptedSessions) {
        attachStreamsForState(state)
      }
    } catch (error) {
      setOnboardingCandidate(false)
      setLoadError(error)
      setLoadStatus('error')
      setSaveStatus('error')
      setStartupRecovery(null)
      setRecentCrashRecovery(null)
      setInterruptedSessionRecovery(null)
      setStateRecoveryError(null)
      setRecentCrashActionError(null)
      setInterruptedSessionActionError(null)
    }
  }, [attachStreamsForState, clearTransientRuntimeState, commitLoadedState, syncProviderStatuses])

  useEffect(() => {
    hydrateRef.current = hydrate
  }, [hydrate])

  useEffect(() => {
    void hydrateRef.current?.()
    const activeStreams = activeStreamsRef.current
    const retryCounts = streamRetryCountRef.current
    const resumeSessionLoopCounts = resumeSessionLoopCountRef.current
    const streamRecoveryTurns = streamRecoveryTurnRef.current
    const deltaBuffer = deltaBufferRef.current
    const activityBuffer = activityBufferRef.current
    const streamRenderCycleColumnIds = streamRenderCycleColumnIdsRef.current

    return () => {
      activeStreams.forEach((stream) => {
        stream.source.close()
      })
      activeStreams.clear()
      if (streamRenderFlushHandleRef.current !== null) {
        window.clearTimeout(streamRenderFlushHandleRef.current)
        streamRenderFlushHandleRef.current = null
      }
      streamRenderInteractionDeferralStartedAtRef.current = null
      deltaBuffer.clear()
      activityBuffer.clear()
      streamRenderCycleColumnIds.length = 0
      retryCounts.clear()
      resumeSessionLoopCounts.clear()
      streamRecoveryTurns.clear()
    }
  }, [])

  useEffect(() => {
    setResolvedTheme(getResolvedAppTheme(appState.settings.theme, appState.settings.customThemeBase))

    if (appState.settings.theme !== 'system') {
      return
    }

    return subscribeToSystemThemeChange(() => {
      setResolvedTheme(getResolvedAppTheme('system'))
    })
  }, [appState.settings.theme, appState.settings.customThemeBase])

  useEffect(() => {
    const root = document.documentElement
    const fontFamily = resolveAppFontFamilyCss(appState.settings.fontFamily)
    root.lang = appState.settings.language
    root.dataset.theme = resolvedTheme
    root.style.fontFamily = fontFamily
    root.style.setProperty('--BaseStyles-fontFamily', fontFamily)
    root.style.setProperty('--ui-font-scale', appState.settings.fontScale.toFixed(2))
    root.style.setProperty('--ui-line-height-scale', appState.settings.lineHeightScale.toFixed(2))
  }, [
    appState.settings.fontFamily,
    appState.settings.fontScale,
    appState.settings.language,
    appState.settings.lineHeightScale,
    resolvedTheme,
  ])

  useEffect(() => {
    const root = document.documentElement
    const accentTokens =
      appState.settings.theme === 'custom'
        ? createThemeAccentTokens(appState.settings.accentColor, resolvedTheme)
        : null

    if (!accentTokens) {
      return
    }

    for (const [property, value] of Object.entries(accentTokens)) {
      root.style.setProperty(property, value)
    }

    return () => {
      for (const property of Object.keys(accentTokens)) {
        root.style.removeProperty(property)
      }
    }
  }, [appState.settings.accentColor, appState.settings.theme, resolvedTheme])

  useEffect(() => {
    const root = document.documentElement
    const surfaceTokens =
      appState.settings.theme === 'custom'
        ? createThemeSurfaceTokens(appState.settings.customBaseColor)
        : null

    if (!surfaceTokens) {
      return
    }

    for (const [property, value] of Object.entries(surfaceTokens)) {
      root.style.setProperty(property, value)
    }

    return () => {
      for (const property of Object.keys(surfaceTokens)) {
        root.style.removeProperty(property)
      }
    }
  }, [appState.settings.customBaseColor, appState.settings.theme])

  useEffect(() => {
    const root = document.documentElement
    const zoomFactor = appState.settings.uiScale.toFixed(2)
    const nativeZoomSetter =
      typeof window !== 'undefined' ? window.electronAPI?.setUiZoomFactor : undefined
    const nativeZoomSupported = typeof nativeZoomSetter === 'function'

    root.style.setProperty('--ui-scale', zoomFactor)
    root.style.setProperty('--ui-scale-font-factor', nativeZoomSupported ? '1.00' : zoomFactor)

    if (nativeZoomSupported) {
      void nativeZoomSetter(appState.settings.uiScale).catch(() => undefined)
    }
  }, [appState.settings.uiScale])

  useEffect(() => {
    // Mounted editor cards pick this up through the settings bridge.
    publishTextEditorSettings(appState.settings.editor)
  }, [appState.settings.editor])

  useEffect(() => {
    if (activeTab === 'ambience') {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !isInteractiveEscapeTarget(event.target) &&
        !isInteractiveEscapeTarget(document.activeElement)
      ) {
        setActiveTopTab('ambience')
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeTab, setActiveTopTab])

  useEffect(() => {
    if (activeTab !== 'ambience') {
      return
    }

    const actions: IdeAction[] = []

    for (const column of appState.columns) {
      for (const cardId of getAutoReadCardIdsForVisiblePanes(column.layout, column.cards, true)) {
        actions.push({
          type: 'updateCard',
          columnId: column.id,
          cardId,
          patch: { unread: false },
        })
      }
    }

    if (actions.length > 0) {
      persistAfterActions(actions, applyActions(actions))
    }
  }, [activeTab, appState.columns, applyActions, persistAfterActions])

  useEffect(() => {
    if (!onboardingCandidate || onboardingInitialized || loadStatus !== 'ready') {
      return
    }

    try {
      if (window.localStorage.getItem(onboardingStorageKey) === 'done') {
        setOnboardingInitialized(true)
        return
      }
    } catch {
      // Ignore local storage read failures and keep the guide available.
    }

    let cancelled = false

    const prepare = async () => {
      setOnboardingStatusPending(true)

      try {
        const [nextStatus, nextSetupStatus] = await Promise.all([fetchOnboardingStatus(), fetchSetupStatus()])

        if (cancelled) {
          return
        }

        setOnboardingStatus(nextStatus)
        setSetupStatus(nextSetupStatus)
        setOnboardingOpen(true)
      } catch {
        if (!cancelled) {
          setOnboardingCandidate(false)
          setOnboardingOpen(false)
        }
      } finally {
        if (!cancelled) {
          setOnboardingStatusPending(false)
          setOnboardingInitialized(true)
        }
      }
    }

    void prepare()

    return () => {
      cancelled = true
    }
  }, [loadStatus, onboardingCandidate, onboardingInitialized])

  useEffect(() => {
    if (
      !settingsOpen &&
      !(
        onboardingOpen &&
        !(Boolean(onboardingStatus?.environment.ready) || setupStatus?.state === 'success') &&
        !onboardingSetupSkipped
      )
    ) {
      return
    }

    let cancelled = false

    const sync = async () => {
      setSetupStatusPending(true)
      try {
        const nextStatus = await fetchSetupStatus()
        if (!cancelled) {
          setSetupStatus(nextStatus)
        }
      } catch (error) {
        if (!cancelled) {
          setSetupStatus({
            state: 'error',
            message: errorMessage(error, text.unexpectedError),
            logs: [],
          })
        }
      } finally {
        if (!cancelled) {
          setSetupStatusPending(false)
        }
      }
    }

    void sync()

    if (setupStatus?.state !== 'running') {
      return () => {
        cancelled = true
      }
    }

    const timer = window.setInterval(() => {
      void sync()
    }, 1500)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [onboardingOpen, onboardingSetupSkipped, onboardingStatus?.environment.ready, settingsOpen, setupStatus?.state, text.unexpectedError])

  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    void loadOnboarding().catch(() => undefined)
  }, [loadOnboarding, settingsOpen])

  useEffect(() => {
    if (setupStatus?.state === 'success') {
      void syncProviderStatuses()
      void loadOnboarding().catch(() => undefined)
    }
  }, [loadOnboarding, setupStatus?.state, syncProviderStatuses])

  useEffect(() => {
    setupRunStatusRef.current = setupStatus
  }, [setupStatus])

  const handleLocalSlashCommand = useCallback(
    async (columnId: string, card: ChatCard, prompt: string) => {
      const column = getColumn(columnId)
      if (!column) {
        return false
      }

      const parsed = parseSlashCommandInput(prompt)
      if (!parsed) {
        return false
      }

      const providerStatus = providerByName[card.provider] as ProviderStatus | undefined
      const language = appStateRef.current.settings.language
      const languageText = getLocaleText(language)
      const currentModel =
        normalizeModel(
          card.provider,
          card.model || appStateRef.current.settings.requestModels[card.provider],
        ) || languageText.statusProviderDefaultModel
      const currentReasoning = normalizeReasoningEffort(card.provider, card.reasoningEffort)
      const thinkingDepthLabel = language === 'en' ? 'Thinking depth' : '思考深度'

      switch (parsed.name) {
        case 'help': {
          appendCardLogs(
            columnId,
            card.id,
            card.provider,
            formatLocalSlashHelp(card.provider, language),
          )
          return true
        }
        case 'status': {
          const lines = [
            `${languageText.statusProvider}: ${getProviderLabel(language, card.provider)}`,
            `${languageText.statusModel}: ${currentModel}`,
            `${thinkingDepthLabel}: ${getReasoningLabel(card.provider, currentReasoning, language)} (${currentReasoning})`,
            `${languageText.statusWorkspace}: ${column.workspacePath || languageText.statusWorkspaceUnset}`,
            `${languageText.statusSession}: ${card.sessionId ?? languageText.statusSessionPending}`,
            `${languageText.statusCli}: ${providerStatus?.available ? (providerStatus.command ?? languageText.statusCliAvailable) : languageText.statusCliUnavailable}`,
          ]

          if (card.provider === 'codex') {
            lines.push(`${languageText.statusSlashMode}: ${languageText.codexSlashMode}`)
          } else {
            lines.push(`${languageText.statusSlashMode}: ${languageText.claudeSlashMode}`)
          }

          appendCardLogs(columnId, card.id, card.provider, lines.join('\n'))
          return true
        }
        case 'model': {
          const settings = appStateRef.current.settings
          const availableModelOptions = getModelOptions(card.provider).filter(
            (option) => isModelPickerOptionVisible(option) && isQuickToolModelEnabled(settings, option.model),
          )

          if (!parsed.args) {
            const availableModels = availableModelOptions
              .map((option) =>
                option.model
                  ? `- ${option.label}: ${option.model}`
                  : language === 'en'
                    ? `- ${option.label}: configured default (${appStateRef.current.settings.requestModels[card.provider]})`
                    : `- ${option.label}: 已配置默认值（${appStateRef.current.settings.requestModels[card.provider]}）`,
              )
              .join('\n')

            appendCardLogs(
              columnId,
              card.id,
              card.provider,
              [`${languageText.currentModel}: ${currentModel}`, languageText.modelCommandUsage, availableModels].join(
                '\n\n',
              ),
            )
            return true
          }

          const nextModel = resolveSlashModel(card.provider, parsed.args)
          if (nextModel === null || !isQuickToolModelEnabled(settings, nextModel)) {
            appendCardLogs(
              columnId,
              card.id,
              card.provider,
              languageText.unknownModel(parsed.args),
            )
            return true
          }

          const nextModelLabel =
            availableModelOptions.find((option) => option.model === nextModel)?.label ?? nextModel

          const actions: IdeAction[] = [
            {
              type: 'selectCardModel',
              columnId,
              cardId: card.id,
              provider: card.provider,
              model: nextModel,
            },
            {
              type: 'appendMessages',
              columnId,
              cardId: card.id,
              messages: createLogMessages(card.provider, languageText.switchedModel(nextModelLabel)),
            },
          ]
          persistAfterActions(actions, applyActions(actions))
          return true
        }
        case 'clear':
        case 'new': {
          await closeStream(card.id, true)
          clearQueuedSends(card.id)
          const action: IdeAction = {
            type: 'resetCardConversation',
            columnId,
            cardId: card.id,
          }
          persistAfterAction(action.type, applyAction(action))
          return true
        }
        default:
          return false
      }
    },
    [appendCardLogs, applyAction, applyActions, clearQueuedSends, closeStream, getColumn, persistAfterAction, persistAfterActions, providerByName],
  )

  const sendMessage = async (
    columnId: string,
    cardId: string,
    prompt: string,
    attachments: ImageAttachment[],
    options: SendMessageOptions = {},
  ) => {
    const column = getColumn(columnId)
    const card = column?.cards[cardId]

    if (!column || !card || !column.workspacePath.trim()) {
      return
    }

    const providerStatus = providerByName[card.provider] as ProviderStatus | undefined
    const resolvedModel = normalizeModel(
      card.provider,
      card.model || appStateRef.current.settings.requestModels[card.provider],
    )
    const resolvedReasoningEffort = normalizeReasoningEffort(card.provider, card.reasoningEffort)
    const resumeSessionId = getResumeSessionIdForModel(card, resolvedModel)
    const shouldStartFreshForModelChange = Boolean(card.sessionId?.trim()) && !resumeSessionId
    const replayMode = resolveChatReplayMode(card, resumeSessionId)
    const parsedSlashCommand = parseSlashCommandInput(prompt)

    if (attachments.length === 0 && (await handleLocalSlashCommand(columnId, card, prompt))) {
      return
    }

    // A brand-new send clears any previous recovery banner (including failed),
    // otherwise stale "Reconnect failed" can linger on the card after the user
    // retries manually.
    forceResetRecoveryStatus(cardId)

    if (card.status === 'streaming') {
      const sendMode = options.mode ?? 'auto'
      const latestUserMessage = [...card.messages].reverse().find((message) => message.role === 'user')
      const shouldAnswerAskUser =
        pendingAskUserDuringStreamRef.current.get(cardId) === true ||
        hasPendingAskUserMessage(card.messages) ||
        hasLatestPendingAskUserMessage(card.messages, prompt)
      const shouldQueueUntilDone =
        shouldAnswerAskUser ||
        isCompactBoundaryMessage(latestUserMessage, card.provider)
      if (shouldAnswerAskUser) {
        pendingAskUserDuringStreamRef.current.set(cardId, true)
        enqueueQueuedSend(cardId, { id: crypto.randomUUID(), prompt, attachments })
        queueMicrotask(() => {
          void requestStopForCard(cardId, 'ask-user-answer')
        })
        if (!stopCompletionFallbackTimersRef.current.has(cardId)) {
          const timer = window.setTimeout(() => {
            stopCompletionFallbackTimersRef.current.delete(cardId)
            const liveCard = getColumn(columnId)?.cards[cardId]
            if (!liveCard || liveCard.status !== 'streaming') {
              return
            }
            if (pendingAskUserDuringStreamRef.current.get(cardId) === true) {
              void finalizeStoppedAskUserWithoutServerAck(columnId, cardId)
              return
            }
          }, 250)
          stopCompletionFallbackTimersRef.current.set(cardId, timer)
        }
        return
      }
      if (shouldQueueUntilDone || sendMode === 'defer') {
        enqueueQueuedSend(cardId, { id: crypto.randomUUID(), prompt, attachments })
      } else {
        enqueueQueuedSend(cardId, { id: crypto.randomUUID(), prompt, attachments })
        await requestStopForCard(cardId, 'user-interrupt')
      }
      return
    }

    // A user-authored turn starts a new recovery lifecycle. This also protects
    // reused card ids after a terminal startup/provider failure left no active
    // stream to own the normal cleanup path.
    runStartedAtRef.current.delete(cardId)
    streamRetryCountRef.current.delete(cardId)
    resumeSessionLoopCountRef.current.delete(cardId)
    streamRecoveryTurnRef.current.delete(cardId)
    pendingAskUserDuringStreamRef.current.delete(cardId)
    // Approving a plan-approval card must drop plan mode before this send:
    // resuming with `--permission-mode plan` would intercept the model's next
    // ExitPlanMode call again and re-emit the same approval card forever.
    const approvedPlanExit =
      card.planMode === true && shouldExitPlanModeForAskUserAnswer(card.messages, prompt)
    const effectivePlanMode = approvedPlanExit ? false : card.planMode ?? false
    const nextTitle =
      card.messages.length === 0 && !card.title
        ? titleFromPrompt(prompt)
        : card.title
    const archiveRecall =
      card.provider === 'codex'
        ? buildArchiveRecallSnapshot({
            messages: card.messages,
            provider: card.provider,
            status: card.status,
          })
        : undefined
    const isManualCodexCompactRequest =
      card.provider === 'codex' &&
      attachments.length === 0 &&
      parsedSlashCommand?.name === 'compact' &&
      parsedSlashCommand.args.length === 0
    // An empty send on a normal chat card that already has history or a native
    // session means "continue from here". The user typed nothing, so no blank
    // user bubble should be appended, even if the provider later reports that
    // the local CLI is unavailable.
    const isEmptyContinuation =
      prompt.trim().length === 0 &&
      attachments.length === 0 &&
      !MODEL_PICKER_HIDDEN_TOOL_MODELS.has(card.model) &&
      canSendEmptyContinuation(card)
    const baseUserMessage = isManualCodexCompactRequest
      ? markCompactBoundaryMessage(
          createMessage('user', '/compact', attachImagesToMessageMeta(attachments)),
          { pending: true },
        )
      : markCompactBoundaryMessage(
          createMessage('user', prompt, attachImagesToMessageMeta(attachments)),
        )
    const language = appStateRef.current.settings.language
    const seedsTranscript = shouldStartFreshForModelChange || hasSeededChatTranscript(card)
    const seededRequestPrompt = seedsTranscript
      ? buildSeededChatPrompt({
          language,
          prompt,
          attachments,
          messages: card.messages,
          provider: card.provider,
          status: card.status,
          mode: replayMode,
        })
      : prompt
    const seededRequestAttachments = seedsTranscript
      ? collectSeededChatAttachments({
          messages: card.messages,
          attachments,
          provider: card.provider,
          status: card.status,
        })
      : attachments

    if (isProviderStatusExplicitlyUnavailable(providerStatus)) {
      streamRetryCountRef.current.delete(cardId)
      resumeSessionLoopCountRef.current.delete(cardId)
      const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
      const actions: IdeAction[] = [
        {
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [
            ...(isEmptyContinuation ? [] : [baseUserMessage]),
            createMessage('system', text.localCliUnavailable),
          ],
        },
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: {
            model: resolvedModel,
            reasoningEffort: resolvedReasoningEffort,
            status: 'error',
            streamId: undefined,
            title: nextTitle,
          },
        },
      ]
      if (durationMessage) {
        actions.push({
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [durationMessage],
        })
      }
      persistAfterActions(actions, applyActions(actions))
      return
    }

    const userMessage = baseUserMessage
    let requestPrompt = seededRequestPrompt
    let requestAttachments = seededRequestAttachments
    const requestMessages = isEmptyContinuation ? [] : [userMessage]

    if (isManualCodexCompactRequest) {
      requestPrompt = '/compact'
      requestAttachments = []
    }

    if (!isEmptyContinuation) {
      streamRecoveryTurnRef.current.set(cardId, {
        forkPoint: {
          content: userMessage.content,
          createdAt: userMessage.createdAt,
        },
        // Keep the user-authored turn, not a seeded transcript wrapper. A
        // native checkpoint already contains every completed earlier turn.
        prompt,
        attachments: attachments.slice(),
      })
    }

    const streamId = crypto.randomUUID()
    recordRunStart(runStartedAtRef.current, cardId, Date.now())
    const startedLocalRecoveryStats = beginOrContinueLocalRecoveryStatsRun(
      localRecoveryStatsRef.current.get(cardId),
    )
    localRecoveryStatsRef.current.set(cardId, startedLocalRecoveryStats.state)
    for (const event of startedLocalRecoveryStats.events) {
      void recordProxyStatsEvent({
        provider: card.provider,
        event,
        endpoint: '/cli/local-stream',
      }).catch(() => undefined)
    }
    queueFollowUpDuringStreamRef.current.set(cardId, isCompactBoundaryMessage(userMessage, card.provider))
    const startActions: IdeAction[] = [
      {
        type: 'appendMessages',
        columnId,
        cardId,
        messages: requestMessages,
      },
      {
        type: 'updateCard',
        columnId,
        cardId,
        patch: {
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          status: 'streaming',
          streamId,
          title: nextTitle,
          ...(approvedPlanExit ? { planMode: false } : {}),
        },
      },
    ]
    persistAfterActions(startActions, applyActions(startActions))

    try {
      const composedSystemPrompt = buildSystemPromptForModel(
        appStateRef.current.settings.systemPrompt,
        resolvedModel,
        appStateRef.current.settings.modelPromptRules,
      )
      const response = await requestChat({
        provider: card.provider,
        ...buildCodexChatRequestOverrides(card.provider, appStateRef.current.settings),
        workspacePath: column.workspacePath,
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        thinkingEnabled: card.thinkingEnabled !== false,
        planMode: effectivePlanMode,
        language,
        systemPrompt: composedSystemPrompt,
        modelPromptRules: appStateRef.current.settings.modelPromptRules,
        crossProviderSkillReuseEnabled:
          appStateRef.current.settings.crossProviderSkillReuseEnabled,
        streamId,
        sessionId: resumeSessionId,
        cardId,
        prompt: requestPrompt,
        attachments: requestAttachments,
        archiveRecall,
      })

      if (response.streamId !== streamId) {
        const action: IdeAction = {
          type: 'updateCard',
          columnId,
          cardId,
          patch: { streamId: response.streamId },
        }
        persistAfterAction(action.type, applyAction(action))
      }

      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return
      }

      attachStream(columnId, liveCard)
    } catch (error) {
      queueFollowUpDuringStreamRef.current.delete(cardId)
      pendingAskUserDuringStreamRef.current.delete(cardId)
      const actions: IdeAction[] = [
        {
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [createMessage('system', errorMessage(error, text.unexpectedError))],
        },
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: { status: 'error', streamId: undefined },
        },
      ]
      const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
      if (durationMessage) {
        actions.push({
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [durationMessage],
        })
      }

      if (isManualCodexCompactRequest) {
        actions.unshift({
          type: 'upsertMessages',
          columnId,
          cardId,
          messages: [clearPendingCompactBoundaryMessage(userMessage)],
        })
      }

      persistAfterActions(actions, applyActions(actions))
    }
  }
  sendMessageRef.current = sendMessage

  const resumeInterruptedSession = useCallback(async (entry: InterruptedSessionEntry) => {
    const { columnId, cardId } = entry
    const column = getColumn(columnId)
    const card = column?.cards[cardId]

    if (!column || !card) {
      return
    }

    const resolvedModel = normalizeModel(
      card.provider,
      card.model || appStateRef.current.settings.requestModels[card.provider],
    )
    const resolvedReasoningEffort = normalizeReasoningEffort(card.provider, card.reasoningEffort)
    const resumeRequest = getInterruptedSessionResumeRequest({
      sessionId: card.sessionId ?? entry.sessionId,
      sessionModel: card.sessionModel ?? entry.sessionModel,
      resumeMode: entry.resumeMode,
      resumePrompt: entry.resumePrompt,
      resumeAttachments: entry.resumeAttachments,
    }, resolvedModel)

    if (!column.workspacePath.trim() || !resumeRequest) {
      const action: IdeAction = {
        type: 'updateCard',
        columnId,
        cardId,
        patch: { status: 'idle', streamId: undefined },
      }
      persistAfterAction(action.type, applyAction(action))
      return
    }

    const providerStatus = providerByName[card.provider] as ProviderStatus | undefined

    if (isProviderStatusExplicitlyUnavailable(providerStatus)) {
      const actions: IdeAction[] = [
        {
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [createMessage('system', text.localCliUnavailable)],
        },
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: {
            model: resolvedModel,
            reasoningEffort: resolvedReasoningEffort,
            status: 'error',
            streamId: undefined,
          },
        },
      ]
      persistAfterActions(actions, applyActions(actions))
      return
    }

    const archiveRecall =
      card.provider === 'codex'
        ? buildArchiveRecallSnapshot({
            messages: card.messages,
            provider: card.provider,
            status: card.status,
          })
        : undefined
    const streamId = crypto.randomUUID()
    recordRunStart(runStartedAtRef.current, cardId, Date.now())
    const continuedLocalRecoveryStats = continueLocalRecoveryStatsRun(
      localRecoveryStatsRef.current.get(cardId),
    )
    if (continuedLocalRecoveryStats.state) {
      localRecoveryStatsRef.current.set(cardId, continuedLocalRecoveryStats.state)
    } else {
      localRecoveryStatsRef.current.delete(cardId)
    }
    for (const event of continuedLocalRecoveryStats.events) {
      void recordProxyStatsEvent({
        provider: card.provider,
        event,
        endpoint: '/cli/local-stream',
      }).catch(() => undefined)
    }
    const startAction: IdeAction = {
      type: 'updateCard',
      columnId,
      cardId,
      patch: {
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        status: 'streaming',
        streamId,
      },
    }
    persistAfterAction(startAction.type, applyAction(startAction))

    try {
      const composedSystemPrompt = buildSystemPromptForModel(
        appStateRef.current.settings.systemPrompt,
        resolvedModel,
        appStateRef.current.settings.modelPromptRules,
      )
      const response = await requestChat({
        provider: card.provider,
        ...buildCodexChatRequestOverrides(card.provider, appStateRef.current.settings),
        workspacePath: column.workspacePath,
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        thinkingEnabled: card.thinkingEnabled !== false,
        planMode: card.planMode ?? false,
        language: appStateRef.current.settings.language,
        systemPrompt: composedSystemPrompt,
        modelPromptRules: appStateRef.current.settings.modelPromptRules,
        crossProviderSkillReuseEnabled:
          appStateRef.current.settings.crossProviderSkillReuseEnabled,
        streamId,
        sessionId: resumeRequest.sessionId,
        cardId,
        prompt: resumeRequest.prompt,
        attachments: resumeRequest.attachments,
        archiveRecall,
      })

      if (response.streamId !== streamId) {
        const action: IdeAction = {
          type: 'updateCard',
          columnId,
          cardId,
          patch: { streamId: response.streamId },
        }
        persistAfterAction(action.type, applyAction(action))
      }

      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return
      }

      attachStream(columnId, liveCard)
    } catch (error) {
      streamRetryCountRef.current.delete(cardId)
      resumeSessionLoopCountRef.current.delete(cardId)
      const settledLocalRecoveryStats = settleLocalRecoveryStatsRun(
        localRecoveryStatsRef.current.get(cardId),
        'failure',
      )
      localRecoveryStatsRef.current.delete(cardId)
      for (const event of settledLocalRecoveryStats.events) {
        void recordProxyStatsEvent({
          provider: card.provider,
          event,
          endpoint: '/cli/local-stream',
          errorType: 'local-provider-start-failed',
        }).catch(() => undefined)
      }
      const actions: IdeAction[] = [
        {
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [createMessage('system', errorMessage(error, text.unexpectedError))],
        },
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: { status: 'error', streamId: undefined },
        },
      ]
      const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
      if (durationMessage) {
        actions.push({
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [durationMessage],
        })
      }
      persistAfterActions(actions, applyActions(actions))
    }
  }, [
    applyAction,
    applyActions,
    attachStream,
    getColumn,
    persistAfterAction,
    persistAfterActions,
    providerByName,
    text.localCliUnavailable,
    text.unexpectedError,
  ])

  const recoverLiveStream = useCallback(async (
    columnId: string,
    cardId: string,
    options?: RecoverLiveStreamOptions,
  ) => {
    const column = getColumn(columnId)
    const card = column?.cards[cardId]

    if (!column || !card || !column.workspacePath.trim()) {
      return false
    }

    const prefersNativeCheckpoint = options?.preferNativeCheckpoint === true
    const requestsSessionClear = options?.clearSessionId === true
    if (!requestsSessionClear && !prefersNativeCheckpoint && !card.sessionId) {
      return false
    }

    const providerStatus = providerByName[card.provider] as ProviderStatus | undefined
    const resolvedModel = normalizeModel(
      card.provider,
      card.model || appStateRef.current.settings.requestModels[card.provider],
    )
    const resolvedReasoningEffort = normalizeReasoningEffort(card.provider, card.reasoningEffort)

    if (isProviderStatusExplicitlyUnavailable(providerStatus)) {
      streamRetryCountRef.current.delete(cardId)
      resumeSessionLoopCountRef.current.delete(cardId)
      const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
      const actions: IdeAction[] = [
        {
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [createMessage('system', text.localCliUnavailable)],
        },
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: {
            model: resolvedModel,
            reasoningEffort: resolvedReasoningEffort,
            status: 'error',
            streamId: undefined,
          },
        },
      ]
      if (durationMessage) {
        actions.push({
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [durationMessage],
        })
      }
      persistAfterActions(actions, applyActions(actions))
      return false
    }

    const inferredCheckpointTurn = prefersNativeCheckpoint
      ? resolveStreamRecoveryCheckpointTurn({
          messages: card.messages,
          streamId: card.streamId,
        })
      : null
    const checkpointTurn = prefersNativeCheckpoint
      ? (
          streamRecoveryTurnRef.current.get(cardId) ??
          (inferredCheckpointTurn
            ? {
                forkPoint: {
                  content: inferredCheckpointTurn.message.content,
                  createdAt: inferredCheckpointTurn.message.createdAt,
                },
                prompt: inferredCheckpointTurn.prompt,
                attachments: inferredCheckpointTurn.attachments,
              }
            : null)
        )
      : null
    const sourceSessionId = card.sessionId?.trim() || null
    const sourceStreamId = card.streamId
    const forkedSessionId =
      checkpointTurn && sourceSessionId
        ? await forkProviderSession({
            provider: card.provider,
            workspacePath: column.workspacePath,
            sessionId: sourceSessionId,
            forkPoint: checkpointTurn.forkPoint,
          }).catch(() => null)
        : null

    if (prefersNativeCheckpoint) {
      const liveCard = getColumn(columnId)?.cards[cardId]
      if (
        !liveCard ||
        liveCard.streamId !== sourceStreamId ||
        (liveCard.sessionId?.trim() || null) !== sourceSessionId
      ) {
        // The local file fork is async. Never let a late result overwrite a
        // newer send/manual action that already took ownership of this card.
        return false
      }
    }

    const shouldClearSessionId =
      !forkedSessionId && (requestsSessionClear || prefersNativeCheckpoint)

    // Fact-check against the provider's native on-disk transcript before
    // resuming: a flaky relay can eat or corrupt the terminal event after the
    // reply already finished, and resuming a finished turn silently wakes the
    // model with an empty continuation — it then invents follow-up work
    // ("已解决" replies that revive themselves). 'completed' finalizes the card
    // instead of waking the provider; 'incomplete'/'unknown' fall through to
    // the normal resume so a genuinely interrupted turn is never stranded.
    if (!shouldClearSessionId && !forkedSessionId && card.provider === 'claude' && card.sessionId) {
      const completion = await getNativeTurnCompletion({
        provider: card.provider,
        sessionId: card.sessionId,
      })
      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== card.streamId) {
        // Another send/recovery took over while we were checking.
        return false
      }
      if (completion === 'completed') {
        streamRetryCountRef.current.delete(cardId)
        resumeSessionLoopCountRef.current.delete(cardId)
        streamRecoveryTurnRef.current.delete(cardId)
        forceResetRecoveryStatus(cardId)
        const activityFlushedState = flushBufferedActivitiesForCard(cardId)
        const flushedCard = getColumnById(activityFlushedState.columns, columnId)?.cards[cardId]
        const pendingCompactBoundary = flushedCard
          ? getPendingCompactBoundaryMessage(flushedCard.messages)
          : null
        const finalizeActions: IdeAction[] = [
          {
            type: 'updateCard',
            columnId,
            cardId,
            patch: { status: 'idle', streamId: undefined },
          },
        ]
        const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
        if (durationMessage) {
          finalizeActions.push({
            type: 'appendMessages',
            columnId,
            cardId,
            messages: [durationMessage],
          })
        }
        if (pendingCompactBoundary) {
          finalizeActions.unshift({
            type: 'upsertMessages',
            columnId,
            cardId,
            messages: [clearPendingCompactBoundaryMessage(pendingCompactBoundary)],
          })
        }
        persistAfterActions(finalizeActions, applyActions(finalizeActions))
        dispatchNextQueuedSend(columnId, cardId)
        return true
      }
    }

    const language = appStateRef.current.settings.language
    const freshSessionRecoveryPrompt = shouldClearSessionId
      ? buildSeededChatPrompt({
          language,
          prompt: language === 'en' ? 'Please continue.' : '\u8bf7\u7ee7\u7eed\u3002',
          attachments: [],
          messages: card.messages,
          provider: card.provider,
          status: card.status,
        })
      : ''
    const freshSessionRecoveryAttachments = shouldClearSessionId
      ? collectSeededChatAttachments({
          messages: card.messages,
          attachments: [],
          provider: card.provider,
          status: card.status,
        })
      : []
    const recoveryPrompt = forkedSessionId
      ? (checkpointTurn?.prompt ?? '')
      : shouldClearSessionId
        ? freshSessionRecoveryPrompt
        : ''
    const recoveryAttachments = forkedSessionId
      ? (checkpointTurn?.attachments ?? [])
      : shouldClearSessionId
        ? freshSessionRecoveryAttachments
        : []
    const archiveRecall =
      card.provider === 'codex' && !forkedSessionId
        ? buildArchiveRecallSnapshot({
            messages: card.messages,
            provider: card.provider,
            status: card.status,
          })
        : undefined
    const streamId = crypto.randomUUID()
    recordRunStart(runStartedAtRef.current, cardId, Date.now())
    const startedLocalRecoveryStats = beginOrContinueLocalRecoveryStatsRun(
      localRecoveryStatsRef.current.get(cardId),
    )
    localRecoveryStatsRef.current.set(cardId, startedLocalRecoveryStats.state)
    for (const event of startedLocalRecoveryStats.events) {
      void recordProxyStatsEvent({
        provider: card.provider,
        event,
        endpoint: '/cli/local-stream',
      }).catch(() => undefined)
    }
    const checkpointProviderSessions = { ...card.providerSessions }
    delete checkpointProviderSessions[card.provider]
    const startAction: IdeAction = {
      type: 'updateCard',
      columnId,
      cardId,
      patch: {
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        status: 'streaming',
        streamId,
        ...(forkedSessionId
          ? {
              sessionId: forkedSessionId,
              sessionModel: card.sessionModel ?? resolvedModel,
              providerSessions: checkpointProviderSessions,
            }
          : shouldClearSessionId
          ? {
              sessionId: undefined,
              sessionModel: undefined,
              providerSessions: {},
            }
          : {}),
      },
    }
    persistAfterAction(startAction.type, applyAction(startAction))

    try {
      const composedSystemPrompt = buildSystemPromptForModel(
        appStateRef.current.settings.systemPrompt,
        resolvedModel,
        appStateRef.current.settings.modelPromptRules,
      )
      const response = await requestChat({
        provider: card.provider,
        ...buildCodexChatRequestOverrides(card.provider, appStateRef.current.settings),
        workspacePath: column.workspacePath,
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        thinkingEnabled: card.thinkingEnabled !== false,
        planMode: card.planMode ?? false,
        language,
        systemPrompt: composedSystemPrompt,
        modelPromptRules: appStateRef.current.settings.modelPromptRules,
        crossProviderSkillReuseEnabled:
          appStateRef.current.settings.crossProviderSkillReuseEnabled,
        streamId,
        sessionId:
          forkedSessionId ??
          (shouldClearSessionId ? undefined : getResumeSessionIdForModel(card, resolvedModel)),
        cardId,
        prompt: recoveryPrompt,
        attachments: recoveryAttachments,
        archiveRecall,
      })

      if (response.streamId !== streamId) {
        const action: IdeAction = {
          type: 'updateCard',
          columnId,
          cardId,
          patch: { streamId: response.streamId },
        }
        persistAfterAction(action.type, applyAction(action))
      }

      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return false
      }

      attachStream(columnId, liveCard)
      return true
    } catch (error) {
      streamRetryCountRef.current.delete(cardId)
      resumeSessionLoopCountRef.current.delete(cardId)
      const settledLocalRecoveryStats = settleLocalRecoveryStatsRun(
        localRecoveryStatsRef.current.get(cardId),
        'failure',
      )
      localRecoveryStatsRef.current.delete(cardId)
      for (const event of settledLocalRecoveryStats.events) {
        void recordProxyStatsEvent({
          provider: card.provider,
          event,
          endpoint: '/cli/local-stream',
          errorType: 'local-provider-start-failed',
        }).catch(() => undefined)
      }
      const actions: IdeAction[] = [
        {
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [createMessage('system', errorMessage(error, text.unexpectedError))],
        },
        {
          type: 'updateCard',
          columnId,
          cardId,
          patch: { status: 'error', streamId: undefined },
        },
      ]
      const durationMessage = consumeRunDurationMessage(runStartedAtRef.current, cardId)
      if (durationMessage) {
        actions.push({
          type: 'appendMessages',
          columnId,
          cardId,
          messages: [durationMessage],
        })
      }
      persistAfterActions(actions, applyActions(actions))
      return false
    }
  }, [
    applyAction,
    applyActions,
    attachStream,
    dispatchNextQueuedSend,
    flushBufferedActivitiesForCard,
    forceResetRecoveryStatus,
    getColumn,
    persistAfterAction,
    persistAfterActions,
    providerByName,
    text.localCliUnavailable,
    text.unexpectedError,
  ])
  recoverLiveStreamRef.current = recoverLiveStream

  const manuallyRecoverStream = useCallback(
    async (columnId: string, cardId: string) => {
      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard) {
        return false
      }

      if (!streamRecoveryTurnRef.current.has(cardId)) {
        const inferredCheckpointTurn = resolveStreamRecoveryCheckpointTurn({
          messages: liveCard.messages,
          streamId: liveCard.streamId,
        })
        if (inferredCheckpointTurn) {
          streamRecoveryTurnRef.current.set(cardId, {
            forkPoint: {
              content: inferredCheckpointTurn.message.content,
              createdAt: inferredCheckpointTurn.message.createdAt,
            },
            prompt: inferredCheckpointTurn.prompt,
            attachments: inferredCheckpointTurn.attachments,
          })
        }
      }

      if (liveCard.streamId) {
        activeStreamsRef.current.get(cardId)?.source.close()
        activeStreamsRef.current.delete(cardId)
        const fallbackTimer = stopCompletionFallbackTimersRef.current.get(cardId)
        if (fallbackTimer !== undefined) {
          window.clearTimeout(fallbackTimer)
          stopCompletionFallbackTimersRef.current.delete(cardId)
        }
        stoppedRunReasonRef.current.set(liveCard.streamId, 'manual')
        await stopChat(liveCard.streamId).catch(() => undefined)
        stoppedRunReasonRef.current.delete(liveCard.streamId)
      }

      const settledLocalRecoveryStats = settleLocalRecoveryStatsRun(
        localRecoveryStatsRef.current.get(cardId),
        'abandoned',
      )
      localRecoveryStatsRef.current.delete(cardId)
      for (const event of settledLocalRecoveryStats.events) {
        void recordProxyStatsEvent({
          provider: liveCard.provider,
          event,
          endpoint: '/cli/local-stream',
        }).catch(() => undefined)
      }

      streamRetryCountRef.current.delete(cardId)
      resumeSessionLoopCountRef.current.delete(cardId)
      queueFollowUpDuringStreamRef.current.delete(cardId)
      pendingAskUserDuringStreamRef.current.delete(cardId)
      forceResetRecoveryStatus(cardId)

      const currentCard = getColumn(columnId)?.cards[cardId]
      if (!currentCard) {
        return false
      }

      const action: IdeAction = {
        type: 'updateCard',
        columnId,
        cardId,
        patch: {
          streamId: undefined,
        },
      }
      persistAfterAction(action.type, applyAction(action))

      return recoverLiveStreamRef.current?.(columnId, cardId, {
        clearSessionId: true,
        preferNativeCheckpoint: true,
      }) ?? false
    },
    [applyAction, forceResetRecoveryStatus, getColumn, persistAfterAction],
  )


  const closeTab = async (columnId: string, paneId: string, cardId: string) => {
    clearQueuedSends(cardId)
    await closeStream(cardId, true)
    const column = appStateRef.current.columns.find((entry) => entry.id === columnId)
    const card = column?.cards[cardId]

    if (card?.model === FILETREE_TOOL_MODEL) {
      clearFileTreeCacheForCard(cardId)
    }

    if ((card?.model === TEXTEDITOR_TOOL_MODEL || card?.model === IMAGEEDITOR_TOOL_MODEL) && column) {
      // Closing the editor card ends the editing session; release its parked model.
      evictTextEditorModel(column.workspacePath, card.stickyNote ?? '')
    }

    applyAction({ type: 'closeTab', columnId, paneId, tabId: cardId })
  }

  // Global keyboard shortcuts for tab management
  const closeTabRef = useRef(closeTab)
  closeTabRef.current = closeTab

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey
      if (!ctrl) return

      const target = resolvePaneTarget()
      if (!target) return

      const column = appStateRef.current.columns.find((c) => c.id === target.columnId)
      if (!column) return

      const paneNode = findPaneInLayout(column.layout, target.paneId)
      if (!paneNode) return

      if (event.key === 'w' || event.key === 'W') {
        event.preventDefault()
        if (paneNode.activeTabId) {
          void closeTabRef.current(target.columnId, target.paneId, paneNode.activeTabId)
        }
        return
      }

      if (event.key === 't' || event.key === 'T') {
        event.preventDefault()
        rememberPaneTarget(target.columnId, target.paneId)
        applyAction({ type: 'addTab', columnId: target.columnId, paneId: target.paneId })
        // Keyboard tab creation must focus the new composer just like the
        // pointer path does; the pane-local counter is bumped via this event.
        dispatchComposerFocusRequest(target.paneId)
        return
      }

      if (event.key === 'Tab') {
        event.preventDefault()
        const tabs = paneNode.tabs
        if (tabs.length < 2) return
        const currentIndex = tabs.indexOf(paneNode.activeTabId)
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : (currentIndex + 1) % tabs.length
        applyAction({ type: 'setActiveTab', columnId: target.columnId, paneId: target.paneId, tabId: tabs[nextIndex]! })
        dispatchComposerFocusRequest(target.paneId)
        return
      }

      if (event.key === '\\') {
        event.preventDefault()
        applyAction({
          type: 'splitPane',
          columnId: target.columnId,
          paneId: target.paneId,
          direction: event.shiftKey ? 'vertical' : 'horizontal',
        })
        return
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [resolvePaneTarget, rememberPaneTarget, applyAction])

  const openCloseWorkspaceDialog = useCallback((columnId: string) => {
    setCloseWorkspaceDialogColumnId(columnId)
  }, [])

  const closeCloseWorkspaceDialog = useCallback(() => {
    if (closeWorkspacePending) {
      return
    }

    setCloseWorkspaceDialogColumnId(null)
  }, [closeWorkspacePending])

  const removeColumn = async (columnId: string) => {
    const column = getColumn(columnId)
    if (!column) {
      setCloseWorkspaceDialogColumnId(null)
      return
    }

    getOrderedColumnCards(column).forEach((card) => clearQueuedSends(card.id))
    await Promise.all(getOrderedColumnCards(column).map((card) => closeStream(card.id, true)))
    applyAction({ type: 'removeColumn', columnId })
    setCloseWorkspaceDialogColumnId(null)
  }

  const confirmCloseWorkspace = async () => {
    if (!closeWorkspaceDialogColumnId || closeWorkspacePending) {
      return
    }

    setCloseWorkspacePending(true)
    try {
      await removeColumn(closeWorkspaceDialogColumnId)
    } finally {
      setCloseWorkspacePending(false)
    }
  }

  const stopCard = async (cardId: string) => {
    await requestStopForCard(cardId, 'manual')
  }


  const handleReset = async () => {
    await Promise.all([...activeStreamsRef.current.keys()].map((cardId) => closeStream(cardId, true)))
    queuedSendRequestsRef.current.clear()
    setQueuedSendSummaries(new Map())
    queueFollowUpDuringStreamRef.current.clear()
    pendingAskUserDuringStreamRef.current.clear()
    stopCompletionFallbackTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    stopCompletionFallbackTimersRef.current.clear()

    try {
      const state = await resetState()
      setProviders([])
      commitLoadedState(state)
    } catch {
      setSaveStatus('error')
    }
  }

  const handleResolveStartupRecovery = useCallback(async (optionId: string) => {
    setStateRecoveryPending(true)
    setStateRecoveryError(null)
    clearTransientRuntimeState()

    try {
      const response = await resolveStateRecoveryOption({ optionId })
      commitLoadedState(response.state, response.recovery)
      if (!response.recovery.startup && !response.recovery.interruptedSessions) {
        attachStreamsForState(response.state)
      }
    } catch (error) {
      setStateRecoveryError(
        errorMessage(
          error,
          appState.settings.language === 'zh-CN'
            ? '恢复失败，请换一个状态版本再试。'
            : 'Failed to restore the selected state. Try another option.',
        ),
      )
    } finally {
      setStateRecoveryPending(false)
    }
  }, [
    appState.settings.language,
    attachStreamsForState,
    clearTransientRuntimeState,
    commitLoadedState,
  ])

  const handleDismissRecentCrash = useCallback(async () => {
    setRecentCrashActionPending(true)
    setRecentCrashActionError(null)

    try {
      await dismissRecentCrashRecovery()
      setRecentCrashRecovery(null)
    } catch (error) {
      setRecentCrashActionError(
        errorMessage(
          error,
          appState.settings.language === 'zh-CN'
            ? '清除最近会话恢复提示失败，请稍后再试。'
            : 'Failed to dismiss the recent-session recovery notice. Please try again.',
        ),
      )
    } finally {
      setRecentCrashActionPending(false)
    }
  }, [appState.settings.language])

  const handleRestoreRecentCrashSessions = useCallback(async () => {
    if (!recentCrashRecovery) {
      return
    }

    setRecentCrashActionPending(true)
    setRecentCrashActionError(null)

    try {
      const restoredEntries = await Promise.all(
        recentCrashRecovery.sessionHistoryEntryIds.map(async (entryId) => {
          const response = await loadSessionHistoryEntry({ entryId })
          return response.entry
        }),
      )
      const restoreActions: IdeAction[] = []

      for (const entry of restoredEntries) {
        const columnId = findSessionRestoreColumnId(appStateRef.current, entry)
        if (!columnId) {
          continue
        }

        restoreActions.push({
          type: 'importExternalSession',
          columnId,
          entry,
        })
      }

      restoreActions.push({
        type: 'removeSessionHistory',
        entryIds: restoredEntries.map((entry) => entry.id),
      })
      const nextState = applyActions(restoreActions)
      persistImmediately(nextState)
      updateLatestKnownAppState(nextState)
      await dismissRecentCrashRecovery()
      setRecentCrashRecovery(null)
    } catch (error) {
      setRecentCrashActionError(
        errorMessage(
          error,
          appState.settings.language === 'zh-CN'
            ? '恢复最近会话失败，请稍后再试。'
            : 'Failed to restore the recent sessions. Please try again.',
        ),
      )
    } finally {
      setRecentCrashActionPending(false)
    }
  }, [
    appState.settings.language,
    applyActions,
    persistImmediately,
    recentCrashRecovery,
  ])

  const handleRestoreSession = useCallback((columnId: string, entryId: string) => {
    void (async () => {
      try {
        const column = getColumn(columnId)
        const paneId = resolveColumnPaneTarget(columnId) ?? (column ? getFirstPane(column.layout).id : undefined)
        const entry = await resolveSessionHistoryEntryForRestore({
          entryId,
          state: appStateRef.current,
          loadEntry: loadSessionHistoryEntry,
        })
        const actions: IdeAction[] = [
          {
            type: 'importExternalSession',
            columnId,
            paneId,
            entry,
          },
          {
            type: 'removeSessionHistory',
            entryIds: [entryId],
          },
        ]
        const nextState = applyActions(actions)

        persistAfterActions(actions, nextState)
        updateLatestKnownAppState(nextState)
        await hideInternalSessionHistory({
          entryId,
          provider: entry.provider,
          sessionId: entry.sessionId,
        })
      } catch (error) {
        console.error('[history] Failed to restore archived session.', error)
      }
    })()
  }, [applyActions, getColumn, persistAfterActions, resolveColumnPaneTarget])

  const handleDismissInterruptedSessions = useCallback(() => {
    if (!interruptedSessionRecovery) {
      return
    }

    setInterruptedSessionActionPending(true)
    setInterruptedSessionActionError(null)

    try {
      const actions: IdeAction[] = interruptedSessionRecovery.entries.map((entry) => ({
        type: 'updateCard',
        columnId: entry.columnId,
        cardId: entry.cardId,
        patch: { status: 'idle' as const, streamId: undefined },
      }))
      const nextState = applyActions(actions)
      persistAfterActions(actions, nextState)
      updateLatestKnownAppState(nextState)
      setInterruptedSessionRecovery(null)
    } catch (error) {
      setInterruptedSessionActionError(
        errorMessage(
          error,
          appState.settings.language === 'zh-CN'
            ? '清除中断会话提示失败，请稍后再试。'
            : 'Failed to dismiss the interrupted-session recovery notice. Please try again.',
        ),
      )
    } finally {
      setInterruptedSessionActionPending(false)
    }
  }, [
    appState.settings.language,
    applyActions,
    interruptedSessionRecovery,
    persistAfterActions,
  ])

  const handleResumeInterruptedSessions = useCallback(async () => {
    if (!interruptedSessionRecovery) {
      return
    }

    setInterruptedSessionActionPending(true)
    setInterruptedSessionActionError(null)

    try {
      const unrecoverableEntries = interruptedSessionRecovery.entries.filter((entry) => !entry.recoverable)
      if (unrecoverableEntries.length > 0) {
        const actions: IdeAction[] = unrecoverableEntries.map((entry) => ({
          type: 'updateCard',
          columnId: entry.columnId,
          cardId: entry.cardId,
          patch: { status: 'idle' as const, streamId: undefined },
        }))
        const nextState = applyActions(actions)
        persistAfterActions(actions, nextState)
        updateLatestKnownAppState(nextState)
      }

      const recoverableEntries = interruptedSessionRecovery.entries.filter((entry) => entry.recoverable)
      for (let index = 0; index < recoverableEntries.length; index += maxConcurrentInterruptedSessionResumes) {
        const batch = recoverableEntries.slice(index, index + maxConcurrentInterruptedSessionResumes)
        await Promise.all(batch.map((entry) => resumeInterruptedSession(entry)))

        if (index + maxConcurrentInterruptedSessionResumes < recoverableEntries.length) {
          await delayInterruptedSessionResumeBatch()
        }
      }

      setInterruptedSessionRecovery(null)
    } catch (error) {
      setInterruptedSessionActionError(
        errorMessage(
          error,
          appState.settings.language === 'zh-CN'
            ? '恢复中断会话失败，请稍后再试。'
            : 'Failed to resume the interrupted sessions. Please try again.',
        ),
      )
    } finally {
      setInterruptedSessionActionPending(false)
    }
  }, [
    appState.settings.language,
    applyActions,
    interruptedSessionRecovery,
    persistAfterActions,
    resumeInterruptedSession,
  ])

  const handleRunSetup = useCallback(async () => {
    setSettingsNotice(null)
    setSetupStatusPending(true)

    try {
      const nextStatus = await runEnvironmentSetup()
      setupRunStatusRef.current = nextStatus
      setSetupStatus(nextStatus)
    } catch (error) {
      const nextStatus = {
        state: 'error',
        message: errorMessage(error, text.unexpectedError),
        logs: [],
      } satisfies SetupStatus
      setupRunStatusRef.current = nextStatus
      setSetupStatus(nextStatus)
    } finally {
      setSetupStatusPending(false)
      if (setupRunStatusRef.current?.state === 'success') {
        void loadOnboarding().catch(() => undefined)
      }
      void syncProviderStatuses()
    }
  }, [loadOnboarding, syncProviderStatuses, text.unexpectedError])

  const handleUpdateCli = useCallback(async () => {
    setSettingsNotice(null)
    setSetupStatusPending(true)

    try {
      setSetupStatus(
        await runEnvironmentSetup({
          mode: 'update-cli',
          cli: cliUpdateTarget,
          version: cliUpdateVersion.trim() || 'latest',
        }),
      )
    } catch (error) {
      setSetupStatus({
        state: 'error',
        message: errorMessage(error, text.unexpectedError),
        logs: [],
      })
    } finally {
      setSetupStatusPending(false)
      void syncProviderStatuses()
    }
  }, [cliUpdateTarget, cliUpdateVersion, syncProviderStatuses, text.unexpectedError])

  const setGuideLanguage = useCallback(
    (language: AppState['settings']['language']) => {
      setOnboardingLanguage(language)
    },
    [],
  )

  const completeOnboarding = useCallback(() => {
    try {
      window.localStorage.setItem(onboardingStorageKey, 'done')
    } catch {
      // Ignore local storage failures and still let the user continue.
    }

    applyAction({
      type: 'updateSettings',
      patch: { language: onboardingLanguage },
    })
    setOnboardingOpen(false)
    setOnboardingCandidate(false)
    setOnboardingInitialized(true)
    setOnboardingImportError(null)
  }, [applyAction, onboardingLanguage])

  const handleOnboardingImport = useCallback(async () => {
    setOnboardingImportError(null)

    try {
      const result = await runCcSwitchImport({ mode: 'default' }, onboardingLanguage)
      setOnboardingImportState('imported')
      setOnboardingImportNotice(result.summary)
    } catch (error) {
      setOnboardingImportError(errorMessage(error, getRoutingImportText(onboardingLanguage).importError))
    }
  }, [onboardingLanguage, runCcSwitchImport])

  const setupHeadline =
    setupStatus?.state === 'running'
      ? panelText.setupRunning
      : setupStatus?.state === 'success'
        ? panelText.setupSuccess
        : setupStatus?.state === 'error'
          ? panelText.setupError
          : setupStatus?.state === 'unsupported'
            ? panelText.setupUnsupported
            : onboardingStatusPending || !onboardingStatus
              ? panelText.setupLoading
              : onboardingStatus.environment.checks.some((check) => !check.available)
                ? panelText.setupDetectedMissing
                : panelText.setupIdle
  const setupLogs = setupStatus?.logs ?? []
  const hasRunSetup = (setupStatus?.state ?? 'idle') !== 'idle'
  const hasSetupLogs = setupLogs.length > 0
  const missingEnvironmentChecks = useMemo(
    () => onboardingStatus?.environment.checks.filter((check) => !check.available) ?? [],
    [onboardingStatus],
  )
  const hasMissingEnvironmentChecks = missingEnvironmentChecks.length > 0
  const onboardingMissingTools = useMemo(
    () => missingEnvironmentChecks.map((check) => check.label).join(', '),
    [missingEnvironmentChecks],
  )
  const onboardingEnvironmentReady = Boolean(onboardingStatus?.environment.ready) || setupStatus?.state === 'success'
  const showSettingsSetupPanel =
    Boolean(onboardingStatus) && !onboardingStatusPending
  const setupStatusMessage =
    setupStatus?.message ??
    (setupStatusPending
      ? panelText.setupLoading
      : hasMissingEnvironmentChecks
        ? panelText.setupReadyToInstall
        : panelText.setupIdle)
  const onboardingStage: OnboardingStage =
    onboardingStatusPending || !onboardingStatus
      ? 'loading'
      : !onboardingEnvironmentReady && !onboardingSetupSkipped
        ? 'setup'
        : onboardingStatus.ccSwitch.available && onboardingImportState === 'idle'
          ? 'import'
          : 'complete'
  const onboardingSetupSummary = onboardingSetupSkipped
    ? onboardingText.setupSkipped
    : onboardingEnvironmentReady
      ? setupStatus?.state === 'success'
        ? setupStatus.message ?? onboardingText.environmentReady
        : onboardingText.environmentReady
      : setupStatus?.state === 'unsupported'
        ? setupStatus.message ?? onboardingText.setupUnsupported
        : setupStatus?.message
          ? setupStatus.message
          : onboardingMissingTools
            ? onboardingText.missingTools(onboardingMissingTools)
            : onboardingText.runningSetup
  const onboardingImportSummary =
    onboardingImportState === 'imported' && onboardingImportNotice
      ? onboardingImportNotice
      : onboardingImportState === 'skipped'
        ? onboardingText.importSkipped
        : onboardingStatus?.ccSwitch.available
          ? onboardingText.ccSwitchDetected(onboardingStatus.ccSwitch.source ?? '~/.cc-switch/cc-switch.db')
          : onboardingText.ccSwitchMissing
  const onboardingCurrentTitle =
    onboardingStage === 'loading'
      ? onboardingText.loadingTitle
      : onboardingStage === 'setup'
        ? onboardingText.setupStepTitle
        : onboardingStage === 'import'
          ? onboardingText.importStepTitle
          : onboardingText.completeTitle
  const onboardingCurrentDescription =
    onboardingStage === 'loading'
      ? onboardingText.loadingDescription
      : onboardingStage === 'setup'
        ? setupStatus?.state === 'error' || setupStatus?.state === 'unsupported'
          ? setupStatus?.message ?? onboardingText.setupUnsupported
          : onboardingMissingTools
            ? onboardingText.missingTools(onboardingMissingTools)
            : onboardingText.runningSetup
        : onboardingStage === 'import'
          ? onboardingText.importPrompt(onboardingStatus?.ccSwitch.source ?? '~/.cc-switch/cc-switch.db')
          : onboardingText.completeDescription
  const onboardingSetupButtonLabel =
    setupStatusPending || setupStatus?.state === 'running'
      ? onboardingText.installing
      : setupStatus?.state === 'error' || setupStatus?.state === 'unsupported'
        ? onboardingText.retrySetup
        : panelText.installMissingTools

  useEffect(() => {
    if (!onboardingOpen || onboardingStage !== 'setup') {
      onboardingAutoSetupStartedRef.current = false
      return
    }

    if (
      onboardingEnvironmentReady ||
      onboardingSetupSkipped ||
      setupStatusPending ||
      setupStatus?.state === 'running' ||
      setupStatus?.state === 'error' ||
      setupStatus?.state === 'unsupported'
    ) {
      return
    }

    if (onboardingAutoSetupStartedRef.current) {
      return
    }

    onboardingAutoSetupStartedRef.current = true
    void handleRunSetup()
  }, [
    handleRunSetup,
    onboardingEnvironmentReady,
    onboardingOpen,
    onboardingSetupSkipped,
    onboardingStage,
    setupStatus?.state,
    setupStatusPending,
  ])

  // Sync weatherCityDraft when settings change externally
  useEffect(() => {
    setWeatherCityDraft(appState.settings.weatherCity)
  }, [appState.settings.weatherCity])

  // Click-outside to close weather city suggestions
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (weatherCityWrapperRef.current && !weatherCityWrapperRef.current.contains(e.target as Node)) {
        setWeatherCitySuggestionsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleWeatherCityInput = (value: string) => {
    setWeatherCityDraft(value)
    setWeatherCitySelectedIndex(0)
    window.clearTimeout(weatherCityTimerRef.current)

    if (!value.trim()) {
      setWeatherCitySuggestions([])
      setWeatherCitySuggestionsOpen(false)
      applyAction({ type: 'updateSettings', patch: { weatherCity: '' } })
      return
    }

    weatherCityTimerRef.current = window.setTimeout(async () => {
      try {
        const results = await searchCities(value)
        setWeatherCitySuggestions(results)
        setWeatherCitySuggestionsOpen(results.length > 0)
      } catch {
        setWeatherCitySuggestions([])
        setWeatherCitySuggestionsOpen(false)
      }
    }, 300)
  }

  const handleWeatherCitySelect = (suggestion: CitySuggestion) => {
    const label = [suggestion.name, suggestion.admin1, suggestion.country].filter(Boolean).join(', ')
    setWeatherCityDraft(label)
    setWeatherCitySuggestionsOpen(false)
    applyAction({ type: 'updateSettings', patch: { weatherCity: suggestion.name } })
  }

  const handleWeatherCityKeyDown = (e: React.KeyboardEvent) => {
    if (!weatherCitySuggestionsOpen || weatherCitySuggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setWeatherCitySelectedIndex((i) => Math.min(i + 1, weatherCitySuggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setWeatherCitySelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleWeatherCitySelect(weatherCitySuggestions[weatherCitySelectedIndex])
    } else if (e.key === 'Escape') {
      setWeatherCitySuggestionsOpen(false)
    }
  }

  const renderWithPrimer = (content: ReactNode) => (
    <ThemeProvider colorMode={resolvedTheme}>
      <BaseStyles>{content}</BaseStyles>
    </ThemeProvider>
  )

  const selectedAppFontFamilyCss = resolveAppFontFamilyCss(appState.settings.fontFamily)
  const renderFontFamilySettings = (selectId: string) => (
    <div className="settings-section">
      <label className="settings-field" htmlFor={selectId}>
        <span>{text.fontFamily}</span>
        <select
          id={selectId}
          className="control settings-input"
          value={appState.settings.fontFamily}
          onChange={(event) =>
            applyAction({
              type: 'updateSettings',
              patch: { fontFamily: event.target.value as AppState['settings']['fontFamily'] },
            })
          }
        >
          {appFontFamilyOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {appState.settings.language === 'en' ? option.labelEn : option.label}
            </option>
          ))}
        </select>
      </label>
      <div
        className="font-preview-card"
        style={{ fontFamily: selectedAppFontFamilyCss }}
        aria-label={appState.settings.language === 'en' ? 'Font preview' : '字体预览'}
      >
        <div className="font-preview-title">
          {appState.settings.language === 'en' ? 'Preview' : '预览'}
        </div>
        <div className="font-preview-sample">你好 Chill Vibe · The quick brown fox jumps over 12345</div>
        <div className="font-preview-meta">Aa Bb Cc · 中文字体测试 · 0O1lI</div>
      </div>
    </div>
  )

  const renderCodexSafetySettings = (idPrefix: string) => (
    <div className="codex-safety-settings">
      <label className="settings-toggle" htmlFor={`${idPrefix}-codex-destructive-command-protection`}>
        <span>{text.codexDestructiveCommandProtectionLabel}</span>
        <input
          id={`${idPrefix}-codex-destructive-command-protection`}
          type="checkbox"
          checked={appState.settings.codexDestructiveCommandProtectionEnabled}
          onChange={(event) =>
            applyAction({
              type: 'updateSettings',
              patch: { codexDestructiveCommandProtectionEnabled: event.target.checked },
            })
          }
        />
      </label>
      <p className="settings-note">{text.codexDestructiveCommandProtectionNote}</p>

      <label className="settings-toggle" htmlFor={`${idPrefix}-codex-isolated-home`}>
        <span>{text.codexIsolatedHomeLabel}</span>
        <input
          id={`${idPrefix}-codex-isolated-home`}
          type="checkbox"
          checked={appState.settings.codexIsolatedHomeEnabled}
          onChange={(event) =>
            applyAction({
              type: 'updateSettings',
              patch: { codexIsolatedHomeEnabled: event.target.checked },
            })
          }
        />
      </label>
      <p className="settings-note">{text.codexIsolatedHomeNote}</p>
    </div>
  )

  const renderThemeToggle = () => {
    const themeOptions: Array<{ value: AppState['settings']['theme']; label: string }> = [
      { value: 'light', label: text.light },
      { value: 'dark', label: text.dark },
      { value: 'system', label: text.systemTheme },
      { value: 'custom', label: text.customTheme },
    ]
    const isCustomTheme = appState.settings.theme === 'custom'
    const displayedAccentColor =
      appState.settings.accentColor ?? getDefaultThemeAccentColor(resolvedTheme)
    const customBaseOptions: Array<{ value: AppState['settings']['customThemeBase']; label: string }> = [
      { value: 'light', label: text.light },
      { value: 'dark', label: text.dark },
    ]
    const customBaseColor = appState.settings.customBaseColor
    const displayedBaseColor =
      customBaseColor ?? getDefaultThemeSurfaceColor(appState.settings.customThemeBase)

    return (
      <div className="theme-settings">
        <div className="theme-toggle">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`theme-chip${appState.settings.theme === option.value ? ' is-active' : ''}`}
              onClick={() => applyAction({ type: 'updateSettings', patch: { theme: option.value } })}
            >
              {option.label}
            </button>
          ))}
        </div>

        {isCustomTheme && (
          <div className="theme-custom-settings">
            <div className="theme-custom-base">
              <span className="theme-custom-base-label">{text.customThemeBase}</span>
              <div className="theme-toggle">
                {customBaseOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`theme-chip${
                      !customBaseColor && appState.settings.customThemeBase === option.value
                        ? ' is-active'
                        : ''
                    }`}
                    onClick={() =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { customThemeBase: option.value, customBaseColor: null },
                      })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <label
                className={`theme-color-picker theme-base-picker${customBaseColor ? ' is-custom' : ''}`}
                title={text.customThemeBase}
              >
                <input
                  type="color"
                  value={displayedBaseColor}
                  aria-label={text.customThemeBase}
                  onChange={(event) => {
                    const nextBaseColor = event.target.value
                    applyAction({
                      type: 'updateSettings',
                      patch: {
                        customBaseColor: nextBaseColor,
                        customThemeBase: getSurfaceBaseAppearance(nextBaseColor) ?? 'dark',
                      },
                    })
                  }}
                />
              </label>
              {customBaseColor && <code className="theme-base-color-value">{customBaseColor}</code>}
            </div>

            <div className={`theme-color-control${appState.settings.accentColor ? ' is-custom' : ''}`}>
              <label className="theme-color-picker" title={text.accentColor}>
                <input
                  type="color"
                  value={displayedAccentColor}
                  aria-label={text.accentColor}
                  onChange={(event) =>
                    applyAction({
                      type: 'updateSettings',
                      patch: { accentColor: event.target.value },
                    })
                  }
                />
              </label>
              <div className="theme-color-copy">
                <div className="theme-color-heading">
                  <span>{text.accentColor}</span>
                  <code>{displayedAccentColor}</code>
                  {!appState.settings.accentColor && <em>{text.defaultAccentColor}</em>}
                </div>
                <p>{text.accentColorHint}</p>
              </div>
              <button
                type="button"
                className="theme-color-reset"
                disabled={!appState.settings.accentColor}
                onClick={() =>
                  applyAction({
                    type: 'updateSettings',
                    patch: { accentColor: null },
                  })
                }
              >
                {text.resetAccentColor}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const startupRecoveryCopy =
    appState.settings.language === 'zh-CN'
      ? {
          eyebrow: 'State Recovery',
          title: '\u68c0\u6d4b\u5230\u5f02\u5e38\u7684\u672c\u5730\u72b6\u6001\u6587\u4ef6',
          description:
            '\u542f\u52a8\u65f6\u53d1\u73b0\u635f\u574f\u7684 state.wal \u6216\u66f4\u65b0\u7684\u4e34\u65f6\u72b6\u6001\u6587\u4ef6\u3002\u8bf7\u9009\u62e9\u8981\u6253\u5f00\u7684\u7248\u672c\uff0c\u5e94\u7528\u4e0d\u4f1a\u9759\u9ed8\u7ee7\u7eed\u3002',
          issuesTitle: '\u68c0\u6d4b\u5230\u7684\u95ee\u9898',
          optionsTitle: '\u9009\u62e9\u8981\u6062\u590d\u7684\u72b6\u6001',
          recommended: '\u63a8\u8350',
          current: '\u5f53\u524d',
          restoring: '\u6b63\u5728\u6062\u590d...',
          updatedAt: '\u66f4\u65b0\u65f6\u95f4',
        }
      : {
          eyebrow: 'State Recovery',
          title: 'Saved state needs attention before startup',
          description: 'Startup found a corrupted state.wal or a newer temp state file. Pick which version to open instead of continuing silently.',
          issuesTitle: 'Detected issues',
          optionsTitle: 'Choose a state to open',
          recommended: 'Recommended',
          current: 'Current',
          restoring: 'Restoring...',
          updatedAt: 'Updated',
        }

  const recentCrashCopy =
    appState.settings.language === 'zh-CN'
      ? {
          eyebrow: 'State Recovery',
          title: '\u4e0a\u6b21\u767d\u5c4f\u524d\u7684\u6700\u8fd1\u4f1a\u8bdd\u5df2\u4fdd\u7559',
          description: (count: number) =>
            `\u5df2\u81ea\u52a8\u5f52\u6863 ${count} \u4e2a\u6700\u8fd1\u4f1a\u8bdd\uff0c\u53ef\u4ee5\u73b0\u5728\u6062\u590d\uff1b\u5982\u679c\u9009\u62e9\u6c38\u4e45\u653e\u5f03\uff0c\u8fd9\u6b21\u5d29\u6e83\u5f52\u6863\u4f1a\u88ab\u5220\u9664\uff0c\u4e0d\u4f1a\u518d\u5f39\u7a97\u3002`,
          detailsTitle: '\u672c\u6b21\u5d29\u6e83\u8bb0\u5f55',
          restore: '\u4e00\u952e\u6062\u590d\u6700\u8fd1\u4f1a\u8bdd',
          dismiss: '\u6c38\u4e45\u653e\u5f03',
          crashedAt: '\u5d29\u6e83\u65f6\u95f4',
          errorSummary: '\u5d29\u6e83\u6458\u8981',
          pending: '\u6b63\u5728\u5904\u7406...',
        }
      : {
          eyebrow: 'State Recovery',
          title: 'Recent sessions were preserved before the last renderer crash',
          description: (count: number) =>
            `${count} recent sessions were archived automatically. Restore them now, or permanently discard this crash archive so it will not prompt again.`,
          detailsTitle: 'This crash archive',
          restore: 'Restore recent sessions',
          dismiss: 'Permanently discard',
          crashedAt: 'Crashed at',
          errorSummary: 'Crash summary',
          pending: 'Working...',
        }

  const interruptedSessionCopy =
    appState.settings.language === 'zh-CN'
      ? {
          title: '上次退出前还有运行中的会话',
          description: (count: number, recoverableCount: number) =>
            recoverableCount === count
              ? `${count} 个会话在退出前仍在运行。现在可以继续它们，也可以先回到普通可编辑状态。`
              : `${count} 个会话在退出前仍在运行，其中 ${recoverableCount} 个可以直接继续，其余会回到普通可编辑状态。`,
          continue: '继续这些会话',
          dismiss: '先不继续',
          pending: '正在处理...',
        }
      : {
          title: 'Some sessions were still running when the app last closed',
          description: (count: number, recoverableCount: number) =>
            recoverableCount === count
              ? `${count} sessions were still running when the app closed. You can continue them now or return them to an editable idle state.`
              : `${count} sessions were still running when the app closed. ${recoverableCount} can continue directly, and the rest will return to an editable idle state.`,
          continue: 'Continue sessions',
          dismiss: 'Not now',
          pending: 'Working...',
        }

  if (loadStatus === 'loading') {
    return renderWithPrimer(
      <div className="loading-shell">
        <div className="loading-card">
          <div className="eyebrow">{text.loadingEyebrow}</div>
          <h1>{text.loadingTitle}</h1>
          <p>{text.loadingDescription}</p>
        </div>
      </div>,
    )
  }

  if (loadStatus === 'error') {
    const loadErrorCopy = resolveAppLoadError(appState.settings.language, loadError)

    return renderWithPrimer(
      <div className="loading-shell">
        <div className="loading-card">
          <div className="eyebrow">{text.loadingEyebrow}</div>
          <h1>{loadErrorCopy.title}</h1>
          <p>{loadErrorCopy.description}</p>
          <div className="loading-actions">
            <AppButton tone="primary" type="button" onClick={() => void hydrateRef.current?.()}>
              {text.retry}
            </AppButton>
            <AppButton type="button" onClick={() => void handleReset()}>
              {text.reset}
            </AppButton>
          </div>
        </div>
      </div>,
    )
  }

  if (startupRecovery) {
    return renderWithPrimer(
      <div className="loading-shell">
        <section
          className="structured-preview-dialog state-recovery-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="state-recovery-title"
        >
          <div className="structured-preview-card state-recovery-card">
            <div className="structured-preview-header">
              <div className="structured-preview-copy">
                <div className="eyebrow">{startupRecoveryCopy.eyebrow}</div>
                <h3 id="state-recovery-title">{startupRecoveryCopy.title}</h3>
                <p className="settings-note">{startupRecoveryCopy.description}</p>
              </div>
            </div>

            <div className="structured-preview-body state-recovery-body">
              <div className="state-recovery-section">
                <div className="settings-section-title">{startupRecoveryCopy.issuesTitle}</div>
                <div className="state-recovery-issue-list">
                  {startupRecovery.issues.map((issue) => (
                    <div key={`${issue.kind}-${issue.fileName}`} className="state-recovery-issue">
                      <strong>{getStateRecoveryIssueLabel(appState.settings.language, issue)}</strong>
                      <div className="state-recovery-issue-meta">
                        <span>{issue.fileName}</span>
                        {issue.updatedAt ? (
                          <span>
                            {startupRecoveryCopy.updatedAt}:{' '}
                            {formatLocalizedDateTime(appState.settings.language, issue.updatedAt)}
                          </span>
                        ) : null}
                      </div>
                      {issue.details.trim() ? <p>{issue.details}</p> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="state-recovery-section">
                <div className="settings-section-title">{startupRecoveryCopy.optionsTitle}</div>
                <div className="state-recovery-option-list">
                  {startupRecovery.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`state-recovery-option${
                        option.recommended ? ' is-recommended' : ''
                      }${option.id === startupRecovery.currentOptionId ? ' is-current' : ''}`}
                      disabled={stateRecoveryPending}
                      onClick={() => void handleResolveStartupRecovery(option.id)}
                    >
                      <div className="state-recovery-option-head">
                        <strong>{getStateRecoveryOptionLabel(appState.settings.language, option)}</strong>
                        {option.recommended ? (
                          <span className="state-recovery-chip">{startupRecoveryCopy.recommended}</span>
                        ) : null}
                        {option.id === startupRecovery.currentOptionId ? (
                          <span className="state-recovery-chip is-muted">{startupRecoveryCopy.current}</span>
                        ) : null}
                      </div>
                      <div className="state-recovery-option-meta">
                        <span>{option.fileName}</span>
                        {option.updatedAt ? (
                          <span>
                            {startupRecoveryCopy.updatedAt}:{' '}
                            {formatLocalizedDateTime(appState.settings.language, option.updatedAt)}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {stateRecoveryError ? (
                <div className="panel-alert" role="alert">
                  {stateRecoveryError}
                </div>
              ) : null}

              {stateRecoveryPending ? (
                <div className="state-recovery-pending" role="status">
                  {startupRecoveryCopy.restoring}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      </div>,
    )
  }

  const settingsGroupNodes: ReactNode[] = [
    <div key="update" className="settings-group">
      <h3 className="settings-group-title">{text.settingsGroupUpdate}</h3>
      <div className="settings-section">
        {appVersion ? (
          <p className="settings-note">{text.updateCurrentVersion(appVersion)}</p>
        ) : null}

        {updateStatus === 'checking' ? (
          <div className="update-banner is-checking" role="status">
            <span>{text.updateChecking}</span>
          </div>
        ) : null}

        {updateStatus === 'downloading' ? (
          <div className="update-banner is-downloading" role="status">
            <span>
              {updateResult?.latestVersion
                ? `${text.updateAvailable(updateResult!.latestVersion!)} — ${text.updateDownloading(downloadProgress)}`
                : text.updateDownloading(downloadProgress)}
            </span>
            <div className="update-progress-bar">
              <div
                className="update-progress-fill"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        ) : null}

        {updateStatus === 'ready' && updateResult?.latestVersion ? (
          <div className="update-banner is-ready" role="status">
            <span>{text.updateReady(updateResult!.latestVersion!)}</span>
            <AppButton tone="primary" type="button" onClick={handleInstallUpdate}>
              {text.updateInstallNow}
            </AppButton>
          </div>
        ) : null}

        {updateStatus === 'no-update' ? (
          <div className="update-banner is-current" role="status">
            <span>{text.updateNoUpdate}</span>
          </div>
        ) : null}

        {updateStatus === 'error' ? (
          <div className="update-banner is-error" role="alert">
            <span>{updateResult?.error ?? text.updateError}</span>
          </div>
        ) : null}

        <div className="settings-actions">
          <AppButton
            type="button"
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
            onClick={handleCheckForUpdate}
          >
            {text.updateCheckNow}
          </AppButton>
        </div>
      </div>
    </div>,

    <div key="codex-safety" className="settings-group codex-safety-settings-group">
      <h3 className="settings-group-title">{text.settingsGroupCodexSafety}</h3>
      <div className="settings-section">
        {renderCodexSafetySettings('modal')}
      </div>
    </div>,

    <div key="appearance" className="settings-group">
      <h3 className="settings-group-title">{text.settingsGroupAppearance}</h3>

      <div className="settings-section">
        <label className="settings-field" htmlFor="language-select">
          <span>{text.language}</span>
          <select
            id="language-select"
            className="control settings-input"
            value={appState.settings.language}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { language: event.target.value as AppState['settings']['language'] },
              })
            }
          >
            {onboardingLanguages.map((language) => (
              <option key={language.value} value={language.value}>
                {`${language.flag} ${language.label}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{text.theme}</div>
        {renderThemeToggle()}
      </div>

      {renderFontFamilySettings('font-family-select')}

      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-copy">
            <label htmlFor="ui-scale-range">{text.uiScale}</label>
            <span>{Math.round(appState.settings.uiScale * 100)}%</span>
          </div>
          <input
            id="ui-scale-range"
            className="settings-range"
            type="range"
            min={minUiScale}
            max={maxUiScale}
            step={0.05}
            value={appState.settings.uiScale}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { uiScale: Number(event.target.value) },
              })
            }
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-copy">
            <label htmlFor="font-scale-range">{text.fontScale}</label>
            <span>{Math.round(appState.settings.fontScale * 100)}%</span>
          </div>
          <input
            id="font-scale-range"
            className="settings-range"
            type="range"
            min={minFontScale}
            max={maxFontScale}
            step={0.05}
            value={appState.settings.fontScale}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { fontScale: Number(event.target.value) },
              })
            }
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-copy">
            <label htmlFor="line-height-range">{text.lineHeight}</label>
            <span>{appState.settings.lineHeightScale.toFixed(2)}x</span>
          </div>
          <input
            id="line-height-range"
            className="settings-range"
            type="range"
            min={minLineHeightScale}
            max={maxLineHeightScale}
            step={0.05}
            value={appState.settings.lineHeightScale}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { lineHeightScale: Number(event.target.value) },
              })
            }
          />
        </div>
      </div>

      <div className="settings-actions">
        <AppButton
          type="button"
          onClick={() =>
            applyAction({
              type: 'updateSettings',
              patch: {
                uiScale: 1,
                fontFamily: 'default',
                fontScale: 1,
                lineHeightScale: 1,
                theme: 'light',
                customThemeBase: 'dark',
                customBaseColor: null,
                accentColor: null,
              },
            })
          }
        >
          {text.resetInterfaceDefaults}
        </AppButton>
      </div>
    </div>,

    <div key="editor" className="settings-group">
      <h3 className="settings-group-title">{text.settingsGroupEditor}</h3>

      <div className="settings-section">
        <div className="settings-row">
          <div className="settings-row-copy">
            <label htmlFor="editor-font-size-range">{text.editorFontSizeLabel}</label>
            <span>{appState.settings.editor.fontSize}px</span>
          </div>
          <input
            id="editor-font-size-range"
            className="settings-range"
            type="range"
            min={10}
            max={24}
            step={1}
            value={appState.settings.editor.fontSize}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: {
                  editor: { ...appState.settings.editor, fontSize: Number(event.target.value) },
                },
              })
            }
          />
        </div>

        <div className="settings-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={appState.settings.editor.wordWrap}
              onChange={(event) =>
                applyAction({
                  type: 'updateSettings',
                  patch: {
                    editor: { ...appState.settings.editor, wordWrap: event.target.checked },
                  },
                })
              }
            />
            <span>{text.editorWordWrapLabel}</span>
          </label>
        </div>

        <div className="settings-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={appState.settings.editor.minimap}
              onChange={(event) =>
                applyAction({
                  type: 'updateSettings',
                  patch: {
                    editor: { ...appState.settings.editor, minimap: event.target.checked },
                  },
                })
              }
            />
            <span>{text.editorMinimapLabel}</span>
          </label>
        </div>

        <div className="settings-row">
          <div className="settings-row-copy">
            <label htmlFor="editor-tab-size-select">{text.editorTabSizeLabel}</label>
          </div>
          <select
            id="editor-tab-size-select"
            className="control settings-input"
            value={appState.settings.editor.tabSize}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: {
                  editor: {
                    ...appState.settings.editor,
                    tabSize: Number(event.target.value) === 4 ? 4 : 2,
                  },
                },
              })
            }
          >
            <option value={2}>2</option>
            <option value={4}>4</option>
          </select>
        </div>
      </div>
    </div>,

    <div key="models" className="settings-group">
      <h3 className="settings-group-title">{text.settingsGroupModels}</h3>

      <div className="settings-section">
        <p className="settings-note">{text.defaultRequestModelsNote}</p>

        <label className="settings-field" htmlFor="codex-model-input">
          <span className="settings-field-label">
            <ModelIcon className="settings-field-icon" aria-hidden="true" />
            <span className="settings-field-label-text">Codex</span>
          </span>
          <input
            id="codex-model-input"
            className="control settings-input"
            value={appState.settings.requestModels.codex}
            onChange={(event) =>
              applyAction({
                type: 'updateRequestModels',
                patch: { codex: event.target.value },
              })
            }
            placeholder={DEFAULT_CODEX_MODEL}
          />
        </label>

        <label className="settings-field">
          <span className="settings-field-label">
            <ModelIcon className="settings-field-icon" aria-hidden="true" />
            <span className="settings-field-label-text">{text.codexPersonalityLabel}</span>
          </span>
          <select
            className="control settings-input"
            value={appState.settings.codexPersonality}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: {
                  codexPersonality: event.target.value as AppState['settings']['codexPersonality'],
                },
              })
            }
          >
            <option value="default">{text.codexPersonalityDefault}</option>
            <option value="none">{text.codexPersonalityNone}</option>
            <option value="friendly">{text.codexPersonalityFriendly}</option>
            <option value="pragmatic">{text.codexPersonalityPragmatic}</option>
          </select>
        </label>
        <p className="settings-note">{text.codexPersonalityNote}</p>

        <label className="settings-toggle">
          <span>{text.codexFastModeLabel}</span>
          <input
            type="checkbox"
            checked={appState.settings.codexFastMode}
            onChange={(event) => handleCodexFastModeToggle(event.target.checked)}
          />
        </label>
        <p className="settings-note">{text.codexFastModeNote}</p>

        <label className="settings-field" htmlFor="claude-model-input">
          <span className="settings-field-label">
            <ModelIcon className="settings-field-icon" aria-hidden="true" />
            <span className="settings-field-label-text">Claude</span>
          </span>
          <input
            id="claude-model-input"
            className="control settings-input"
            value={appState.settings.requestModels.claude}
            onChange={(event) =>
              applyAction({
                type: 'updateRequestModels',
                patch: { claude: event.target.value },
              })
            }
            placeholder={DEFAULT_CLAUDE_MODEL}
          />
        </label>

        <label className="settings-field" htmlFor="git-agent-model-input">
          <span className="settings-field-label">
            <ModelIcon className="settings-field-icon" aria-hidden="true" />
            <span className="settings-field-label-text">{text.gitAgentModel}</span>
          </span>
          <input
            id="git-agent-model-input"
            className="control settings-input"
            value={appState.settings.gitAgentModel}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { gitAgentModel: event.target.value },
              })
            }
            placeholder="gpt-5.6-terra medium"
          />
        </label>

        <p className="settings-note">{text.gitAgentModelNote}</p>

        <label className="settings-field" htmlFor="system-prompt-input">
          <span className="settings-field-label">
            <ModelIcon className="settings-field-icon" aria-hidden="true" />
            <span className="settings-field-label-text">{text.systemPromptLabel}</span>
          </span>
          <textarea
            id="system-prompt-input"
            className="control settings-input"
            rows={4}
            value={appState.settings.systemPrompt}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { systemPrompt: event.target.value },
              })
            }
          />
        </label>

        <p className="settings-note">{text.systemPromptNote}</p>

        <div className="settings-field model-prompt-rules-summary-row">
          <span className="settings-field-label">
            <ModelIcon className="settings-field-icon" aria-hidden="true" />
            <span className="settings-field-label-text">
              {appState.settings.language === 'zh-CN' ? '基于模型的提示词' : 'Model prompt rules'}
            </span>
          </span>
          <div className="model-prompt-rules-summary">
            <strong>{modelPromptRulesSummary}</strong>
            <span className="settings-note">
              {appState.settings.language === 'zh-CN'
                ? '按模型关键字做包含匹配。命中后，会把规则提示词追加到系统提示词后面。'
                : 'Rules match by model keyword substring. Matching prompts are appended after the base system prompt.'}
            </span>
          </div>
        </div>

        <div className="settings-actions">
          <AppButton type="button" onClick={openModelPromptRulesDialog}>
            {appState.settings.language === 'zh-CN' ? '编辑规则' : 'Edit rules'}
          </AppButton>
        </div>

        <label className="settings-toggle" htmlFor="cross-provider-skill-reuse-toggle">
          <span>{text.crossProviderSkillReuseLabel}</span>
          <input
            id="cross-provider-skill-reuse-toggle"
            type="checkbox"
            checked={appState.settings.crossProviderSkillReuseEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { crossProviderSkillReuseEnabled: event.target.checked },
              })
            }
          />
        </label>

        <p className="settings-note">{text.crossProviderSkillReuseNote}</p>

        <div className="settings-actions">
          <AppButton
            type="button"
            onClick={() =>
              applyAction({
                type: 'updateSettings',
                patch: { systemPrompt: defaultSystemPrompt },
              })
            }
          >
            {text.restoreDefaultSystemPrompt}
          </AppButton>
          <AppButton
            tone="primary"
            type="button"
            onClick={() => applyAction({ type: 'applyConfiguredModels' })}
          >
            {text.applyToExistingChats}
          </AppButton>
        </div>
      </div>
    </div>,

    <div key="utility" className="settings-group">
      <h3 className="settings-group-title">{text.settingsGroupUtility}</h3>

      <div className="settings-section">
        <label className="settings-toggle" htmlFor="agent-done-sound-toggle">
          <span>{text.agentDoneSoundLabel}</span>
          <input
            id="agent-done-sound-toggle"
            type="checkbox"
            checked={appState.settings.agentDoneSoundEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { agentDoneSoundEnabled: event.target.checked },
              })
            }
          />
        </label>

        {appState.settings.agentDoneSoundEnabled && (
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="agent-done-sound-volume">{text.agentDoneSoundVolumeLabel}</label>
              <span>{Math.round(appState.settings.agentDoneSoundVolume * 100)}%</span>
            </div>
            <input
              id="agent-done-sound-volume"
              className="settings-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={appState.settings.agentDoneSoundVolume}
              onChange={(event) =>
                applyAction({
                  type: 'updateSettings',
                  patch: { agentDoneSoundVolume: Number(event.target.value) },
                })
              }
              onMouseUp={(event) => {
                const audio = new Audio(getAgentDoneSoundUrl())
                audio.volume = Number((event.target as HTMLInputElement).value)
                audio.play().catch(() => {})
              }}
              onTouchEnd={(event) => {
                const audio = new Audio(getAgentDoneSoundUrl())
                audio.volume = Number((event.target as HTMLInputElement).value)
                audio.play().catch(() => {})
              }}
            />
          </div>
        )}

        {renderAutoUrgeSettings()}
      </div>
    </div>,

    <div key="experimental" className="settings-group">
      <h3 className="settings-group-title">{text.settingsGroupExperimental}</h3>

      <div className="settings-section">
        <label className="settings-toggle" htmlFor="git-card-toggle">
          <span>Git</span>
          <input
            id="git-card-toggle"
            type="checkbox"
            checked={appState.settings.gitCardEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { gitCardEnabled: event.target.checked },
              })
            }
          />
        </label>

        <label className="settings-toggle" htmlFor="filetree-card-toggle">
          <span>{text.emptyStateFilesTitle}</span>
          <input
            id="filetree-card-toggle"
            type="checkbox"
            checked={appState.settings.fileTreeCardEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { fileTreeCardEnabled: event.target.checked },
              })
            }
          />
        </label>

        <label className="settings-toggle" htmlFor="stickynote-card-toggle">
          <span>{text.stickyNoteTitle}</span>
          <input
            id="stickynote-card-toggle"
            type="checkbox"
            checked={appState.settings.stickyNoteCardEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { stickyNoteCardEnabled: event.target.checked },
              })
            }
          />
        </label>

        <label className="settings-toggle" htmlFor="experimental-weather-toggle">
          <span>{text.experimentalWeatherLabel}</span>
          <input
            id="experimental-weather-toggle"
            type="checkbox"
            checked={appState.settings.experimentalWeatherEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { experimentalWeatherEnabled: event.target.checked },
              })
            }
          />
        </label>

        {appState.settings.experimentalWeatherEnabled && (
          <div className="settings-sub-field" ref={weatherCityWrapperRef}>
            <div className="weather-city-input-wrapper">
              <input
                id="weather-city-input"
                className="control settings-input"
                value={weatherCityDraft}
                onChange={(e) => handleWeatherCityInput(e.target.value)}
                onKeyDown={handleWeatherCityKeyDown}
                onFocus={() => {
                  if (weatherCitySuggestions.length > 0) setWeatherCitySuggestionsOpen(true)
                }}
                placeholder={text.weatherCityPlaceholder}
                autoComplete="off"
              />
              {weatherCitySuggestionsOpen && weatherCitySuggestions.length > 0 && (
                <div className="weather-city-suggestions">
                  {weatherCitySuggestions.map((s, i) => (
                    <button
                      key={`${s.latitude}-${s.longitude}`}
                      type="button"
                      className={`weather-city-suggestion${i === weatherCitySelectedIndex ? ' is-selected' : ''}`}
                      onMouseDown={() => handleWeatherCitySelect(s)}
                      onMouseEnter={() => setWeatherCitySelectedIndex(i)}
                    >
                      <span className="weather-city-suggestion-name">{s.name}</span>
                      <span className="weather-city-suggestion-detail">
                        {[s.admin1, s.country].filter(Boolean).join(', ')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <label className="settings-toggle" htmlFor="experimental-music-toggle">
          <span>{text.experimentalMusicLabel}</span>
          <input
            id="experimental-music-toggle"
            type="checkbox"
            checked={appState.settings.experimentalMusicEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { experimentalMusicEnabled: event.target.checked },
              })
            }
          />
        </label>

        <label className="settings-toggle" htmlFor="experimental-whitenoise-toggle">
          <span>{text.experimentalWhiteNoiseLabel}</span>
          <input
            id="experimental-whitenoise-toggle"
            type="checkbox"
            checked={appState.settings.experimentalWhiteNoiseEnabled}
            onChange={(event) =>
              applyAction({
                type: 'updateSettings',
                patch: { experimentalWhiteNoiseEnabled: event.target.checked },
              })
            }
          />
        </label>
      </div>
    </div>,
  ]

  if (showSettingsSetupPanel) {
    settingsGroupNodes.push(
      <div key="environment" className="settings-group">
        <h3 className="settings-group-title">{text.settingsGroupEnvironment}</h3>

        <div className="settings-section">
          <p className="settings-note">{panelText.setupDescription}</p>

          {hasMissingEnvironmentChecks ? (
            <div className="setup-missing-shell">
              <div className="settings-section-title">{panelText.setupMissingListTitle}</div>
              <p className="settings-note">{panelText.setupMissingListDescription}</p>
              <ul className="setup-missing-list">
                {missingEnvironmentChecks.map((check) => (
                  <li key={check.id}>{check.label}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {settingsNotice ? (
            <div className="panel-alert" role="alert">
              {settingsNotice}
            </div>
          ) : null}

          <div className={`setup-status-card is-${setupStatus?.state ?? 'idle'}`}>
            <strong>{setupHeadline}</strong>
            <p className="settings-note">{setupStatusMessage}</p>
          </div>

          <div className="settings-actions">
            {hasMissingEnvironmentChecks ? (
              <AppButton
                tone="primary"
                type="button"
                disabled={setupStatusPending || setupStatus?.state === 'running'}
                onClick={() => void handleRunSetup()}
              >
                {hasRunSetup ? panelText.rerunSetup : panelText.installMissingTools}
              </AppButton>
            ) : null}
            <AppButton
              type="button"
              disabled={setupStatusPending}
              onClick={() => {
                void loadSetup()
                void syncProviderStatuses()
              }}
            >
              {panelText.refreshSetup}
            </AppButton>
          </div>

          <div className="cli-update-shell">
            <div className="settings-section-title">{panelText.cliUpdateTitle}</div>
            <p className="settings-note">{panelText.cliUpdateDescription}</p>
            <div className="cli-update-grid">
              <label className="settings-field" htmlFor="cli-update-target">
                <span>{panelText.cliUpdateTarget}</span>
                <select
                  id="cli-update-target"
                  className="control settings-input"
                  value={cliUpdateTarget}
                  onChange={(event) =>
                    setCliUpdateTarget(event.target.value as 'all' | 'claude' | 'codex')
                  }
                >
                  <option value="all">{panelText.cliUpdateTargetAll}</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>

              <label className="settings-field" htmlFor="cli-update-version">
                <span>{panelText.cliUpdateVersion}</span>
                <input
                  id="cli-update-version"
                  className="control settings-input"
                  value={cliUpdateVersion}
                  placeholder={panelText.cliUpdateVersionPlaceholder}
                  onChange={(event) => setCliUpdateVersion(event.target.value)}
                />
              </label>
            </div>
            <p className="settings-note">{panelText.cliUpdateVersionNote}</p>
            <div className="settings-actions cli-update-actions">
              <AppButton
                type="button"
                disabled={setupStatusPending || setupStatus?.state === 'running'}
                onClick={() => void handleUpdateCli()}
              >
                {panelText.cliUpdateButton}
              </AppButton>
            </div>
          </div>

          {hasSetupLogs ? (
            <div className="setup-log-shell">
              <div className="settings-section-title">{panelText.setupLogs}</div>
              <div className="setup-log-list">
                {setupLogs.map((entry, index) => (
                  <div key={`${entry.createdAt}-${index}`} className={`setup-log-entry is-${entry.level}`}>
                    {entry.message}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>,
    )
  }

  settingsGroupNodes.push(
    <div key="data" className="settings-group settings-group-danger">
      <h3 className="settings-group-title">{text.settingsGroupData}</h3>

      <div className="settings-section settings-danger-section">
        <p className="settings-note">{text.clearUserDataDialogBody}</p>

        <div className="settings-actions">
          <AppButton
            type="button"
            className="settings-danger-button"
            onClick={openClearUserDataDialog}
          >
            {text.clearUserDataButton}
          </AppButton>
        </div>
      </div>
    </div>,
  )

  const settingsPanelColumnCount =
    typeof window === 'undefined' ? 1 : getStableSettingsPanelColumnCount(window.innerWidth)
  const showLegacySettingsPanel = false
  const settingsColumns = splitSettingsGroupsIntoStableColumns(settingsGroupNodes, settingsPanelColumnCount)

  return renderWithPrimer(
    <div className={`app-shell${isDesktopRuntime ? ` is-desktop-shell${desktopPlatformClass}` : ''}`}>
      <WeatherAmbientOverlay />
      <header className="app-topbar">
        <div className="app-topbar-frame">
          <div className="app-tab-list" role="tablist" aria-label={topTabText.navLabel}>
            {topTabs.map((tab) => {
              const active = activeTab === tab.id

              return (
                <button
                  key={tab.id}
                  id={`app-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`app-panel-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  className={`app-tab${active ? ' is-active' : ''}`}
                  onClick={() => setActiveTopTab(tab.id)}
                >
                  {tab.label}
                </button>
              )
            })}
            <button
              type="button"
              className="app-topbar-add-column"
              title={text.addWorkspace}
              aria-label={text.addWorkspace}
              onClick={() => applyAction({ type: 'addColumn' })}
            >
              <PlusIcon />
            </button>
            {isRemoteMonitorSupported() ? (
              <button
                type="button"
                className={`app-topbar-remote-monitor${remoteMonitorInfo ? ' is-active' : ''}`}
                title={text.remoteMonitorButtonLabel}
                aria-label={text.remoteMonitorButtonLabel}
                onClick={openRemoteMonitorDialog}
              >
                <PhoneMonitorIcon />
              </button>
            ) : null}
          </div>

          {appState.settings.autoUrgeEnabled && appState.settings.autoUrgeGlobalControlEnabled ? (
            <div className="app-topbar-urge">
              <label className="app-topbar-urge-toggle" htmlFor="global-urge-active-toggle">
                <input
                  id="global-urge-active-toggle"
                  type="checkbox"
                  checked={appState.settings.autoUrgeGlobalActive}
                  onChange={(event) =>
                    applyAction({
                      type: 'updateSettings',
                      patch: { autoUrgeGlobalActive: event.target.checked },
                    })
                  }
                />
                <span>{text.autoUrgeGlobalToggleLabel}</span>
              </label>
              <select
                className="app-topbar-urge-type"
                aria-label={text.autoUrgeGlobalTypeAriaLabel}
                value={appState.settings.autoUrgeGlobalProfileId}
                onChange={(event) =>
                  applyAction({
                    type: 'updateSettings',
                    patch: { autoUrgeGlobalProfileId: event.target.value },
                  })
                }
              >
                {appState.settings.autoUrgeProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name.trim() || text.autoUrgeTypeNamePlaceholder}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {usesCustomWindowFrame ? (
            <div className="app-titlebar-controls" aria-label="Window controls">
              <button
                type="button"
                className="window-control-button"
                aria-label="Minimize window"
                onClick={() => void minimizeWindow().catch(() => undefined)}
              >
                <MinimizeWindowIcon />
              </button>
              <button
                type="button"
                className="window-control-button"
                aria-label={windowMaximized ? 'Restore window' : 'Maximize window'}
                onClick={handleToggleWindowMaximize}
              >
                {windowMaximized ? <RestoreWindowIcon /> : <MaximizeWindowIcon />}
              </button>
              <button
                type="button"
                className="window-control-button is-close"
                aria-label="Close window"
                onClick={() => void closeWindow().catch(() => undefined)}
              >
                <CloseIcon />
              </button>
            </div>
          ) : isDesktopRuntime ? (
            <div className="app-titlebar-controls-spacer" aria-hidden="true" />
          ) : null}
        </div>
      </header>

      <div className="app-view-stack">
        {interruptedSessionRecovery ? (
          <section className="state-recovery-banner" role="status" aria-live="polite">
            <div className="state-recovery-banner-copy">
              <strong>{interruptedSessionCopy.title}</strong>
              <p className="state-recovery-banner-summary">
                {interruptedSessionCopy.description(
                  interruptedSessionRecovery.entries.length,
                  interruptedSessionRecovery.entries.filter((entry) => entry.recoverable).length,
                )}
              </p>
              {interruptedSessionActionError ? (
                <div className="panel-alert" role="alert">
                  {interruptedSessionActionError}
                </div>
              ) : null}
            </div>

            <div className="state-recovery-banner-actions">
              <AppButton
                tone="primary"
                type="button"
                disabled={interruptedSessionActionPending}
                onClick={() => void handleResumeInterruptedSessions()}
              >
                {interruptedSessionActionPending ? interruptedSessionCopy.pending : interruptedSessionCopy.continue}
              </AppButton>
              <AppButton
                type="button"
                disabled={interruptedSessionActionPending}
                onClick={() => void handleDismissInterruptedSessions()}
              >
                {interruptedSessionCopy.dismiss}
              </AppButton>
            </div>
          </section>
        ) : null}

        <section
          id="app-panel-routing"
          className="app-panel-shell"
          role="tabpanel"
          aria-labelledby="app-tab-routing"
          hidden={!routingOpen}
        >
          <section className="settings-panel switch-panel">
            <h2 className="visually-hidden">{panelText.switchTitle}</h2>
            <div className="routing-sub-tabs">
              <button
                type="button"
                className={`routing-sub-tab${routingSubTab === 'providers' ? ' is-active' : ''}`}
                onClick={() => setRoutingSubTab('providers')}
              >
                {resilientProxyText.tabProviders}
              </button>
              <button
                type="button"
                className={`routing-sub-tab${routingSubTab === 'proxy' ? ' is-active' : ''}`}
                onClick={() => setRoutingSubTab('proxy')}
              >
                {resilientProxyText.tabProxy}
              </button>
            </div>

            {routingSubTab === 'providers' ? (
              <div className="routing-panel-columns">
                <div className="settings-group routing-group routing-group-overview">
                  <h3 className="settings-group-title">{panelText.switchTitle}</h3>

                  <div className="settings-section">
                    <div className="settings-toggle-row">
                      <div>
                        <label>{resilientProxyText.cliRoutingEnabled}</label>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={appState.settings.cliRoutingEnabled}
                          onChange={(event) =>
                            applyAction({
                              type: 'updateSettings',
                              patch: { cliRoutingEnabled: event.target.checked },
                            })
                          }
                        />
                        <span className="toggle-switch-track" />
                        <span className="toggle-switch-knob" />
                      </label>
                    </div>
                  </div>

                  {switchNotice ? (
                    <div className="panel-alert" role="alert">
                      {switchNotice}
                    </div>
                  ) : null}

                  <div className="settings-section">
                    <p className="settings-note">{panelText.switchDescription}</p>
                    <p className="settings-note">{panelText.switchStorageNote}</p>
                  </div>

                  <div className="settings-section">
                    <div className="settings-section-title">{panelText.importTitle}</div>
                    <p className="settings-note">{panelText.importDescription}</p>
                    <p className="settings-note">{panelText.importSupportedFiles}</p>

                    <div className="routing-import-card">
                      <div className="settings-actions routing-import-actions">
                        <AppButton
                          tone="primary"
                          type="button"
                          disabled={routingImportPending}
                          onClick={() => {
                            void runCcSwitchImport({ mode: 'default' }).catch(() => undefined)
                          }}
                        >
                          {panelText.importDefault}
                        </AppButton>
                        <AppButton
                          type="button"
                          disabled={routingImportPending}
                          onClick={openCcSwitchImportPicker}
                        >
                          {panelText.importChooseFile}
                        </AppButton>
                      </div>

                      {routingImportPending ? (
                        <p className="settings-note routing-import-note">{panelText.importPending}</p>
                      ) : null}
                    </div>

                    <input
                      ref={routingImportInputRef}
                      hidden
                      type="file"
                      accept=".db,.sql,application/octet-stream,text/plain"
                      onChange={(event) => void handleCcSwitchFileImport(event)}
                    />
                  </div>
                </div>

                {(['claude', 'codex'] as const).map((provider) => {
                  const collection = appState.settings.providerProfiles[provider]
                  const providerLabel = getProviderLabel(appState.settings.language, provider)
                  const draft = profileDrafts[provider]

                  return (
                    <div
                      key={provider}
                      className="settings-group routing-group switch-provider-group switch-provider-section"
                    >
                      <h3 className="settings-group-title">{providerLabel}</h3>

                      <div className="settings-section switch-provider-group-body">
                        {collection.profiles.length === 0 ? (
                          <div className="provider-profile-empty">
                            <strong>{panelText.noProfiles}</strong>
                            <span>{panelText.noProfilesDescription}</span>
                          </div>
                        ) : null}

                        {collection.profiles.map((profile) => {
                          const active = collection.activeProfileId === profile.id

                          return (
                            <div
                              key={profile.id}
                              className={`provider-profile-card${active ? ' is-active' : ''}`}
                            >
                              <label className="settings-field">
                                <span>{panelText.profileName}</span>
                                <input
                                  className="control settings-input"
                                  value={profile.name}
                                  onChange={(event) =>
                                    updateProviderProfile(provider, profile.id, { name: event.target.value })
                                  }
                                />
                              </label>

                              <div className="settings-field">
                                <span>{panelText.apiKey}</span>
                                <div className="api-key-field">
                                  <input
                                    className="control settings-input"
                                    type={visibleApiKeys.has(profile.id) ? 'text' : 'password'}
                                    value={profile.apiKey}
                                    onChange={(event) =>
                                      updateProviderProfile(provider, profile.id, { apiKey: event.target.value })
                                    }
                                  />
                                  <button
                                    type="button"
                                    className="api-key-eye"
                                    onClick={() => setVisibleApiKeys((prev) => {
                                      const next = new Set(prev)
                                      if (next.has(profile.id)) next.delete(profile.id)
                                      else next.add(profile.id)
                                      return next
                                    })}
                                  >
                                    {visibleApiKeys.has(profile.id) ? <EyeOffIcon /> : <EyeIcon />}
                                  </button>
                                </div>
                              </div>

                              <label className="settings-field">
                                <span>{panelText.baseUrl}</span>
                                <input
                                  className="control settings-input"
                                  value={profile.baseUrl}
                                  placeholder={
                                    provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
                                  }
                                  onChange={(event) =>
                                    updateProviderProfile(provider, profile.id, { baseUrl: event.target.value })
                                  }
                                />
                              </label>

                              <p className="settings-note">{panelText.baseUrlNote}</p>

                              <div className="settings-actions provider-profile-actions">
                                <AppButton
                                  tone={active ? 'primary' : 'ghost'}
                                  type="button"
                                  onClick={() => {
                                    applyAction({
                                      type: 'setActiveProviderProfile',
                                      provider,
                                      profileId: profile.id,
                                    })
                                    setSwitchNotice(null)
                                  }}
                                >
                                  {active ? panelText.activeProfile : panelText.activateProfile}
                                </AppButton>
                                <AppButton
                                  type="button"
                                  onClick={() =>
                                    applyAction({
                                      type: 'removeProviderProfile',
                                      provider,
                                      profileId: profile.id,
                                    })
                                  }
                                >
                                  {panelText.removeProfile}
                                </AppButton>
                              </div>
                            </div>
                          )
                        })}

                        <div className="provider-profile-card is-draft">
                          <label className="settings-field">
                            <span>{panelText.profileName}</span>
                            <input
                              className="control settings-input"
                              value={draft.name}
                              onChange={(event) => updateDraft(provider, { name: event.target.value })}
                            />
                          </label>

                          <div className="settings-field">
                            <span>{panelText.apiKey}</span>
                            <div className="api-key-field">
                              <input
                                className="control settings-input"
                                type={visibleApiKeys.has(`draft-${provider}`) ? 'text' : 'password'}
                                value={draft.apiKey}
                                onChange={(event) => updateDraft(provider, { apiKey: event.target.value })}
                              />
                              <button
                                type="button"
                                className="api-key-eye"
                                onClick={() => setVisibleApiKeys((prev) => {
                                  const next = new Set(prev)
                                  const key = `draft-${provider}`
                                  if (next.has(key)) next.delete(key)
                                  else next.add(key)
                                  return next
                                })}
                              >
                                {visibleApiKeys.has(`draft-${provider}`) ? <EyeOffIcon /> : <EyeIcon />}
                              </button>
                            </div>
                          </div>

                          <label className="settings-field">
                            <span>{panelText.baseUrl}</span>
                            <input
                              className="control settings-input"
                              value={draft.baseUrl}
                              placeholder={
                                provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
                              }
                              onChange={(event) => updateDraft(provider, { baseUrl: event.target.value })}
                            />
                          </label>

                          <p className="settings-note">{panelText.baseUrlNote}</p>

                          <div className="settings-actions provider-profile-actions">
                            <AppButton
                              tone="primary"
                              type="button"
                              disabled={!draft.apiKey.trim()}
                              onClick={() => addProviderProfile(provider)}
                            >
                              {panelText.addProfile}
                            </AppButton>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="routing-panel-columns">
                <div className="settings-group routing-group routing-group-overview">
                  <h3 className="settings-group-title">{resilientProxyText.tabProxy}</h3>

                  <div className="settings-section">
                    <p className="settings-note">{resilientProxyText.description}</p>
                    <p className="settings-note">{resilientProxyText.footnote}</p>
                  </div>

                  <div className="settings-section">
                    <div className="settings-toggle-row">
                      <label>{resilientProxyText.status}</label>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={appState.settings.resilientProxyEnabled}
                          onChange={(event) =>
                            applyAction({
                              type: 'updateSettings',
                              patch: { resilientProxyEnabled: event.target.checked },
                            })
                          }
                        />
                        <span className="toggle-switch-track" />
                        <span className="toggle-switch-knob" />
                      </label>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-row">
                      <div className="settings-row-copy">
                        <label htmlFor="proxy-stall-timeout">{resilientProxyText.stallTimeout}</label>
                        <span>{appState.settings.resilientProxyStallTimeoutSec}s</span>
                      </div>
                      <input
                        id="proxy-stall-timeout"
                        className="settings-range"
                        type="range"
                        min={10}
                        max={300}
                        step={5}
                        value={appState.settings.resilientProxyStallTimeoutSec}
                        onChange={(event) =>
                          applyAction({
                            type: 'updateSettings',
                            patch: { resilientProxyStallTimeoutSec: Number(event.target.value) },
                          })
                        }
                      />
                      <p className="settings-note">{resilientProxyText.stallTimeoutNote}</p>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-copy">
                        <label htmlFor="proxy-first-byte-timeout">{resilientProxyText.firstByteTimeout}</label>
                        <span>{appState.settings.resilientProxyFirstByteTimeoutSec}s</span>
                      </div>
                      <input
                        id="proxy-first-byte-timeout"
                        className="settings-range"
                        type="range"
                        min={30}
                        max={600}
                        step={10}
                        value={appState.settings.resilientProxyFirstByteTimeoutSec}
                        onChange={(event) =>
                          applyAction({
                            type: 'updateSettings',
                            patch: { resilientProxyFirstByteTimeoutSec: Number(event.target.value) },
                          })
                        }
                      />
                      <p className="settings-note">{resilientProxyText.firstByteTimeoutNote}</p>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-copy">
                        <label htmlFor="proxy-max-retries">{resilientProxyText.maxRetries}</label>
                        <span>
                          {appState.settings.resilientProxyMaxRetries === -1
                            ? resilientProxyText.unlimited
                            : appState.settings.resilientProxyMaxRetries}
                        </span>
                      </div>
                      <input
                        id="proxy-max-retries"
                        className="settings-range"
                        type="range"
                        min={-1}
                        max={50}
                        step={1}
                        value={appState.settings.resilientProxyMaxRetries}
                        onChange={(event) =>
                          applyAction({
                            type: 'updateSettings',
                            patch: { resilientProxyMaxRetries: Number(event.target.value) },
                          })
                        }
                      />
                      <p className="settings-note">{resilientProxyText.maxRetriesNote}</p>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-section-title">{resilientProxyText.featureTitle}</div>
                    <ul className="proxy-feature-list">
                      {resilientProxyText.features.map((feature, i) => (
                        <li key={i} className="settings-note">{feature}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="settings-group routing-group">
                  <h3 className="settings-group-title">{resilientProxyText.statsTitle}</h3>

                  <div className="settings-section">
                    <div className="proxy-stats-filter" role="group" aria-label={resilientProxyText.statsTimeFilter}>
                      {(['all', 'session', '1h', '24h'] as const).map((range) => (
                        <button
                          key={range}
                          type="button"
                          className={`theme-chip${proxyStatsRange === range ? ' is-active' : ''}`}
                          onClick={() => setProxyStatsRange(range)}
                        >
                          {range === 'all' ? resilientProxyText.statsAll
                            : range === 'session' ? resilientProxyText.statsCurrentSession
                            : range === '1h' ? resilientProxyText.statsLast1h
                            : resilientProxyText.statsLast24h}
                        </button>
                      ))}
                    </div>

                    <div className="proxy-stats-grid">
                      <div className="proxy-stat-card">
                        <span className="proxy-stat-value">{displayedProxyStats.requests}</span>
                        <span className="proxy-stat-label">{resilientProxyText.statsRequests}</span>
                      </div>
                      <div className="proxy-stat-card">
                        <span className="proxy-stat-value">{displayedProxyStats.disconnects}</span>
                        <span className="proxy-stat-label">{resilientProxyText.statsDisconnects}</span>
                      </div>
                      <div className="proxy-stat-card">
                        <span className="proxy-stat-value">{displayedProxyStats.recoverySuccesses}</span>
                        <span className="proxy-stat-label">{resilientProxyText.statsRecoveries}</span>
                      </div>
                      <div className="proxy-stat-card">
                        <span className="proxy-stat-value">{displayedProxyStats.recoveryFailures}</span>
                        <span className="proxy-stat-label">{resilientProxyText.statsFailures}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </section>

        <section
          id="app-panel-settings"
          className="app-panel-shell"
          role="tabpanel"
          aria-labelledby="app-tab-settings"
          hidden={!settingsOpen}
        >
          <section className="settings-panel">
            <h2 className="visually-hidden">{text.settingsPanelHeading}</h2>
            <div className={`settings-panel-columns is-columns-${settingsColumns.length}`}>
              {settingsColumns.map((columnGroups, index) => (
                <div key={`settings-column-${index}`} className="settings-panel-column">
                  {columnGroups}
                </div>
              ))}
            </div>
            {showLegacySettingsPanel && (
              <>

            <div className="settings-group">
              <h3 className="settings-group-title">{text.settingsGroupUpdate}</h3>
              <div className="settings-section">
                {appVersion ? (
                  <p className="settings-note">{text.updateCurrentVersion(appVersion)}</p>
                ) : null}

                {updateStatus === 'checking' ? (
                  <div className="update-banner is-checking" role="status">
                    <span>{text.updateChecking}</span>
                  </div>
                ) : null}

                {updateStatus === 'downloading' ? (
                  <div className="update-banner is-downloading" role="status">
                    <span>
                      {updateResult?.latestVersion
                        ? `${text.updateAvailable(updateResult!.latestVersion!)} — ${text.updateDownloading(downloadProgress)}`
                        : text.updateDownloading(downloadProgress)}
                    </span>
                    <div className="update-progress-bar">
                      <div
                        className="update-progress-fill"
                        style={{ width: `${downloadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {updateStatus === 'ready' && updateResult?.latestVersion ? (
                  <div className="update-banner is-ready" role="status">
                    <span>{text.updateReady(updateResult!.latestVersion!)}</span>
                    <AppButton tone="primary" type="button" onClick={handleInstallUpdate}>
                      {text.updateInstallNow}
                    </AppButton>
                  </div>
                ) : null}

                {updateStatus === 'no-update' ? (
                  <div className="update-banner is-current" role="status">
                    <span>{text.updateNoUpdate}</span>
                  </div>
                ) : null}

                {updateStatus === 'error' ? (
                  <div className="update-banner is-error" role="alert">
                    <span>{updateResult?.error ?? text.updateError}</span>
                  </div>
                ) : null}

                <div className="settings-actions">
                  <AppButton
                    type="button"
                    disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                    onClick={handleCheckForUpdate}
                  >
                    {text.updateCheckNow}
                  </AppButton>
                </div>
              </div>
            </div>

            <div className="settings-group codex-safety-settings-group">
              <h3 className="settings-group-title">{text.settingsGroupCodexSafety}</h3>
              <div className="settings-section">
                {renderCodexSafetySettings('inline')}
              </div>
            </div>

            <div className="settings-group">
              <h3 className="settings-group-title">{text.settingsGroupAppearance}</h3>

              <div className="settings-section">
                <label className="settings-field" htmlFor="language-select">
                  <span>{text.language}</span>
                  <select
                    id="language-select"
                    className="control settings-input"
                    value={appState.settings.language}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { language: event.target.value as AppState['settings']['language'] },
                      })
                    }
                  >
                    {onboardingLanguages.map((language) => (
                      <option key={language.value} value={language.value}>
                        {`${language.flag} ${language.label}`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">{text.theme}</div>
                {renderThemeToggle()}
              </div>

              {renderFontFamilySettings('font-family-select-inline')}

              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor="ui-scale-range">{text.uiScale}</label>
                    <span>{Math.round(appState.settings.uiScale * 100)}%</span>
                  </div>
                  <input
                    id="ui-scale-range"
                    className="settings-range"
                    type="range"
                    min={minUiScale}
                    max={maxUiScale}
                    step={0.05}
                    value={appState.settings.uiScale}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { uiScale: Number(event.target.value) },
                      })
                    }
                  />
                </div>

                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor="font-scale-range">{text.fontScale}</label>
                    <span>{Math.round(appState.settings.fontScale * 100)}%</span>
                  </div>
                  <input
                    id="font-scale-range"
                    className="settings-range"
                    type="range"
                    min={minFontScale}
                    max={maxFontScale}
                    step={0.05}
                    value={appState.settings.fontScale}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { fontScale: Number(event.target.value) },
                      })
                    }
                  />
                </div>

                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label htmlFor="line-height-range">{text.lineHeight}</label>
                    <span>{appState.settings.lineHeightScale.toFixed(2)}x</span>
                  </div>
                  <input
                    id="line-height-range"
                    className="settings-range"
                    type="range"
                    min={minLineHeightScale}
                    max={maxLineHeightScale}
                    step={0.05}
                    value={appState.settings.lineHeightScale}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { lineHeightScale: Number(event.target.value) },
                      })
                    }
                  />
                </div>
              </div>

              <div className="settings-actions">
                <AppButton
                  type="button"
                  onClick={() =>
                    applyAction({
                      type: 'updateSettings',
                      patch: {
                        uiScale: 1,
                        fontFamily: 'default',
                        fontScale: 1,
                        lineHeightScale: 1,
                        theme: 'light',
                        customThemeBase: 'dark',
                        customBaseColor: null,
                        accentColor: null,
                      },
                    })
                  }
                >
                  {text.resetInterfaceDefaults}
                </AppButton>
              </div>
            </div>


            <div className="settings-group">
              <h3 className="settings-group-title">{text.settingsGroupModels}</h3>

              <div className="settings-section">
                <p className="settings-note">{text.defaultRequestModelsNote}</p>

                <label className="settings-field" htmlFor="codex-model-input">
                  <span className="settings-field-label">
                    <ModelIcon className="settings-field-icon" aria-hidden="true" />
                    <span className="settings-field-label-text">Codex</span>
                  </span>
                  <input
                    id="codex-model-input"
                    className="control settings-input"
                    value={appState.settings.requestModels.codex}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateRequestModels',
                        patch: { codex: event.target.value },
                      })
                    }
                    placeholder={DEFAULT_CODEX_MODEL}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-field-label">
                    <ModelIcon className="settings-field-icon" aria-hidden="true" />
                    <span className="settings-field-label-text">{text.codexPersonalityLabel}</span>
                  </span>
                  <select
                    className="control settings-input"
                    value={appState.settings.codexPersonality}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: {
                          codexPersonality: event.target.value as AppState['settings']['codexPersonality'],
                        },
                      })
                    }
                  >
                    <option value="default">{text.codexPersonalityDefault}</option>
                    <option value="none">{text.codexPersonalityNone}</option>
                    <option value="friendly">{text.codexPersonalityFriendly}</option>
                    <option value="pragmatic">{text.codexPersonalityPragmatic}</option>
                  </select>
                </label>
                <p className="settings-note">{text.codexPersonalityNote}</p>

                <label className="settings-toggle">
                  <span>{text.codexFastModeLabel}</span>
                  <input
                    type="checkbox"
                    checked={appState.settings.codexFastMode}
                    onChange={(event) => handleCodexFastModeToggle(event.target.checked)}
                  />
                </label>
                <p className="settings-note">{text.codexFastModeNote}</p>

                <label className="settings-field" htmlFor="claude-model-input">
                  <span className="settings-field-label">
                    <ModelIcon className="settings-field-icon" aria-hidden="true" />
                    <span className="settings-field-label-text">Claude</span>
                  </span>
                  <input
                    id="claude-model-input"
                    className="control settings-input"
                    value={appState.settings.requestModels.claude}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateRequestModels',
                        patch: { claude: event.target.value },
                      })
                    }
                    placeholder={DEFAULT_CLAUDE_MODEL}
                  />
                </label>

                <label className="settings-field" htmlFor="git-agent-model-input">
                  <span className="settings-field-label">
                    <ModelIcon className="settings-field-icon" aria-hidden="true" />
                    <span className="settings-field-label-text">{text.gitAgentModel}</span>
                  </span>
                  <input
                    id="git-agent-model-input"
                    className="control settings-input"
                    value={appState.settings.gitAgentModel}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { gitAgentModel: event.target.value },
                      })
                    }
                    placeholder="gpt-5.6-terra medium"
                  />
                </label>

                <p className="settings-note">{text.gitAgentModelNote}</p>

                <label className="settings-field" htmlFor="system-prompt-input">
                  <span className="settings-field-label">
                    <ModelIcon className="settings-field-icon" aria-hidden="true" />
                    <span className="settings-field-label-text">{text.systemPromptLabel}</span>
                  </span>
                  <textarea
                    id="system-prompt-input"
                    className="control settings-input"
                    rows={4}
                    value={appState.settings.systemPrompt}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { systemPrompt: event.target.value },
                      })
                    }
                  />
                </label>

                <p className="settings-note">{text.systemPromptNote}</p>

                <label className="settings-toggle" htmlFor="cross-provider-skill-reuse-toggle">
                  <span>{text.crossProviderSkillReuseLabel}</span>
                  <input
                    id="cross-provider-skill-reuse-toggle"
                    type="checkbox"
                    checked={appState.settings.crossProviderSkillReuseEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { crossProviderSkillReuseEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                <p className="settings-note">{text.crossProviderSkillReuseNote}</p>

                <div className="settings-actions">
                  <AppButton
                    type="button"
                    onClick={() =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { systemPrompt: defaultSystemPrompt },
                      })
                    }
                  >
                    {text.restoreDefaultSystemPrompt}
                  </AppButton>
                  <AppButton
                    tone="primary"
                    type="button"
                    onClick={() => applyAction({ type: 'applyConfiguredModels' })}
                  >
                    {text.applyToExistingChats}
                  </AppButton>
                </div>
              </div>
            </div>

            <div className="settings-group">
              <h3 className="settings-group-title">{text.settingsGroupUtility}</h3>

              <div className="settings-section">
                <label className="settings-toggle" htmlFor="agent-done-sound-toggle">
                  <span>{text.agentDoneSoundLabel}</span>
                  <input
                    id="agent-done-sound-toggle"
                    type="checkbox"
                    checked={appState.settings.agentDoneSoundEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { agentDoneSoundEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                {appState.settings.agentDoneSoundEnabled && (
                  <div className="settings-row">
                    <div className="settings-row-copy">
                      <label htmlFor="agent-done-sound-volume">{text.agentDoneSoundVolumeLabel}</label>
                      <span>{Math.round(appState.settings.agentDoneSoundVolume * 100)}%</span>
                    </div>
                    <input
                      id="agent-done-sound-volume"
                      className="settings-range"
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={appState.settings.agentDoneSoundVolume}
                      onChange={(event) =>
                        applyAction({
                          type: 'updateSettings',
                          patch: { agentDoneSoundVolume: Number(event.target.value) },
                        })
                      }
                      onMouseUp={(event) => {
                        const audio = new Audio(getAgentDoneSoundUrl())
                        audio.volume = Number((event.target as HTMLInputElement).value)
                        audio.play().catch(() => {})
                      }}
                      onTouchEnd={(event) => {
                        const audio = new Audio(getAgentDoneSoundUrl())
                        audio.volume = Number((event.target as HTMLInputElement).value)
                        audio.play().catch(() => {})
                      }}
                    />
                  </div>
                )}

                {renderAutoUrgeSettings()}

              </div>
            </div>

            <div className="settings-group">
              <h3 className="settings-group-title">{text.settingsGroupExperimental}</h3>

              <div className="settings-section">
                <label className="settings-toggle" htmlFor="git-card-toggle">
                  <span>Git</span>
                  <input
                    id="git-card-toggle"
                    type="checkbox"
                    checked={appState.settings.gitCardEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { gitCardEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                <label className="settings-toggle" htmlFor="filetree-card-toggle">
                  <span>{text.emptyStateFilesTitle}</span>
                  <input
                    id="filetree-card-toggle"
                    type="checkbox"
                    checked={appState.settings.fileTreeCardEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { fileTreeCardEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                <label className="settings-toggle" htmlFor="stickynote-card-toggle">
                  <span>{text.stickyNoteTitle}</span>
                  <input
                    id="stickynote-card-toggle"
                    type="checkbox"
                    checked={appState.settings.stickyNoteCardEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { stickyNoteCardEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                <label className="settings-toggle" htmlFor="experimental-weather-toggle">
                  <span>{text.experimentalWeatherLabel}</span>
                  <input
                    id="experimental-weather-toggle"
                    type="checkbox"
                    checked={appState.settings.experimentalWeatherEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { experimentalWeatherEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                {appState.settings.experimentalWeatherEnabled && (
                  <div className="settings-sub-field" ref={weatherCityWrapperRef}>
                    <div className="weather-city-input-wrapper">
                      <input
                        id="weather-city-input"
                        className="control settings-input"
                        value={weatherCityDraft}
                        onChange={(e) => handleWeatherCityInput(e.target.value)}
                        onKeyDown={handleWeatherCityKeyDown}
                        onFocus={() => {
                          if (weatherCitySuggestions.length > 0) setWeatherCitySuggestionsOpen(true)
                        }}
                        placeholder={text.weatherCityPlaceholder}
                        autoComplete="off"
                      />
                      {weatherCitySuggestionsOpen && weatherCitySuggestions.length > 0 && (
                        <div className="weather-city-suggestions">
                          {weatherCitySuggestions.map((s, i) => (
                            <button
                              key={`${s.latitude}-${s.longitude}`}
                              type="button"
                              className={`weather-city-suggestion${i === weatherCitySelectedIndex ? ' is-selected' : ''}`}
                              onMouseDown={() => handleWeatherCitySelect(s)}
                              onMouseEnter={() => setWeatherCitySelectedIndex(i)}
                            >
                              <span className="weather-city-suggestion-name">{s.name}</span>
                              <span className="weather-city-suggestion-detail">
                                {[s.admin1, s.country].filter(Boolean).join(', ')}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <label className="settings-toggle" htmlFor="experimental-music-toggle">
                  <span>{text.experimentalMusicLabel}</span>
                  <input
                    id="experimental-music-toggle"
                    type="checkbox"
                    checked={appState.settings.experimentalMusicEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { experimentalMusicEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

                <label className="settings-toggle" htmlFor="experimental-whitenoise-toggle">
                  <span>{text.experimentalWhiteNoiseLabel}</span>
                  <input
                    id="experimental-whitenoise-toggle"
                    type="checkbox"
                    checked={appState.settings.experimentalWhiteNoiseEnabled}
                    onChange={(event) =>
                      applyAction({
                        type: 'updateSettings',
                        patch: { experimentalWhiteNoiseEnabled: event.target.checked },
                      })
                    }
                  />
                </label>

              </div>
            </div>

            {showSettingsSetupPanel ? (
              <div className="settings-group">
                <h3 className="settings-group-title">{text.settingsGroupEnvironment}</h3>

                <div className="settings-section">
                  <p className="settings-note">{panelText.setupDescription}</p>

                  {hasMissingEnvironmentChecks ? (
                    <div className="setup-missing-shell">
                      <div className="settings-section-title">{panelText.setupMissingListTitle}</div>
                      <p className="settings-note">{panelText.setupMissingListDescription}</p>
                      <ul className="setup-missing-list">
                        {missingEnvironmentChecks.map((check) => (
                          <li key={check.id}>{check.label}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {settingsNotice ? (
                    <div className="panel-alert" role="alert">
                      {settingsNotice}
                    </div>
                  ) : null}

                  <div className={`setup-status-card is-${setupStatus?.state ?? 'idle'}`}>
                    <strong>{setupHeadline}</strong>
                    <p className="settings-note">{setupStatusMessage}</p>
                  </div>

                  <div className="settings-actions">
                    {hasMissingEnvironmentChecks ? (
                      <AppButton
                        tone="primary"
                        type="button"
                        disabled={setupStatusPending || setupStatus?.state === 'running'}
                        onClick={() => void handleRunSetup()}
                      >
                        {hasRunSetup ? panelText.rerunSetup : panelText.installMissingTools}
                      </AppButton>
                    ) : null}
                    <AppButton
                      type="button"
                      disabled={setupStatusPending}
                      onClick={() => {
                        void loadSetup()
                        void syncProviderStatuses()
                      }}
                    >
                      {panelText.refreshSetup}
                    </AppButton>
                  </div>

                  <div className="cli-update-shell">
                    <div className="settings-section-title">{panelText.cliUpdateTitle}</div>
                    <p className="settings-note">{panelText.cliUpdateDescription}</p>
                    <div className="cli-update-grid">
                      <label className="settings-field" htmlFor="cli-update-target">
                        <span>{panelText.cliUpdateTarget}</span>
                        <select
                          id="cli-update-target"
                          className="control settings-input"
                          value={cliUpdateTarget}
                          onChange={(event) =>
                            setCliUpdateTarget(event.target.value as 'all' | 'claude' | 'codex')
                          }
                        >
                          <option value="all">{panelText.cliUpdateTargetAll}</option>
                          <option value="claude">Claude</option>
                          <option value="codex">Codex</option>
                        </select>
                      </label>

                      <label className="settings-field" htmlFor="cli-update-version">
                        <span>{panelText.cliUpdateVersion}</span>
                        <input
                          id="cli-update-version"
                          className="control settings-input"
                          value={cliUpdateVersion}
                          placeholder={panelText.cliUpdateVersionPlaceholder}
                          onChange={(event) => setCliUpdateVersion(event.target.value)}
                        />
                      </label>
                    </div>
                    <p className="settings-note">{panelText.cliUpdateVersionNote}</p>
                    <div className="settings-actions cli-update-actions">
                      <AppButton
                        type="button"
                        disabled={setupStatusPending || setupStatus?.state === 'running'}
                        onClick={() => void handleUpdateCli()}
                      >
                        {panelText.cliUpdateButton}
                      </AppButton>
                    </div>
                  </div>

                  {hasSetupLogs ? (
                    <div className="setup-log-shell">
                      <div className="settings-section-title">{panelText.setupLogs}</div>
                      <div className="setup-log-list">
                        {setupLogs.map((entry, index) => (
                          <div key={`${entry.createdAt}-${index}`} className={`setup-log-entry is-${entry.level}`}>
                            {entry.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="settings-group settings-group-danger">
              <h3 className="settings-group-title">{text.settingsGroupData}</h3>

              <div className="settings-section settings-danger-section">
                <p className="settings-note">{text.clearUserDataDialogBody}</p>

                <div className="settings-actions">
                  <AppButton
                    type="button"
                    className="settings-danger-button"
                    onClick={openClearUserDataDialog}
                  >
                    {text.clearUserDataButton}
                  </AppButton>
                </div>
              </div>
            </div>
              </>
            )}
          </section>
        </section>
      </div>

      <main
        id="app-panel-ambience"
        className="board"
        role="tabpanel"
        aria-labelledby="app-tab-ambience"
        hidden={activeTab !== 'ambience'}
        onWheelCapture={handleBoardWheelCapture}
      >
        {appState.columns.map((column) => {
          const sessionHistory =
            sessionHistoryByWorkspacePath.get(normalizeWorkspaceHistoryKey(column.workspacePath)) ?? emptySessionHistory

          return (
            <WorkspaceColumn
            key={column.id}
            column={column}
            providers={providerByName}
            language={appState.settings.language}
            systemPrompt={appState.settings.systemPrompt}
            modelPromptRules={appState.settings.modelPromptRules}
            codexChatSettings={codexChatSettings}
            crossProviderSkillReuseEnabled={appState.settings.crossProviderSkillReuseEnabled}
            musicAlbumCoverEnabled={appState.settings.musicAlbumCoverEnabled}
            weatherCity={appState.settings.weatherCity}
            gitAgentModel={appState.settings.gitAgentModel}
            brainstormRequestModel={appState.settings.requestModels.codex}
            availableQuickToolModels={availableQuickToolModels}
            autoUrgeEnabled={appState.settings.autoUrgeEnabled}
            autoUrgeProfiles={appState.settings.autoUrgeProfiles}
            autoUrgeMessage={appState.settings.autoUrgeMessage}
            autoUrgeSuccessKeyword={appState.settings.autoUrgeSuccessKeyword}
            globalUrgeActive={
              appState.settings.autoUrgeEnabled &&
              appState.settings.autoUrgeGlobalControlEnabled &&
              appState.settings.autoUrgeGlobalActive
            }
            globalUrgeProfileId={appState.settings.autoUrgeGlobalProfileId}
            onSetAutoUrgeEnabled={setAutoUrgeEnabled}
            onChangeColumn={(patch) => applyAction({ type: 'updateColumn', columnId: column.id, patch })}
            onChangeCardModel={(cardId, provider, model) =>
              changeCardModelSelection(column.id, cardId, provider, model)
            }
            onChangeCardReasoningEffort={(cardId, reasoningEffort) =>
              changeCardReasoningEffort(column.id, cardId, reasoningEffort)
            }
            onToggleCardPlanMode={(cardId) => toggleCardPlanMode(column.id, cardId)}
            onToggleCardThinking={(cardId) => toggleCardThinking(column.id, cardId)}
            onToggleCardCollapsed={(cardId) => toggleCardCollapsed(column.id, cardId)}
            onMarkCardRead={(cardId) =>
              (() => {
                const action: IdeAction = {
                  type: 'updateCard',
                  columnId: column.id,
                  cardId,
                  patch: { unread: false, completionGlow: false },
                }
                persistAfterAction(action.type, applyAction(action))
              })()
            }
            onChangeCardDraft={(cardId, draft) => {
              const currentDraft = column.cards[cardId]?.draft ?? ''
              if (currentDraft === draft) {
                return
              }

              const nextState = applyAction({ type: 'setCardDraft', columnId: column.id, cardId, draft })

              // Empty drafts are less urgent than send/clear flows; queue them so
              // repeated composer edits cannot force synchronous full-state saves.
              if (draft.length === 0) {
                persistQueued(nextState)
              }
            }}
            onChangeCardStickyNote={(cardId, content) =>
              (() => {
                const action: IdeAction = {
                  type: 'updateCard',
                  columnId: column.id,
                  cardId,
                  patch: { stickyNote: content },
                }
                persistAfterAction(action.type, applyAction(action))
              })()
            }
            stickyNoteArchivedContent={
              appState.stickyNoteArchive[column.workspacePath]?.content ?? ''
            }
            stickyNoteArchivedViewState={
              appState.stickyNoteArchive[column.workspacePath]?.viewState
            }
            onChangeStickyNoteViewState={(viewState) =>
              (() => {
                const action: IdeAction = {
                  type: 'updateStickyNoteViewState',
                  workspacePath: column.workspacePath,
                  viewState,
                }
                const nextState = applyAction(action)
                persistQueued(nextState)
              })()
            }
            onDiscardStickyNoteArchive={() =>
              (() => {
                const action: IdeAction = {
                  type: 'clearStickyNoteArchive',
                  workspacePath: column.workspacePath,
                }
                persistAfterAction(action.type, applyAction(action))
              })()
            }
            onPatchCard={(cardId, patch) =>
              (() => {
                const action: IdeAction = {
                  type: 'updateCard',
                  columnId: column.id,
                  cardId,
                  patch,
                }
                persistAfterAction(action.type, applyAction(action))
              })()
            }
            onChangeCardTitle={(cardId, title) =>
              (() => {
                const action: IdeAction = {
                  type: 'updateCard',
                  columnId: column.id,
                  cardId,
                  patch: { title },
                }
                persistAfterAction(action.type, applyAction(action))
              })()
            }
            onReorderColumn={(sourceColumnId, targetColumnId, placement) =>
              applyAction({
                type: 'reorderColumn',
                sourceColumnId,
                targetColumnId,
                placement,
              })
            }
            onRemoveColumn={() => openCloseWorkspaceDialog(column.id)}
            onResizeColumn={(widths) =>
              applyAction({
                type: 'setColumnWidths',
                widths,
              })
            }
            onAddTab={(paneId) =>
              {
                rememberPaneTarget(column.id, paneId)
                applyAction({
                  type: 'addTab',
                  columnId: column.id,
                  paneId,
                })
              }
            }
            onSplitPane={(paneId, direction, placement, tabId, newPaneId) =>
              applyAction({
                type: 'splitPane',
                columnId: column.id,
                paneId,
                direction,
                placement,
                tabId,
                newPaneId,
              })
            }
            onSplitMoveTab={(sourcePaneId, targetPaneId, tabId, direction, placement, newPaneId) =>
              applyAction({
                type: 'splitMoveTab',
                columnId: column.id,
                sourcePaneId,
                targetPaneId,
                tabId,
                direction,
                placement,
                newPaneId,
              })
            }
            onCloseTab={(paneId, tabId) => void closeTab(column.id, paneId, tabId)}
            onMoveTab={(sourceColumnId, sourcePaneId, tabId, targetColumnId, targetPaneId, index) =>
              applyAction({
                type: 'moveTab',
                sourceColumnId,
                sourcePaneId,
                tabId,
                targetColumnId,
                targetPaneId,
                index,
              })
            }
            onReorderTab={(paneId, tabId, index) =>
              applyAction({
                type: 'reorderTab',
                columnId: column.id,
                paneId,
                tabId,
                index,
              })
            }
            onSetActiveTab={(paneId, tabId) =>
              {
                rememberPaneTarget(column.id, paneId)
                applyAction({
                  type: 'setActiveTab',
                  columnId: column.id,
                  paneId,
                  tabId,
                })
              }
            }
            onResizePane={(splitId, ratios) =>
              applyAction({
                type: 'resizePane',
                columnId: column.id,
                splitId,
                ratios,
              })
            }
            onActivatePane={(paneId) => rememberPaneTarget(column.id, paneId)}
            onSendMessage={(cardId, prompt, attachments, options) =>
              sendMessage(column.id, cardId, prompt, attachments, options)
            }
            onStopMessage={(cardId) => stopCard(cardId)}
            onCancelQueuedSends={(cardId) => clearQueuedSends(cardId)}
            onSendNextQueuedNow={(cardId) => sendNextQueuedNow(column.id, cardId)}
            onManualRecoverStream={(cardId) => manuallyRecoverStream(column.id, cardId)}
            onForkConversation={(cardId, messageId) => {
              void (async () => {
                // Lossless path: copy the provider's native session file
                // truncated before the fork point, so the forked card resumes
                // with full context instead of the budgeted transcript replay.
                const sourceCard = column.cards[cardId]
                const forkPoint = sourceCard
                  ? resolveForkPointMessage(sourceCard.messages, messageId)
                  : null
                const forkedSessionId =
                  sourceCard?.sessionId?.trim() && forkPoint && forkPoint.messageIndex > 0
                    ? await forkProviderSession({
                        provider: sourceCard.provider,
                        workspacePath: column.workspacePath,
                        sessionId: sourceCard.sessionId,
                        forkPoint: {
                          content: forkPoint.message.content,
                          createdAt: forkPoint.message.createdAt,
                        },
                      }).catch(() => null)
                    : null
                const action: IdeAction = {
                  type: 'forkConversation',
                  columnId: column.id,
                  cardId,
                  messageId,
                  ...(forkedSessionId ? { forkedSessionId } : {}),
                }
                persistAfterAction(action.type, applyAction(action))
              })()
            }}
            onOpenFile={(paneId, relativePath) => {
              const fileName = relativePath.split('/').pop() ?? relativePath
              openTextEditorTab(column.id, paneId, relativePath, fileName)
            }}
            recentWorkspaces={appState.settings.recentWorkspaces}
            onRecordRecentWorkspace={(path) => applyAction({ type: 'recordRecentWorkspace', path })}
            onRemoveRecentWorkspaces={(paths) => applyAction({ type: 'removeRecentWorkspaces', paths })}
            sessionHistory={sessionHistory}
            cardRecoveryStatuses={cardRecoveryStatuses}
            queuedSendSummaries={queuedSendSummaries}
            onRestoreSession={(entryId) => handleRestoreSession(column.id, entryId)}
            onImportExternalSession={(entry) =>
              applyAction({
                type: 'importExternalSession',
                columnId: column.id,
                paneId: resolveColumnPaneTarget(column.id),
                entry,
              })
            }
            />
          )
        })}
      </main>

      {recentCrashRecovery && !startupRecovery ? (
        <div className="structured-preview-layer">
          <div className="structured-preview-backdrop" />
          <section
            className="structured-preview-dialog state-recovery-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recent-crash-recovery-title"
          >
            <div className="structured-preview-card state-recovery-card">
              <div className="structured-preview-header">
                <div className="structured-preview-copy">
                  <div className="eyebrow">{recentCrashCopy.eyebrow}</div>
                  <h3 id="recent-crash-recovery-title">{recentCrashCopy.title}</h3>
                  <p className="settings-note">
                    {recentCrashCopy.description(recentCrashRecovery.sessionHistoryEntryIds.length)}
                  </p>
                </div>
              </div>

              <div className="structured-preview-body state-recovery-body">
                <div className="state-recovery-section">
                  <div className="settings-section-title">{recentCrashCopy.detailsTitle}</div>
                  <div className="state-recovery-issue">
                    <div className="state-recovery-issue-meta">
                      <span>
                        {recentCrashCopy.crashedAt}:{' '}
                        {formatLocalizedDateTime(appState.settings.language, recentCrashRecovery.crashedAt)}
                      </span>
                      <span>
                        {recentCrashRecovery.sessionHistoryEntryIds.length}
                        {appState.settings.language === 'zh-CN' ? ' 个会话已归档' : ' archived sessions'}
                      </span>
                    </div>
                    {recentCrashRecovery.errorSummary.trim() ? (
                      <p>
                        {recentCrashCopy.errorSummary}: {recentCrashRecovery.errorSummary.trim()}
                      </p>
                    ) : null}
                  </div>
                </div>

                {recentCrashActionError ? (
                  <div className="panel-alert" role="alert">
                    {recentCrashActionError}
                  </div>
                ) : null}

                <div className="state-recovery-dialog-actions">
                  <AppButton
                    tone="primary"
                    type="button"
                    disabled={recentCrashActionPending}
                    onClick={() => void handleRestoreRecentCrashSessions()}
                  >
                    {recentCrashActionPending ? recentCrashCopy.pending : recentCrashCopy.restore}
                  </AppButton>
                  <AppButton
                    type="button"
                    disabled={recentCrashActionPending}
                    onClick={() => void handleDismissRecentCrash()}
                  >
                    {recentCrashActionPending ? recentCrashCopy.pending : recentCrashCopy.dismiss}
                  </AppButton>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {onboardingOpen ? (
        <div className="onboarding-shell">
          <div className="onboarding-backdrop" />
          <section
            className="onboarding-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-title"
          >
            <div className="onboarding-card">
              <div className="onboarding-head">
                <div className="onboarding-copy">
                  <div className="eyebrow">{onboardingText.eyebrow}</div>
                  <h2 id="onboarding-title">{onboardingText.title}</h2>
                  <p className="settings-note">{onboardingText.loadingDescription}</p>
                </div>

                <div className="wizard-language-toggle" role="group" aria-label={onboardingText.languageToggle}>
                  {onboardingLanguages.map((language) => {
                    const active = onboardingLanguage === language.value

                    return (
                      <button
                        key={language.value}
                        id={language.value === 'zh-CN' ? 'wizard-language-zh' : 'wizard-language-en'}
                        type="button"
                        className={`wizard-language-chip${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        aria-label={language.label}
                        onClick={() => setGuideLanguage(language.value)}
                      >
                        <span aria-hidden="true">{language.flag}</span>
                        <span>{language.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="onboarding-summary-list">
                <div
                  className={`onboarding-summary-item${
                    onboardingStage === 'setup'
                      ? ' is-current'
                      : onboardingEnvironmentReady || onboardingSetupSkipped
                        ? ' is-complete'
                        : ''
                  }`}
                >
                  <div className="onboarding-summary-number">1</div>
                  <div>
                    <strong>{onboardingText.setupStepTitle}</strong>
                    <p>{onboardingSetupSummary}</p>
                  </div>
                </div>

                <div
                  className={`onboarding-summary-item${
                    onboardingStage === 'import'
                      ? ' is-current'
                      : onboardingStage === 'complete'
                        ? ' is-complete'
                        : ''
                  }`}
                >
                  <div className="onboarding-summary-number">2</div>
                  <div>
                    <strong>{onboardingText.importStepTitle}</strong>
                    <p>{onboardingImportSummary}</p>
                  </div>
                </div>
              </div>

              {onboardingImportError ? (
                <div className="panel-alert" role="alert">
                  {onboardingImportError}
                </div>
              ) : null}

              <div className="onboarding-stage-card">
                <div className="settings-section-title">{onboardingCurrentTitle}</div>
                <p className="settings-note">{onboardingCurrentDescription}</p>

                {onboardingStage === 'setup' ? (
                  <>
                    {hasMissingEnvironmentChecks ? (
                      <div className="setup-missing-shell">
                        <div className="settings-section-title">{panelText.setupMissingListTitle}</div>
                        <p className="settings-note">{panelText.setupMissingListDescription}</p>
                        <ul className="setup-missing-list">
                          {missingEnvironmentChecks.map((check) => (
                            <li key={check.id}>{check.label}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className={`setup-status-card is-${setupStatus?.state ?? 'idle'}`}>
                      <strong>{setupHeadline}</strong>
                      <p className="settings-note">{setupStatusMessage}</p>
                    </div>

                    {hasSetupLogs ? (
                      <div className="setup-log-shell">
                        <div className="settings-section-title">{panelText.setupLogs}</div>
                        <div className="setup-log-list">
                          {setupLogs.map((entry, index) => (
                            <div key={`${entry.createdAt}-${index}`} className={`setup-log-entry is-${entry.level}`}>
                              {entry.message}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="settings-actions onboarding-actions">
                {onboardingStage === 'loading' ? (
                  <AppButton tone="primary" type="button" disabled>
                    {onboardingText.installing}
                  </AppButton>
                ) : null}

                {onboardingStage === 'setup' ? (
                  <>
                    <AppButton
                      tone="primary"
                      type="button"
                      disabled={setupStatusPending || setupStatus?.state === 'running'}
                      onClick={() => void handleRunSetup()}
                    >
                      {onboardingSetupButtonLabel}
                    </AppButton>
                    {setupStatus?.state === 'error' || setupStatus?.state === 'unsupported' ? (
                      <AppButton
                        type="button"
                        onClick={() => {
                          setOnboardingSetupSkipped(true)
                        }}
                      >
                        {onboardingText.skipForNow}
                      </AppButton>
                    ) : null}
                  </>
                ) : null}

                {onboardingStage === 'import' ? (
                  <>
                    <AppButton
                      tone="primary"
                      type="button"
                      disabled={routingImportPending}
                      onClick={() => void handleOnboardingImport()}
                    >
                      {onboardingText.importNow}
                    </AppButton>
                    <AppButton
                      type="button"
                      disabled={routingImportPending}
                      onClick={() => {
                        setOnboardingImportState('skipped')
                        setOnboardingImportError(null)
                      }}
                    >
                      {onboardingText.skipForNow}
                    </AppButton>
                  </>
                ) : null}

                {onboardingStage === 'complete' ? (
                  <AppButton tone="primary" type="button" onClick={completeOnboarding}>
                    {onboardingText.openWorkspace}
                  </AppButton>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {clearUserDataDialogOpen ? (
        <div className="structured-preview-layer">
          <div className="structured-preview-backdrop" onClick={closeClearUserDataDialog} />
          <section
            className="structured-preview-dialog settings-danger-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-user-data-dialog-title"
          >
            <div className="structured-preview-card settings-danger-card">
              <div className="structured-preview-header">
                <div className="structured-preview-copy">
                  <h3 id="clear-user-data-dialog-title">{text.clearUserDataDialogTitle}</h3>
                  <p className="settings-note">{text.clearUserDataDialogBody}</p>
                </div>

                <button
                  type="button"
                  className="btn btn-ghost structured-preview-close"
                  onClick={closeClearUserDataDialog}
                  disabled={clearUserDataPending}
                  aria-label={text.clearUserDataCancel}
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="structured-preview-body settings-danger-body">
                <ul className="settings-danger-list">
                  <li>{text.clearUserDataDialogChats}</li>
                  <li>{text.clearUserDataDialogSettings}</li>
                  <li>{text.clearUserDataDialogCaches}</li>
                </ul>
                <p className="settings-danger-warning" role="alert">
                  {text.clearUserDataDialogWarning}
                </p>

                <div className="settings-actions settings-danger-actions">
                  <AppButton
                    type="button"
                    disabled={clearUserDataPending}
                    onClick={closeClearUserDataDialog}
                  >
                    {text.clearUserDataCancel}
                  </AppButton>
                  <AppButton
                    type="button"
                    className="settings-danger-button settings-danger-button-confirm"
                    disabled={clearUserDataPending}
                    onClick={handleClearUserData}
                  >
                    {clearUserDataPending ? text.clearUserDataPending : text.clearUserDataConfirm}
                  </AppButton>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {remoteMonitorDialogOpen ? (
        <div className="structured-preview-layer">
          <div className="structured-preview-backdrop" onClick={closeRemoteMonitorDialog} />
          <section
            className="structured-preview-dialog remote-monitor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-monitor-dialog-title"
          >
            <div className="structured-preview-card remote-monitor-card">
              <div className="structured-preview-header">
                <div className="structured-preview-copy">
                  <h3 id="remote-monitor-dialog-title">{text.remoteMonitorDialogTitle}</h3>
                  <p className="settings-note">{text.remoteMonitorDialogBody}</p>
                </div>

                <button
                  type="button"
                  className="btn btn-ghost structured-preview-close"
                  onClick={closeRemoteMonitorDialog}
                  aria-label={text.remoteMonitorCloseDialog}
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="structured-preview-body remote-monitor-body">
                {remoteMonitorError ? (
                  <p className="settings-danger-warning" role="alert">
                    {text.remoteMonitorStartFailed(remoteMonitorError)}
                  </p>
                ) : remoteMonitorInfo ? (
                  <>
                    <div className="remote-monitor-qr-frame">
                      <img
                        className="remote-monitor-qr-image"
                        src={remoteMonitorInfo.qrDataUrl}
                        alt={text.remoteMonitorDialogTitle}
                      />
                    </div>
                    {remoteMonitorInfo.lanFallback ? (
                      <p className="settings-danger-warning" role="alert">
                        {text.remoteMonitorLanFallbackWarning}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="remote-monitor-url"
                      title={text.remoteMonitorCopyLink}
                      onClick={handleCopyRemoteMonitorLink}
                    >
                      {remoteMonitorInfo.url}
                    </button>
                    <p className="settings-note remote-monitor-meta">
                      {remoteMonitorLinkCopied
                        ? text.remoteMonitorLinkCopied
                        : text.remoteMonitorClientCount(remoteMonitorClientCount)}
                    </p>
                    <p className="settings-note">{text.remoteMonitorSecurityNote}</p>
                    <div className="settings-actions remote-monitor-actions">
                      <AppButton type="button" onClick={handleCopyRemoteMonitorLink}>
                        {text.remoteMonitorCopyLink}
                      </AppButton>
                      <AppButton
                        type="button"
                        className="settings-danger-button settings-danger-button-confirm"
                        onClick={handleStopRemoteMonitor}
                      >
                        {text.remoteMonitorStop}
                      </AppButton>
                    </div>
                  </>
                ) : (
                  <p className="settings-note">{text.remoteMonitorStarting}</p>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {codexFastModeDialogOpen ? (
        <div className="structured-preview-layer">
          <div className="structured-preview-backdrop" onClick={closeCodexFastModeDialog} />
          <section
            className="structured-preview-dialog settings-danger-dialog codex-fast-mode-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-fast-mode-dialog-title"
          >
            <div className="structured-preview-card settings-danger-card">
              <div className="structured-preview-header">
                <div className="structured-preview-copy">
                  <h3 id="codex-fast-mode-dialog-title">{text.codexFastModeDialogTitle}</h3>
                  <p className="settings-note">{text.codexFastModeDialogBody}</p>
                </div>

                <button
                  type="button"
                  className="btn btn-ghost structured-preview-close"
                  onClick={closeCodexFastModeDialog}
                  aria-label={text.codexFastModeDialogCancel}
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="structured-preview-body settings-danger-body">
                <p className="settings-danger-warning" role="alert">
                  {text.codexFastModeDialogWarning}
                </p>

                <div className="settings-actions settings-danger-actions">
                  <AppButton type="button" onClick={closeCodexFastModeDialog}>
                    {text.codexFastModeDialogCancel}
                  </AppButton>
                  <AppButton
                    type="button"
                    className="settings-danger-button settings-danger-button-confirm"
                    onClick={confirmCodexFastMode}
                  >
                    {text.codexFastModeDialogConfirm}
                  </AppButton>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {closeWorkspaceDialogColumnId ? (
        <div className="structured-preview-layer">
          <div className="structured-preview-backdrop" onClick={closeCloseWorkspaceDialog} />
          <section
            className="structured-preview-dialog close-workspace-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-workspace-dialog-title"
          >
            <div className="structured-preview-card close-workspace-card">
              <div className="structured-preview-header">
                <div className="structured-preview-copy">
                  <h3 id="close-workspace-dialog-title">{text.closeWorkspaceDialogTitle}</h3>
                  <p className="settings-note">{text.closeWorkspaceDialogBody}</p>
                </div>

                <button
                  type="button"
                  className="btn btn-ghost structured-preview-close"
                  onClick={closeCloseWorkspaceDialog}
                  disabled={closeWorkspacePending}
                  aria-label={text.closeWorkspaceCancel}
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="structured-preview-body close-workspace-body">
                <ul className="settings-danger-list">
                  <li>{text.closeWorkspaceDialogHistory}</li>
                  <li>{text.closeWorkspaceDialogStreams}</li>
                </ul>

                <div className="settings-actions settings-danger-actions">
                  <AppButton
                    type="button"
                    disabled={closeWorkspacePending}
                    onClick={closeCloseWorkspaceDialog}
                  >
                    {text.closeWorkspaceCancel}
                  </AppButton>
                  <AppButton
                    type="button"
                    className="settings-danger-button settings-danger-button-confirm"
                    disabled={closeWorkspacePending}
                    onClick={confirmCloseWorkspace}
                  >
                    {closeWorkspacePending ? text.closeWorkspacePending : text.closeWorkspaceConfirm}
                  </AppButton>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {renderModelPromptRulesDialog()}
    </div>,
  )
}

export default App
