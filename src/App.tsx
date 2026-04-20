import {
  startTransition,
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
  titleFromPrompt,
} from '../shared/default-state'
import { attachImagesToMessageMeta } from '../shared/chat-attachments'
import { formatLocalizedDateTime, getLocaleText, getProviderLabel } from '../shared/i18n'
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  FILETREE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  getModelOptions,
  normalizeModel,
  resolveSlashModel,
} from '../shared/models'
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
  resolveStreamRecoveryMode,
  shouldResetStreamRecoveryAttemptsForActivity,
  shouldResetStreamRecoveryAttemptsForText,
} from './stream-recovery'
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
  fetchSetupStatus,
  loadSessionHistoryEntry,
  fetchState,
  importCcSwitchRouting,
  isWindowMaximized,
  minimizeWindow,
  onWindowMaximizedChanged,
  openChatStream,
  requestChat,
  resetState,
  runEnvironmentSetup,
  stopChat,
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
} from './api'
import { resolveAppLoadError } from './app-load-error'
import { startInitialAppLoad } from './app-initial-load'
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
  emptyProfileDraft,
  errorMessage,
  finalizeStructuredActivityMessage,
  finalizeStreamedAssistantMessage,
  getAgentDoneSoundUrl,
  getColumnById,
  getRoutingImportText,
  importErrorMessage,
  isFirstOpenState,
  onboardingLanguages,
  onboardingStorageKey,
  readFileAsBase64,
} from './app-helpers'
import {
  clearPendingCompactBoundaryMessage,
  finalizePendingCompactBoundaryMessage,
  getPendingCompactBoundaryMessage,
  isCompactBoundaryMessage,
  markCompactBoundaryMessage,
} from './components/chat-card-compaction'
import { collectChangesSummaryFilesForStream } from './components/chat-card-parsing'
import { getAutoReadCardIdsForVisiblePanes, shouldMarkCardUnreadOnStreamDone } from './components/pane-read-state'
import { clearFileTreeCacheForCard } from './components/tool-card-state'
import { buildSeededChatPrompt, collectSeededChatAttachments, hasSeededChatTranscript } from './chat-request-seeding'
import { buildArchiveRecallSnapshot } from './archive-recall'
import { getOnboardingText, getPanelText, getResilientProxyText, getTopTabText } from './app-panel-text'
import { AppButton } from './components/AppButton'
import {
  getStableSettingsPanelColumnCount,
  splitSettingsGroupsIntoStableColumns,
} from './settings-layout'
import {
  CloseIcon,
  MaximizeWindowIcon,
  MinimizeWindowIcon,
  ModelIcon,
  PlusIcon,
  RestoreWindowIcon,
  EyeIcon,
  EyeOffIcon,
} from './components/Icons'
import { WorkspaceColumn } from './components/WorkspaceColumn'
import {
  getPersistenceVersion,
  shouldPersistActionImmediately,
  shouldSyncRuntimeSettings,
} from './hooks/persistence-queue'
import { usePersistence } from './hooks/usePersistence'
import { updateLatestKnownAppState } from './renderer-crash-state'
import { findPaneForTab, findPaneInLayout, ideReducer, type IdeAction } from './state'

const overflowScrollablePattern = /(auto|scroll|overlay)/
const emptyProxyStatsCounts: ProxyStatsCounts = {
  requests: 0,
  disconnects: 0,
  recoverySuccesses: 0,
  recoveryFailures: 0,
}
const emptySessionHistory: SessionHistoryEntry[] = []

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

function canConsumeVerticalWheel(node: HTMLElement, deltaY: number) {
  const style = getComputedStyle(node)
  if (!overflowScrollablePattern.test(style.overflowY)) {
    return false
  }

  const maxScrollTop = node.scrollHeight - node.clientHeight
  if (maxScrollTop <= 1) {
    return false
  }

  if (deltaY < 0) {
    return node.scrollTop > 1
  }

  if (deltaY > 0) {
    return node.scrollTop < maxScrollTop - 1
  }

  return false
}

function getVerticalScrollLimit(node: HTMLElement) {
  return node.scrollHeight - node.clientHeight
}

function isCardVerticalScrollRegion(node: HTMLElement) {
  if (!node.closest('.card-shell')) {
    return false
  }

  const style = getComputedStyle(node)
  if (!overflowScrollablePattern.test(style.overflowY)) {
    return false
  }

  return getVerticalScrollLimit(node) > 1
}

function getBoardWheelPath(target: EventTarget | null, board: HTMLElement, composedPath: EventTarget[] | null) {
  if (composedPath && composedPath.length > 0) {
    const path: HTMLElement[] = []

    for (const entry of composedPath) {
      if (!(entry instanceof HTMLElement)) {
        continue
      }
      if (entry === board) {
        break
      }
      path.push(entry)
    }

    if (path.length > 0) {
      return path
    }
  }

  const path: HTMLElement[] = []
  let current = target instanceof HTMLElement ? target : null

  while (current && current !== board) {
    path.push(current)
    current = current.parentElement
  }

  return path
}

function getBoardWheelDisposition(
  target: EventTarget | null,
  board: HTMLElement,
  deltaY: number,
  composedPath: EventTarget[] | null = null,
) {
  const path = getBoardWheelPath(target, board, composedPath)

  for (const current of path) {
    if (isCardVerticalScrollRegion(current)) {
      if (deltaY > 0) {
        if (canConsumeVerticalWheel(current, deltaY)) {
          return { type: 'scroll-card', node: current } as const
        }

        return { type: 'trap' } as const
      }

      return { type: 'pass' } as const
    }

    if (canConsumeVerticalWheel(current, deltaY)) {
      return { type: 'pass' } as const
    }
  }

  return { type: 'forward' } as const
}

type PaneTarget = {
  columnId: string
  paneId: string
}

type QueuedSendRequest = {
  prompt: string
  attachments: ImageAttachment[]
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
  const [clearUserDataDialogOpen, setClearUserDataDialogOpen] = useState(false)
  const [clearUserDataPending, setClearUserDataPending] = useState(false)
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
    new Map<string, Array<{ prompt: string; attachments: ImageAttachment[] }>>(),
  )
  const queueFollowUpDuringStreamRef = useRef(new Map<string, boolean>())
  const stoppedRunReasonRef = useRef(new Map<string, StoppedRunReason>())
  const appStateRef = useRef(appState)
  const activePaneTargetRef = useRef<PaneTarget | null>(null)
  const streamRetryCountRef = useRef(new Map<string, number>())
  const sendMessageRef = useRef<(
    (columnId: string, cardId: string, prompt: string, attachments: ImageAttachment[]) => Promise<void>
  ) | null>(null)
  const recoverLiveStreamRef = useRef<((columnId: string, cardId: string) => Promise<boolean>) | null>(null)
  const routingImportInputRef = useRef<HTMLInputElement | null>(null)
  const onboardingAutoSetupStartedRef = useRef(false)
  const hydrateRequestIdRef = useRef(0)
  // Streaming delta buffer: coalesces per-token SSE deltas into a single
  // dispatch per animation frame to avoid re-rendering on every character.
  const deltaBufferRef = useRef(
    new Map<string, { columnId: string; cardId: string; messageId: string; buffer: string }>(),
  )
  const deltaFlushHandleRef = useRef<number | null>(null)

  useEffect(() => {
    appStateRef.current = appState
    updateLatestKnownAppState(appState)
  }, [appState])

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

    startTransition(() => {
      dispatch({ type: 'replace', state })
      setLoadStatus('ready')
    })
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
    if (actions.some((action) => shouldSyncRuntimeSettings(action))) {
      void syncRuntimeSettings(nextState.settings).catch(() => undefined)
    }

    for (const action of actions) {
      dispatch(action)
    }

    return nextState
  }, [])

  const applyAction = useCallback((action: IdeAction) => applyActions([action]), [applyActions])

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

  const updateAutoUrgeProfile = useCallback(
    (profileId: string, patch: Partial<Pick<AutoUrgeProfile, 'name' | 'message' | 'successKeyword'>>) => {
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
              const successKeyword = profile.successKeyword.trim() || '-'

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
                            {text.autoUrgeSuccessKeywordLabel}
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
                              {text.autoUrgeSuccessKeywordLabel}
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

      applyActions([
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
      ])

      setSwitchNotice(null)
      setProfileDrafts((current) => ({
        ...current,
        [provider]: emptyProfileDraft(),
      }))
    },
    [applyActions, profileDrafts],
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

  const closeStream = useCallback(async (cardId: string, stopRemote = false) => {
    const active = activeStreamsRef.current.get(cardId)
    if (!active) {
      queueFollowUpDuringStreamRef.current.delete(cardId)
      return
    }

    // Flush any buffered streaming deltas for this card before tearing down
    const bufferEntry = deltaBufferRef.current.get(cardId)
    if (bufferEntry && bufferEntry.buffer.length > 0) {
      const flushAction: IdeAction = {
        type: 'appendAssistantDelta',
        columnId: bufferEntry.columnId,
        cardId: bufferEntry.cardId,
        messageId: bufferEntry.messageId,
        delta: bufferEntry.buffer,
      }
      deltaBufferRef.current.delete(cardId)
      applyAction(flushAction)
    }

    active.source.close()
    activeStreamsRef.current.delete(cardId)
    streamRetryCountRef.current.delete(cardId)
    queueFollowUpDuringStreamRef.current.delete(cardId)

    if (stopRemote) {
      await stopChat(active.streamId).catch(() => undefined)
    }
  }, [applyAction])

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
        active?.source.close()
        activeStreamsRef.current.delete(cardId)
        streamRetryCountRef.current.delete(cardId)
        queueFollowUpDuringStreamRef.current.delete(cardId)

        if (!owner) {
          return false
        }

        persistImmediately(
          applyActions([
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
          ]),
        )
        return false
      }
    },
    [applyActions, persistImmediately, text.unexpectedError],
  )

  const enqueueQueuedSend = useCallback((cardId: string, request: QueuedSendRequest) => {
    const currentQueue = queuedSendRequestsRef.current.get(cardId) ?? []
    currentQueue.push(request)
    queuedSendRequestsRef.current.set(cardId, currentQueue)
  }, [])

  const clearQueuedSends = useCallback((cardId: string) => {
    queuedSendRequestsRef.current.delete(cardId)
  }, [])

  const dispatchNextQueuedSend = useCallback((columnId: string, cardId: string) => {
    const currentQueue = queuedSendRequestsRef.current.get(cardId)
    if (!currentQueue || currentQueue.length === 0) {
      return
    }

    const nextRequest = currentQueue.shift()
    if (!nextRequest) {
      return
    }

    if (currentQueue.length === 0) {
      queuedSendRequestsRef.current.delete(cardId)
    }

    queueMicrotask(() => {
      void sendMessageRef.current?.(columnId, cardId, nextRequest.prompt, nextRequest.attachments)
    })
  }, [])

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
        model: TEXTEDITOR_TOOL_MODEL,
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
      ? '例如：claude / sonnet / gpt-5.4'
      : 'For example: claude / sonnet / gpt-5.4'
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
        persistImmediately(nextState)
      }
    },
    [applyAction, getColumnCard, persistImmediately],
  )

  const changeCardReasoningEffort = useCallback(
    (columnId: string, cardId: string, reasoningEffort: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      const normalizedReasoningEffort = normalizeReasoningEffort(card.provider, reasoningEffort)

      applyActions([
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
      ])
    },
    [applyActions, getColumnCard],
  )

  const toggleCardPlanMode = useCallback(
    (columnId: string, cardId: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      applyAction({
        type: 'updateCard',
        columnId,
        cardId,
        patch: { planMode: !card.planMode },
      })
    },
    [applyAction, getColumnCard],
  )

  const toggleCardThinking = useCallback(
    (columnId: string, cardId: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      applyAction({
        type: 'updateCard',
        columnId,
        cardId,
        patch: { thinkingEnabled: card.thinkingEnabled === false ? true : false },
      })
    },
    [applyAction, getColumnCard],
  )

  const toggleCardCollapsed = useCallback(
    (columnId: string, cardId: string) => {
      const card = getColumnCard(columnId, cardId)

      if (!card) {
        return
      }

      applyAction({
        type: 'updateCard',
        columnId,
        cardId,
        patch: { collapsed: !card.collapsed },
      })
    },
    [applyAction, getColumnCard],
  )

  const appendCardLogs = useCallback(
    (columnId: string, cardId: string, provider: Provider, message: string) => {
      const messages = createLogMessages(provider, message)
      if (messages.length === 0) {
        return
      }

      startTransition(() => {
        dispatch({
          type: 'appendMessages',
          columnId,
          cardId,
          messages,
        })
      })
    },
    [],
  )

  const ensureAssistantMessage = useCallback(
    (
      columnId: string,
      cardId: string,
      provider: Provider,
      streamId: string,
      source: ChatStreamSource,
    ) => {
      const assistantMessage = createMessage('assistant', '', { provider })
      const active = activeStreamsRef.current.get(cardId)

      activeStreamsRef.current.set(cardId, {
        cardId,
        streamId,
        source,
        assistantMessageId: active?.assistantMessageId ?? assistantMessage.id,
      })

      if (active?.assistantMessageId) {
        return active.assistantMessageId
      }

      applyAction({
        type: 'appendMessages',
        columnId,
        cardId,
        messages: [assistantMessage],
      })

      return assistantMessage.id
    },
    [applyAction],
  )

  const flushDeltaBuffer = useCallback(() => {
    deltaFlushHandleRef.current = null
    const buffer = deltaBufferRef.current
    if (buffer.size === 0) {
      return
    }

    const actions: IdeAction[] = []
    for (const entry of buffer.values()) {
      if (entry.buffer.length === 0) continue
      actions.push({
        type: 'appendAssistantDelta',
        columnId: entry.columnId,
        cardId: entry.cardId,
        messageId: entry.messageId,
        delta: entry.buffer,
      })
    }
    buffer.clear()

    if (actions.length === 0) {
      return
    }

    startTransition(() => {
      applyActions(actions)
    })
  }, [applyActions])

  const enqueueAssistantDelta = useCallback(
    (columnId: string, cardId: string, messageId: string, delta: string) => {
      if (!delta) return
      const buffer = deltaBufferRef.current
      const existing = buffer.get(cardId)
      if (existing && existing.messageId === messageId) {
        existing.buffer += delta
      } else {
        buffer.set(cardId, { columnId, cardId, messageId, buffer: delta })
      }

      if (deltaFlushHandleRef.current === null) {
        deltaFlushHandleRef.current = window.requestAnimationFrame(flushDeltaBuffer)
      }
    },
    [flushDeltaBuffer],
  )

  const attachStream = useCallback(
    function attachStreamToCard(columnId: string, card: ChatCard) {
      if (!card.streamId) {
        return
      }

      const existing = activeStreamsRef.current.get(card.id)
      if (existing?.streamId === card.streamId) {
        return
      }

      if (existing) {
        existing.source.close()
        activeStreamsRef.current.delete(card.id)
      }

      const source = openChatStream(card.streamId, {
        onSession: ({ sessionId }) => {
          if (shouldResetStreamRecoveryAttemptsForActivity('session')) {
            streamRetryCountRef.current.delete(card.id)
          }
          persistImmediately(
            applyAction({
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: { sessionId },
            }),
          )
        },
        onDelta: ({ content }) => {
          const messageId = ensureAssistantMessage(
            columnId,
            card.id,
            card.provider,
            card.streamId!,
            source,
          )

          if (shouldResetStreamRecoveryAttemptsForText(content)) {
            streamRetryCountRef.current.delete(card.id)
          }
          enqueueAssistantDelta(columnId, card.id, messageId, content)
        },
        onLog: ({ message }) => {
          const messages = createLogMessages(card.provider, message)
          if (messages.length === 0) {
            return
          }

          if (shouldResetStreamRecoveryAttemptsForActivity('log')) {
            streamRetryCountRef.current.delete(card.id)
          }
          applyAction({
            type: 'appendMessages',
            columnId,
            cardId: card.id,
            messages,
          })
        },
        onAssistantMessage: (payload) => {
          if (
            shouldResetStreamRecoveryAttemptsForActivity('assistant_message') &&
            shouldResetStreamRecoveryAttemptsForText(payload.content)
          ) {
            streamRetryCountRef.current.delete(card.id)
          }
          const active = activeStreamsRef.current.get(card.id)
          const buffered = deltaBufferRef.current.get(card.id)
          if (buffered && buffered.messageId === active?.assistantMessageId) {
            deltaBufferRef.current.delete(card.id)
          }

          const liveCard = getColumn(columnId)?.cards[card.id]
          const nextMessages = liveCard
            ? finalizeStreamedAssistantMessage(
                liveCard.messages,
                active?.assistantMessageId,
                card.provider,
                card.streamId!,
                payload,
              )
            : null

          if (nextMessages) {
            applyAction({
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: {
                messages: nextMessages,
              },
            })
            return
          }

          applyAction({
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
              ),
            },
          })
        },
        onActivity: (payload) => {
          if (shouldResetStreamRecoveryAttemptsForActivity('activity')) {
            streamRetryCountRef.current.delete(card.id)
          }

          // Clear the current assistant message so that any subsequent onDelta
          // (the agent's final answer after tool calls) creates a new message
          // instead of appending to the one that sits *before* the tool calls.
          const active = activeStreamsRef.current.get(card.id)
          const streamingMessageId = active?.assistantMessageId
          if (active) {
            activeStreamsRef.current.set(card.id, {
              ...active,
              assistantMessageId: undefined,
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

            applyAction({
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
            })
            return
          }

          if (payload.kind === 'ask-user') {
            const liveCard = getColumn(columnId)?.cards[card.id]

            applyAction({
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: {
                messages: finalizeStructuredActivityMessage(
                  liveCard?.messages ?? [],
                  streamingMessageId,
                  card.provider,
                  card.streamId!,
                  payload,
                ),
              },
            })

            // When ExitPlanMode provides a plan file, open it as a TextEditor card
            if (payload.planFile) {
              const col = getColumnById(appStateRef.current.columns, columnId)
              const sourcePane = col ? findPaneForTab(col.layout, card.id) : null
              if (sourcePane) {
                openTextEditorTab(columnId, sourcePane.id, payload.planFile, 'Plan')
              }
            }

            return
          }

          applyAction({
            type: 'upsertMessages',
            columnId,
            cardId: card.id,
            messages: [createStructuredActivityMessage(card.provider, card.streamId!, payload)],
          })
        },
        onDone: ({ stopped }) => {
          source.close()
          activeStreamsRef.current.delete(card.id)
          streamRetryCountRef.current.delete(card.id)
          queueFollowUpDuringStreamRef.current.delete(card.id)
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

          const liveColumn = getColumn(columnId)
          const unread =
            liveColumn
              ? shouldMarkCardUnreadOnStreamDone(
                  liveColumn.layout,
                  card.id,
                  appStateRef.current.settings.activeTopTab === 'ambience',
                )
              : true

          const liveCard = getColumn(columnId)?.cards[card.id]
          const pendingCompactBoundary = liveCard
            ? getPendingCompactBoundaryMessage(liveCard.messages)
            : null
          const actions: IdeAction[] = [
            {
              type: 'updateCard',
              columnId,
              cardId: card.id,
              patch: { status: 'idle', streamId: undefined, unread },
            },
          ]

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

          if (stopped) {
            actions.push({
              type: 'appendMessages',
              columnId,
              cardId: card.id,
              messages: [createStoppedRunMessage(appStateRef.current.settings.language, stoppedRunReason)],
            })
          }

          // Collect all file edits from this conversation and append a changes summary
          if (liveCard && !stopped) {
            const summaryFiles = collectChangesSummaryFilesForStream(
              liveCard.messages,
              card.provider,
              card.streamId!,
            )

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

          persistImmediately(applyActions(actions))
          dispatchNextQueuedSend(columnId, card.id)
        },
        onError: ({ message, recoverable, recoveryMode, transientOnly, hint }) => {
          source.close()
          activeStreamsRef.current.delete(card.id)
          if (card.streamId) {
            stoppedRunReasonRef.current.delete(card.streamId)
          }

          if (recoverable) {
            const retryCount = streamRetryCountRef.current.get(card.id) ?? 0

            if (retryCount < 6) {
              const shouldCountAgainstBudget = transientOnly !== true
              if (shouldCountAgainstBudget) {
                streamRetryCountRef.current.set(card.id, retryCount + 1)
              }

              window.setTimeout(() => {
                const liveCard = getColumn(columnId)?.cards[card.id]
                if (liveCard && liveCard.streamId === card.streamId) {
                  const nextRecoveryMode = resolveStreamRecoveryMode(
                    {
                      recoverable,
                      recoveryMode,
                    },
                    typeof liveCard.sessionId === 'string' && liveCard.sessionId.trim().length > 0,
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
          queueFollowUpDuringStreamRef.current.delete(card.id)

          // Stream expired or server restarted — gracefully return to idle
          // so the user can continue chatting with their existing messages.
          if (message === 'Stream not found.') {
            const liveCard = getColumn(columnId)?.cards[card.id]
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

            if (pendingCompactBoundary) {
              actions.unshift({
                type: 'upsertMessages',
                columnId,
                cardId: card.id,
                messages: [clearPendingCompactBoundaryMessage(pendingCompactBoundary)],
              })
            }

            persistImmediately(applyActions(actions))
            dispatchNextQueuedSend(columnId, card.id)
            return
          }

          if (hint === 'switch-config' || hint === 'env-setup') {
            openRemediationPanel(card.provider, hint)
          }
          const liveCard = getColumn(columnId)?.cards[card.id]
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

          if (pendingCompactBoundary) {
            actions.unshift({
              type: 'upsertMessages',
              columnId,
              cardId: card.id,
              messages: [clearPendingCompactBoundaryMessage(pendingCompactBoundary)],
            })
          }

          persistImmediately(applyActions(actions))
          dispatchNextQueuedSend(columnId, card.id)
        },
      })

      activeStreamsRef.current.set(card.id, {
        cardId: card.id,
        streamId: card.streamId,
        source,
      })
    },
    [
      applyAction,
      applyActions,
      dispatchNextQueuedSend,
      enqueueAssistantDelta,
      ensureAssistantMessage,
      getColumn,
      openTextEditorTab,
      openRemediationPanel,
      persistImmediately,
    ],
  )

  const clearTransientRuntimeState = useCallback(() => {
    activeStreamsRef.current.forEach((stream) => {
      stream.source.close()
    })
    activeStreamsRef.current.clear()
    queuedSendRequestsRef.current.clear()
    queueFollowUpDuringStreamRef.current.clear()
    stoppedRunReasonRef.current.clear()
    streamRetryCountRef.current.clear()
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
      setProviders([])

      void providersPromise.then((nextProviders) => {
        if (hydrateRequestIdRef.current !== requestId || !nextProviders) {
          return
        }

        setProviders(nextProviders)
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
  }, [attachStreamsForState, clearTransientRuntimeState, commitLoadedState])

  useEffect(() => {
    void hydrate()
    const activeStreams = activeStreamsRef.current
    const retryCounts = streamRetryCountRef.current

    return () => {
      activeStreams.forEach((stream) => {
        stream.source.close()
      })
      activeStreams.clear()
      retryCounts.clear()
    }
  }, [hydrate])

  useEffect(() => {
    setResolvedTheme(getResolvedAppTheme(appState.settings.theme))

    if (appState.settings.theme !== 'system') {
      return
    }

    return subscribeToSystemThemeChange(() => {
      setResolvedTheme(getResolvedAppTheme('system'))
    })
  }, [appState.settings.theme])

  useEffect(() => {
    const root = document.documentElement
    root.lang = appState.settings.language
    root.dataset.theme = resolvedTheme
    root.style.setProperty('--ui-font-scale', appState.settings.fontScale.toFixed(2))
    root.style.setProperty('--ui-line-height-scale', appState.settings.lineHeightScale.toFixed(2))
  }, [appState.settings.fontScale, appState.settings.language, appState.settings.lineHeightScale, resolvedTheme])

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
    if (activeTab === 'ambience') {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
      applyActions(actions)
    }
  }, [activeTab, appState.columns, applyActions])

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
          const availableModelOptions = getModelOptions(card.provider).filter((option) =>
            isQuickToolModelEnabled(settings, option.model),
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

          persistImmediately(
            applyActions([
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
            ]),
          )
          return true
        }
        case 'clear':
        case 'new': {
          await closeStream(card.id, true)
          clearQueuedSends(card.id)
          persistImmediately(
            applyAction({
              type: 'resetCardConversation',
              columnId,
              cardId: card.id,
            }),
          )
          return true
        }
        default:
          return false
      }
    },
    [appendCardLogs, applyAction, applyActions, clearQueuedSends, closeStream, getColumn, persistImmediately, providerByName],
  )

  const sendMessage = async (
    columnId: string,
    cardId: string,
    prompt: string,
    attachments: ImageAttachment[],
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
    const parsedSlashCommand = parseSlashCommandInput(prompt)

    if (attachments.length === 0 && (await handleLocalSlashCommand(columnId, card, prompt))) {
      return
    }


    if (card.status === 'streaming') {
      const latestUserMessage = [...card.messages].reverse().find((message) => message.role === 'user')
      const shouldQueueUntilDone =
        queueFollowUpDuringStreamRef.current.get(cardId) === true ||
        isCompactBoundaryMessage(latestUserMessage, card.provider)
      enqueueQueuedSend(cardId, { prompt, attachments })
      if (!shouldQueueUntilDone) {
        await requestStopForCard(cardId, 'user-interrupt')
      }
      return
    }

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
    const baseUserMessage = isManualCodexCompactRequest
      ? markCompactBoundaryMessage(
          createMessage('user', '/compact', attachImagesToMessageMeta(attachments)),
          { pending: true },
        )
      : markCompactBoundaryMessage(
          createMessage('user', prompt, attachImagesToMessageMeta(attachments)),
        )
    const language = appStateRef.current.settings.language
    const seedsTranscript = hasSeededChatTranscript(card)
    const seededRequestPrompt = seedsTranscript
      ? buildSeededChatPrompt({
          language,
          prompt,
          attachments,
          messages: card.messages,
          provider: card.provider,
          status: card.status,
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

    if (!providerStatus?.available) {
      persistImmediately(
        applyActions([
          {
            type: 'appendMessages',
            columnId,
            cardId,
            messages: [baseUserMessage, createMessage('system', text.localCliUnavailable)],
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
        ]),
      )
      return
    }

    const userMessage = baseUserMessage
    let requestPrompt = seededRequestPrompt
    let requestAttachments = seededRequestAttachments
    const requestMessages = [userMessage]

    if (isManualCodexCompactRequest) {
      requestPrompt = '/compact'
      requestAttachments = []
    }

    const streamId = crypto.randomUUID()
    queueFollowUpDuringStreamRef.current.set(cardId, isCompactBoundaryMessage(userMessage, card.provider))
    persistImmediately(
      applyActions([
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
          },
        },
      ]),
    )

    try {
      const composedSystemPrompt = buildSystemPromptForModel(
        appStateRef.current.settings.systemPrompt,
        resolvedModel,
        appStateRef.current.settings.modelPromptRules,
      )
      const response = await requestChat({
        provider: card.provider,
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
        sessionId: card.sessionId,
        prompt: requestPrompt,
        attachments: requestAttachments,
        archiveRecall,
      })

      if (response.streamId !== streamId) {
        persistImmediately(
          applyAction({
            type: 'updateCard',
            columnId,
            cardId,
            patch: { streamId: response.streamId },
          }),
        )
      }

      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return
      }

      attachStream(columnId, liveCard)
    } catch (error) {
      queueFollowUpDuringStreamRef.current.delete(cardId)
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

      if (isManualCodexCompactRequest) {
        actions.unshift({
          type: 'upsertMessages',
          columnId,
          cardId,
          messages: [clearPendingCompactBoundaryMessage(userMessage)],
        })
      }

      persistImmediately(applyActions(actions))
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

    const resumeRequest = getInterruptedSessionResumeRequest({
      sessionId: card.sessionId ?? entry.sessionId,
      resumeMode: entry.resumeMode,
      resumePrompt: entry.resumePrompt,
      resumeAttachments: entry.resumeAttachments,
    })

    if (!column.workspacePath.trim() || !resumeRequest) {
      persistImmediately(
        applyAction({
          type: 'updateCard',
          columnId,
          cardId,
          patch: { status: 'idle', streamId: undefined },
        }),
      )
      return
    }

    const providerStatus = providerByName[card.provider] as ProviderStatus | undefined
    const resolvedModel = normalizeModel(
      card.provider,
      card.model || appStateRef.current.settings.requestModels[card.provider],
    )
    const resolvedReasoningEffort = normalizeReasoningEffort(card.provider, card.reasoningEffort)

    if (!providerStatus?.available) {
      persistImmediately(
        applyActions([
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
        ]),
      )
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
    persistImmediately(
      applyAction({
        type: 'updateCard',
        columnId,
        cardId,
        patch: {
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          status: 'streaming',
          streamId,
        },
      }),
    )

    try {
      const composedSystemPrompt = buildSystemPromptForModel(
        appStateRef.current.settings.systemPrompt,
        resolvedModel,
        appStateRef.current.settings.modelPromptRules,
      )
      const response = await requestChat({
        provider: card.provider,
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
        prompt: resumeRequest.prompt,
        attachments: resumeRequest.attachments,
        archiveRecall,
      })

      if (response.streamId !== streamId) {
        persistImmediately(
          applyAction({
            type: 'updateCard',
            columnId,
            cardId,
            patch: { streamId: response.streamId },
          }),
        )
      }

      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return
      }

      attachStream(columnId, liveCard)
    } catch (error) {
      persistImmediately(
        applyActions([
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
        ]),
      )
    }
  }, [
    applyAction,
    applyActions,
    attachStream,
    getColumn,
    persistImmediately,
    providerByName,
    text.localCliUnavailable,
    text.unexpectedError,
  ])

  const recoverLiveStream = useCallback(async (columnId: string, cardId: string) => {
    const column = getColumn(columnId)
    const card = column?.cards[cardId]

    if (!column || !card || !column.workspacePath.trim() || !card.sessionId) {
      return false
    }

    const providerStatus = providerByName[card.provider] as ProviderStatus | undefined
    const resolvedModel = normalizeModel(
      card.provider,
      card.model || appStateRef.current.settings.requestModels[card.provider],
    )
    const resolvedReasoningEffort = normalizeReasoningEffort(card.provider, card.reasoningEffort)

    if (!providerStatus?.available) {
      persistImmediately(
        applyActions([
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
        ]),
      )
      return false
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
    persistImmediately(
      applyAction({
        type: 'updateCard',
        columnId,
        cardId,
        patch: {
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          status: 'streaming',
          streamId,
        },
      }),
    )

    try {
      const composedSystemPrompt = buildSystemPromptForModel(
        appStateRef.current.settings.systemPrompt,
        resolvedModel,
        appStateRef.current.settings.modelPromptRules,
      )
      const response = await requestChat({
        provider: card.provider,
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
        sessionId: card.sessionId,
        prompt: '',
        attachments: [],
        archiveRecall,
      })

      if (response.streamId !== streamId) {
        persistImmediately(
          applyAction({
            type: 'updateCard',
            columnId,
            cardId,
            patch: { streamId: response.streamId },
          }),
        )
      }

      const liveCard = getColumn(columnId)?.cards[cardId]
      if (!liveCard || liveCard.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return false
      }

      attachStream(columnId, liveCard)
      return true
    } catch (error) {
      persistImmediately(
        applyActions([
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
        ]),
      )
      return false
    }
  }, [
    applyAction,
    applyActions,
    attachStream,
    getColumn,
    persistImmediately,
    providerByName,
    text.localCliUnavailable,
    text.unexpectedError,
  ])
  recoverLiveStreamRef.current = recoverLiveStream

  const closeTab = async (columnId: string, paneId: string, cardId: string) => {
    clearQueuedSends(cardId)
    await closeStream(cardId, true)
    const column = appStateRef.current.columns.find((entry) => entry.id === columnId)
    const card = column?.cards[cardId]

    if (card?.model === FILETREE_TOOL_MODEL) {
      clearFileTreeCacheForCard(cardId)
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

  const removeColumn = async (columnId: string) => {
    const column = getColumn(columnId)
    if (!column) {
      return
    }

    getOrderedColumnCards(column).forEach((card) => clearQueuedSends(card.id))
    await Promise.all(getOrderedColumnCards(column).map((card) => closeStream(card.id, true)))
    applyAction({ type: 'removeColumn', columnId })
  }

  const stopCard = async (cardId: string) => {
    await requestStopForCard(cardId, 'manual')
  }


  const handleReset = async () => {
    await Promise.all([...activeStreamsRef.current.keys()].map((cardId) => closeStream(cardId, true)))
    queuedSendRequestsRef.current.clear()
    queueFollowUpDuringStreamRef.current.clear()

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
        const paneId = resolveColumnPaneTarget(columnId)
        const response = await loadSessionHistoryEntry({ entryId })
        const nextState = applyActions([
          {
            type: 'importExternalSession',
            columnId,
            paneId,
            entry: response.entry,
          },
          {
            type: 'removeSessionHistory',
            entryIds: [entryId],
          },
        ])

        persistImmediately(nextState)
        updateLatestKnownAppState(nextState)
      } catch (error) {
        console.error('[history] Failed to restore archived session.', error)
      }
    })()
  }, [applyActions, persistImmediately, resolveColumnPaneTarget])

  const handleDismissInterruptedSessions = useCallback(() => {
    if (!interruptedSessionRecovery) {
      return
    }

    setInterruptedSessionActionPending(true)
    setInterruptedSessionActionError(null)

    try {
      const nextState = applyActions(
        interruptedSessionRecovery.entries.map((entry) => ({
          type: 'updateCard' as const,
          columnId: entry.columnId,
          cardId: entry.cardId,
          patch: { status: 'idle' as const, streamId: undefined },
        })),
      )
      persistImmediately(nextState)
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
    persistImmediately,
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
        const nextState = applyActions(
          unrecoverableEntries.map((entry) => ({
            type: 'updateCard' as const,
            columnId: entry.columnId,
            cardId: entry.cardId,
            patch: { status: 'idle' as const, streamId: undefined },
          })),
        )
        persistImmediately(nextState)
        updateLatestKnownAppState(nextState)
      }

      for (const entry of interruptedSessionRecovery.entries) {
        if (!entry.recoverable) {
          continue
        }

        await resumeInterruptedSession(entry)
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
    persistImmediately,
    resumeInterruptedSession,
  ])

  const handleRunSetup = useCallback(async () => {
    setSettingsNotice(null)
    setSetupStatusPending(true)

    try {
      setSetupStatus(await runEnvironmentSetup())
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
  }, [syncProviderStatuses, text.unexpectedError])

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
            : onboardingStatus?.environment.checks.some((check) => !check.available)
              ? panelText.setupDetectedMissing
              : setupStatus
                ? panelText.setupIdle
                : panelText.setupLoading
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
    Boolean(onboardingStatus) && !onboardingStatusPending && !onboardingEnvironmentReady && hasMissingEnvironmentChecks
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

  const renderThemeToggle = () => {
    const themeOptions: Array<{ value: AppState['settings']['theme']; label: string }> = [
      { value: 'light', label: text.light },
      { value: 'dark', label: text.dark },
      { value: 'system', label: text.systemTheme },
    ]

    return (
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
            <AppButton tone="primary" type="button" onClick={() => void hydrate()}>
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
                fontScale: 1,
                lineHeightScale: 1,
                theme: 'light',
              },
            })
          }
        >
          {text.resetInterfaceDefaults}
        </AppButton>
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
            placeholder="gpt-5.4 xhigh"
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
            <AppButton
              tone="primary"
              type="button"
              disabled={setupStatusPending || setupStatus?.state === 'running'}
              onClick={() => void handleRunSetup()}
            >
              {hasRunSetup ? panelText.rerunSetup : panelText.installMissingTools}
            </AppButton>
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
          </div>

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
                        fontScale: 1,
                        lineHeightScale: 1,
                        theme: 'light',
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
                    placeholder="gpt-5.4 xhigh"
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
                    <AppButton
                      tone="primary"
                      type="button"
                      disabled={setupStatusPending || setupStatus?.state === 'running'}
                      onClick={() => void handleRunSetup()}
                    >
                      {hasRunSetup ? panelText.rerunSetup : panelText.installMissingTools}
                    </AppButton>
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
              applyAction({ type: 'updateCard', columnId: column.id, cardId, patch: { unread: false } })
            }
            onChangeCardDraft={(cardId, draft) => {
              const currentDraft = column.cards[cardId]?.draft ?? ''
              if (currentDraft === draft) {
                return
              }

              const nextState = applyAction({ type: 'setCardDraft', columnId: column.id, cardId, draft })

              // Keep send/clear flows durable immediately, but let active typing
              // reuse the queued persistence path to avoid synchronous full-state saves.
              if (draft.length === 0) {
                persistImmediately(nextState)
              }
            }}
            onChangeCardStickyNote={(cardId, content) =>
              applyAction({ type: 'updateCard', columnId: column.id, cardId, patch: { stickyNote: content } })
            }
            onPatchCard={(cardId, patch) =>
              applyAction({ type: 'updateCard', columnId: column.id, cardId, patch })
            }
            onChangeCardTitle={(cardId, title) =>
              applyAction({ type: 'updateCard', columnId: column.id, cardId, patch: { title } })
            }
            onReorderColumn={(sourceColumnId, targetColumnId, placement) =>
              applyAction({
                type: 'reorderColumn',
                sourceColumnId,
                targetColumnId,
                placement,
              })
            }
            onRemoveColumn={() => void removeColumn(column.id)}
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
            onSendMessage={(cardId, prompt, attachments) =>
              sendMessage(column.id, cardId, prompt, attachments)
            }
            onStopMessage={(cardId) => stopCard(cardId)}
            onForkConversation={(cardId, messageId) =>
              dispatch({ type: 'forkConversation', columnId: column.id, cardId, messageId })
            }
            onOpenFile={(paneId, relativePath) => {
              const fileName = relativePath.split('/').pop() ?? relativePath
              openTextEditorTab(column.id, paneId, relativePath, fileName)
            }}
            recentWorkspaces={appState.settings.recentWorkspaces}
            onRecordRecentWorkspace={(path) => applyAction({ type: 'recordRecentWorkspace', path })}
            onRemoveRecentWorkspaces={(paths) => applyAction({ type: 'removeRecentWorkspaces', paths })}
            sessionHistory={sessionHistory}
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

      {renderModelPromptRulesDialog()}
    </div>,
  )
}

export default App
