import {
  appSettingsSchema,
  attachmentUploadRequestSchema,
  appStateLoadResponseSchema,
  appStateSchema,
  ccSwitchImportRequestSchema,
  ccSwitchImportResponseSchema,
  externalHistoryListRequestSchema,
  externalHistoryListResponseSchema,
  externalSessionLoadRequestSchema,
  externalSessionLoadResponseSchema,
  internalSessionHistoryLoadRequestSchema,
  internalSessionHistoryLoadResponseSchema,
  chatStartResponseSchema,
  gitCommitAllRequestSchema,
  gitCommitDiffRequestSchema,
  gitCommitDiffResponseSchema,
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitLogRequestSchema,
  gitLogResponseSchema,
  gitOperationResponseSchema,
  gitPullRequestSchema,
  gitPushRequestSchema,
  gitStageRequestSchema,
  gitStatusSchema,
  fileCreateRequestSchema,
  fileDeleteRequestSchema,
  fileMoveRequestSchema,
  fileRenameRequestSchema,
  fileSearchRequestSchema,
  fileSearchResponseSchema,
  imageAttachmentSchema,
  onboardingStatusSchema,
  providerStatusSchema,
  recentCrashRecoverySchema,
  rendererCrashCaptureRequestSchema,
  slashCommandRequestSchema,
  slashCommandSchema,
  setupStatusSchema,
  stateRecoverySelectionSchema,
  type AppStateLoadResponse,
  type AppSettings,
  type AppState,
  type AttachmentUploadRequest,
  type CcSwitchImportRequest,
  type CcSwitchImportResponse,
  type ChatRequest,
  type ChatStartResponse,
  type ExternalHistoryListRequest,
  type ExternalHistoryListResponse,
  type ExternalSessionLoadRequest,
  type ExternalSessionLoadResponse,
  type InternalSessionHistoryLoadRequest,
  type InternalSessionHistoryLoadResponse,
  type GitCommitAllRequest,
  type GitCommitDiffRequest,
  type GitCommitDiffResponse,
  type GitCommitRequest,
  type GitCommitResponse,
  type GitLogRequest,
  type GitLogResponse,
  type GitOperationResponse,
  type GitPullRequest,
  type GitPushRequest,
  type GitStageRequest,
  type GitStatus,
  type FileCreateRequest,
  type FileDeleteRequest,
  type FileMoveRequest,
  type FileSearchEntry,
  type FileRenameRequest,
  type ImageAttachment,
  type OnboardingStatus,
  type ProviderStatus,
  type RecentCrashRecovery,
  type RendererCrashCaptureRequest,
  type SetupStatus,
  type SlashCommand,
  type SlashCommandRequest,
  type StateRecoverySelection,
  type StreamEventMap,
} from '../shared/schema'

type StreamHandlers = {
  onSession?: (payload: StreamEventMap['session']) => void
  onDelta?: (payload: StreamEventMap['delta']) => void
  onLog?: (payload: StreamEventMap['log']) => void
  onAssistantMessage?: (payload: StreamEventMap['assistant_message']) => void
  onActivity?: (payload: StreamEventMap['activity']) => void
  onStats?: (payload: StreamEventMap['stats']) => void
  onDone?: (payload: StreamEventMap['done']) => void
  onError?: (payload: StreamEventMap['error'] & { recoverable?: boolean; transientOnly?: boolean }) => void
}

export type ChatStreamSource = {
  close: () => void
}

const desktopBridgeUnavailableMessage = 'Electron desktop bridge is unavailable.'

const getDesktopApi = () =>
  typeof window !== 'undefined' ? window.electronAPI : undefined

const requireDesktopAction = <T extends (...args: never[]) => unknown>(
  action: T | undefined,
) => {
  if (typeof action !== 'function') {
    throw new Error(desktopBridgeUnavailableMessage)
  }

  return action
}

const readDesktop = async <T>(
  action: () => Promise<unknown>,
  parser: { parse: (value: unknown) => T },
) => {
  try {
    return parser.parse(await action())
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

const desktopAppStateLoadResponseSchema = appStateLoadResponseSchema.or(appStateSchema).transform((value) =>
  'state' in value
    ? value
    : {
        state: value,
        recovery: {
          startup: null,
          recentCrash: null,
          interruptedSessions: null,
        },
      },
)

export const fetchState = async (): Promise<AppStateLoadResponse> =>
  readDesktop(requireDesktopAction(getDesktopApi()?.fetchState), desktopAppStateLoadResponseSchema)

export const loadSessionHistoryEntry = async (
  request: InternalSessionHistoryLoadRequest,
): Promise<InternalSessionHistoryLoadResponse> => {
  const parsed = internalSessionHistoryLoadRequestSchema.parse(request)
  const fn = requireDesktopAction(getDesktopApi()?.loadSessionHistoryEntry)

  return readDesktop(() => fn(parsed), internalSessionHistoryLoadResponseSchema)
}

export const saveState = async (state: AppState): Promise<AppState> => {
  const desktopSaveState = requireDesktopAction(getDesktopApi()?.saveState)

  return readDesktop(() => desktopSaveState(state), appStateSchema)
}

export const syncRuntimeSettings = async (settings: AppSettings): Promise<void> => {
  const parsed = appSettingsSchema.parse(settings)
  const fn = requireDesktopAction(getDesktopApi()?.syncRuntimeSettings)
  return fn(parsed) as Promise<void>
}

export const queueStateSave = (state: AppState) => {
  const queue = requireDesktopAction(getDesktopApi()?.queueStateSave)
  queue(state)
  return true
}

export const resetState = async (): Promise<AppState> =>
  readDesktop(requireDesktopAction(getDesktopApi()?.resetState), appStateSchema)

export const resolveStateRecoveryOption = async (
  request: StateRecoverySelection,
): Promise<AppStateLoadResponse> => {
  const parsed = stateRecoverySelectionSchema.parse(request)
  const fn = requireDesktopAction(getDesktopApi()?.resolveStateRecoveryOption)

  return readDesktop(() => fn(parsed), appStateLoadResponseSchema)
}

export const captureRendererCrash = async (
  request: RendererCrashCaptureRequest,
): Promise<RecentCrashRecovery | null> => {
  const parsed = rendererCrashCaptureRequestSchema.parse(request)
  const fn = requireDesktopAction(getDesktopApi()?.captureRendererCrash)

  return readDesktop(() => fn(parsed), recentCrashRecoverySchema.nullable())
}

export const dismissRecentCrashRecovery = async () => {
  const fn = requireDesktopAction(getDesktopApi()?.dismissRecentCrashRecovery)
  await fn()
}

export const minimizeWindow = async () => {
  const fn = requireDesktopAction(getDesktopApi()?.minimizeWindow)
  await fn()
}

export const toggleMaximizeWindow = async (): Promise<boolean> => {
  const fn = requireDesktopAction(getDesktopApi()?.toggleMaximizeWindow)
  return Boolean(await fn())
}

export const closeWindow = async () => {
  const fn = requireDesktopAction(getDesktopApi()?.closeWindow)
  await fn()
}

export const flashWindowOnce = async (): Promise<boolean> => {
  const fn = getDesktopApi()?.flashWindowOnce

  if (typeof fn !== 'function') {
    return false
  }

  return Boolean(await fn())
}

export const isWindowMaximized = async (): Promise<boolean> => {
  const fn = requireDesktopAction(getDesktopApi()?.isWindowMaximized)
  return Boolean(await fn())
}

export const onWindowMaximizedChanged = (listener: (maximized: boolean) => void) => {
  const fn = requireDesktopAction(getDesktopApi()?.onWindowMaximizedChanged)
  return fn(listener) as () => void
}

export const openMessageLocalLink = async (href: string, workspacePath?: string) => {
  const fn = requireDesktopAction(getDesktopApi()?.openMessageLocalLink)
  await fn(href, workspacePath)
}

export const openExternalLink = async (href: string) => {
  const fn = requireDesktopAction(getDesktopApi()?.openExternalLink)
  await fn(href)
}

export const fetchProviders = async (): Promise<ProviderStatus[]> =>
  readDesktop(requireDesktopAction(getDesktopApi()?.fetchProviders), providerStatusSchema.array())

export const importCcSwitchRouting = async (
  request: CcSwitchImportRequest,
): Promise<CcSwitchImportResponse> => {
  const parsed = ccSwitchImportRequestSchema.parse(request)
  const desktopImport = requireDesktopAction(getDesktopApi()?.importCcSwitchRouting)

  return readDesktop(() => desktopImport(parsed), ccSwitchImportResponseSchema)
}

export const listExternalHistory = async (
  request: ExternalHistoryListRequest,
): Promise<ExternalHistoryListResponse> => {
  const parsed = externalHistoryListRequestSchema.parse(request)
  const fn = requireDesktopAction(getDesktopApi()?.listExternalHistory)

  return readDesktop(() => fn(parsed), externalHistoryListResponseSchema)
}

export const loadExternalSession = async (
  request: ExternalSessionLoadRequest,
): Promise<ExternalSessionLoadResponse> => {
  const parsed = externalSessionLoadRequestSchema.parse(request)
  const fn = requireDesktopAction(getDesktopApi()?.loadExternalSession)

  return readDesktop(() => fn(parsed), externalSessionLoadResponseSchema)
}

export const fetchSetupStatus = async (): Promise<SetupStatus> =>
  readDesktop(requireDesktopAction(getDesktopApi()?.fetchSetupStatus), setupStatusSchema)

export const runEnvironmentSetup = async (): Promise<SetupStatus> =>
  readDesktop(requireDesktopAction(getDesktopApi()?.runEnvironmentSetup), setupStatusSchema)

export const fetchOnboardingStatus = async (): Promise<OnboardingStatus> =>
  readDesktop(requireDesktopAction(getDesktopApi()?.fetchOnboardingStatus), onboardingStatusSchema)

export const fetchGitStatus = async (workspacePath: string): Promise<GitStatus> => {
  const desktopFetchGitStatus = requireDesktopAction(getDesktopApi()?.fetchGitStatus)

  return readDesktop(() => desktopFetchGitStatus(workspacePath), gitStatusSchema)
}

export const setGitStage = async (request: GitStageRequest): Promise<GitStatus> => {
  const parsed = gitStageRequestSchema.parse(request)
  const desktopSetGitStage = requireDesktopAction(getDesktopApi()?.setGitStage)

  return readDesktop(() => desktopSetGitStage(parsed), gitStatusSchema)
}

export const initGitWorkspace = async (request: GitPullRequest): Promise<GitOperationResponse> => {
  const parsed = gitPullRequestSchema.parse(request)
  const desktopInitGitWorkspace = requireDesktopAction(getDesktopApi()?.initGitWorkspace)

  return readDesktop(() => desktopInitGitWorkspace(parsed), gitOperationResponseSchema)
}

export const commitGitChanges = async (
  request: GitCommitRequest,
): Promise<GitCommitResponse> => {
  const parsed = gitCommitRequestSchema.parse(request)
  const desktopCommitGitChanges = requireDesktopAction(getDesktopApi()?.commitGitChanges)

  return readDesktop(() => desktopCommitGitChanges(parsed), gitCommitResponseSchema)
}

export const pullGitChanges = async (request: GitPullRequest): Promise<GitOperationResponse> => {
  const parsed = gitPullRequestSchema.parse(request)
  const desktopPullGitChanges = requireDesktopAction(getDesktopApi()?.pullGitChanges)

  return readDesktop(() => desktopPullGitChanges(parsed), gitOperationResponseSchema)
}

export const pushGitChanges = async (request: GitPushRequest): Promise<GitOperationResponse> => {
  const parsed = gitPushRequestSchema.parse(request)
  const desktopPushGitChanges = requireDesktopAction(getDesktopApi()?.pushGitChanges)

  return readDesktop(() => desktopPushGitChanges(parsed), gitOperationResponseSchema)
}

export const commitAllGitChanges = async (
  request: GitCommitAllRequest,
): Promise<GitCommitResponse> => {
  const parsed = gitCommitAllRequestSchema.parse(request)
  const desktopCommitAllGitChanges = requireDesktopAction(getDesktopApi()?.commitAllGitChanges)

  return readDesktop(() => desktopCommitAllGitChanges(parsed), gitCommitResponseSchema)
}

export const fetchGitLog = async (request: GitLogRequest): Promise<GitLogResponse> => {
  const parsed = gitLogRequestSchema.parse(request)
  const desktopFetchGitLog = requireDesktopAction(getDesktopApi()?.fetchGitLog)

  return readDesktop(() => desktopFetchGitLog(parsed), gitLogResponseSchema)
}

export const fetchCommitDiff = async (
  request: GitCommitDiffRequest,
): Promise<GitCommitDiffResponse> => {
  const parsed = gitCommitDiffRequestSchema.parse(request)
  const desktopFetchCommitDiff = requireDesktopAction(getDesktopApi()?.fetchCommitDiff)

  return readDesktop(() => desktopFetchCommitDiff(parsed), gitCommitDiffResponseSchema)
}

const slashCommandCache = new Map<string, Promise<SlashCommand[]>>()
const slashCommandCacheTtlMs = 5_000

export const fetchSlashCommands = async (request: SlashCommandRequest): Promise<SlashCommand[]> => {
  const parsed = slashCommandRequestSchema.parse(request)
  const cacheBucket = Math.floor(Date.now() / slashCommandCacheTtlMs)
  const cacheKey = `${parsed.provider}:${parsed.workspacePath}:${parsed.language}:${parsed.crossProviderSkillReuseEnabled}:${cacheBucket}`
  const cached = slashCommandCache.get(cacheKey)

  if (cached) {
    return cached
  }

  const promise = (async () => {
    const desktopFetchSlashCommands = requireDesktopAction(getDesktopApi()?.fetchSlashCommands)

    return readDesktop(
      () => desktopFetchSlashCommands(parsed),
      slashCommandSchema.array(),
    )
  })().catch((error) => {
    slashCommandCache.delete(cacheKey)
    throw error
  })

  for (const key of slashCommandCache.keys()) {
    if (key !== cacheKey) {
      slashCommandCache.delete(key)
    }
  }
  slashCommandCache.set(cacheKey, promise)
  return promise
}

export const requestChat = async (request: ChatRequest): Promise<ChatStartResponse> => {
  const desktopRequestChat = requireDesktopAction(getDesktopApi()?.requestChat)

  return readDesktop(() => desktopRequestChat(request), chatStartResponseSchema)
}

export const uploadImageAttachment = async (
  request: AttachmentUploadRequest,
): Promise<ImageAttachment> => {
  const parsed = attachmentUploadRequestSchema.parse(request)
  const desktopUploadImageAttachment = requireDesktopAction(getDesktopApi()?.uploadImageAttachment)

  return readDesktop(() => desktopUploadImageAttachment(parsed), imageAttachmentSchema)
}

export const stopChat = async (streamId: string) => {
  const stop = requireDesktopAction(getDesktopApi()?.stopChat)
  await stop(streamId)
}

// ── Music API ──────────────────────────────────────────────────────────────────

export type MusicLoginStatus = {
  authenticated: boolean
  userId: number
  nickname: string
  avatarUrl: string
}

export type MusicQrLoginResult = { key: string; qrUrl: string; qrImage: string }

export type MusicQrCheckResult = {
  status: 'waiting' | 'confirm' | 'expired' | 'authorized'
  message: string
  cookie: string
  userId?: number
  nickname?: string
  avatarUrl?: string
}

export type MusicPlaylistSummary = {
  id: number
  sourcePlaylistId: number
  name: string
  trackCount: number
  coverUrl: string
  specialType: number
  subscribed: boolean
  creatorId: number
  creatorName: string
  description: string
  playCount: number
  copywriter: string
  exploreSourceLabel: string
  isExplore: boolean
}

export type MusicTrack = {
  id: number
  name: string
  artists: string[]
  artistEntries: { id: number; name: string }[]
  album: string
  albumId: number
  albumCoverUrl: string
  durationMs: number
  position: number
}

export type MusicSongSource = {
  url: string | null
  level: string
  streamDurationMs: number
  previewStartMs: number
  previewEndMs: number
  fee: number
  code: number
  freeTrialInfo: unknown
}

export const fetchMusicLoginStatus = async (): Promise<MusicLoginStatus> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchMusicLoginStatus)
  return fn() as Promise<MusicLoginStatus>
}

export const createMusicQrLogin = async (): Promise<MusicQrLoginResult> => {
  const fn = requireDesktopAction(getDesktopApi()?.createMusicQrLogin)
  return fn() as Promise<MusicQrLoginResult>
}

export const checkMusicQrLogin = async (key: string): Promise<MusicQrCheckResult> => {
  const fn = requireDesktopAction(getDesktopApi()?.checkMusicQrLogin)
  return fn(key) as Promise<MusicQrCheckResult>
}

export const musicLogout = async (): Promise<void> => {
  const fn = requireDesktopAction(getDesktopApi()?.musicLogout)
  await fn()
}

export const fetchMusicPlaylists = async (): Promise<MusicPlaylistSummary[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchMusicPlaylists)
  return fn() as Promise<MusicPlaylistSummary[]>
}

export const fetchMusicPlaylistTracks = async (playlistId: number): Promise<MusicTrack[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchMusicPlaylistTracks)
  return fn(playlistId) as Promise<MusicTrack[]>
}

export const getMusicSongUrl = async (songId: number, quality?: string): Promise<MusicSongSource> => {
  const fn = requireDesktopAction(getDesktopApi()?.getMusicSongUrl)
  return fn(songId, quality) as Promise<MusicSongSource>
}

export const recordMusicPlay = async (trackId: number): Promise<number> => {
  const fn = requireDesktopAction(getDesktopApi()?.recordMusicPlay)
  return fn(trackId) as Promise<number>
}

export const fetchMusicExplorePlaylists = async (query?: string): Promise<MusicPlaylistSummary[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchMusicExplorePlaylists)
  return fn(query) as Promise<MusicPlaylistSummary[]>
}

// ── White Noise ─────────────────────────────────────────────────────────────

export type NoiseGeneratorType = string
export type NoiseLayer = { id: string; label: string; generator: NoiseGeneratorType; volume: number; url?: string }
export type NoiseScene = { id: string; title: string; prompt: string; layers: NoiseLayer[]; createdAt: string }

export const fetchWhiteNoiseScenes = async (): Promise<NoiseScene[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchWhiteNoiseScenes)
  return fn() as Promise<NoiseScene[]>
}

export const generateWhiteNoiseScene = async (prompt: string | null): Promise<NoiseScene[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.generateWhiteNoiseScene)
  return fn(prompt) as Promise<NoiseScene[]>
}

export const deleteWhiteNoiseScene = async (sceneId: string): Promise<NoiseScene[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.deleteWhiteNoiseScene)
  return fn(sceneId) as Promise<NoiseScene[]>
}

export const ensureAmbientAudio = async (generator: string, url?: string): Promise<string> => {
  const fn = requireDesktopAction(getDesktopApi()?.ensureAmbientAudio)
  return fn(generator, url)
}

export const readAmbientAudioBuffer = async (generator: string, url?: string): Promise<ArrayBuffer> => {
  const fn = requireDesktopAction(getDesktopApi()?.readAmbientAudioBuffer)
  return fn(generator, url) as Promise<ArrayBuffer>
}

// ── Proxy Stats ──────────────────────────────────────────────────────────────

export type ProxyStatsCounts = {
  requests: number
  disconnects: number
  recoverySuccesses: number
  recoveryFailures: number
}

export type ProxyStatsSummary = {
  history: ProxyStatsCounts
  currentSession: ProxyStatsCounts
  startedAt: number
  entries: Array<{
    timestamp: number
    provider: string
    event: string
    endpoint: string
    attempt?: number
    errorType?: string
  }>
}

export type ProxyStatsEvent = 'request' | 'disconnect' | 'recovery_success' | 'recovery_fail'

export type ProxyStatsRecordRequest = {
  provider: 'codex' | 'claude'
  event: ProxyStatsEvent
  endpoint: string
  attempt?: number
  errorType?: string
}

export const fetchProxyStats = async (since?: number): Promise<ProxyStatsSummary> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchProxyStats)
  return fn(since) as Promise<ProxyStatsSummary>
}

export const resetProxyStats = async (): Promise<void> => {
  const fn = requireDesktopAction(getDesktopApi()?.resetProxyStats)
  return fn() as Promise<void>
}

export const recordProxyStatsEvent = async (request: ProxyStatsRecordRequest): Promise<void> => {
  const fn = requireDesktopAction(getDesktopApi()?.recordProxyStatsEvent)
  return fn(request) as Promise<void>
}

// ── Weather ───────────────────────────────────────────────────────────────────

export type WeatherData = {
  condition: string
  city: string
  temperature: number
  isDay: boolean
  fetchedAt: string
}

export const fetchWeatherData = async (city?: string): Promise<WeatherData> => {
  const fn = requireDesktopAction(getDesktopApi()?.fetchWeather)
  return fn(city) as Promise<WeatherData>
}

export type CitySuggestion = {
  name: string
  country: string
  admin1: string
  latitude: number
  longitude: number
}

export const searchCities = async (query: string): Promise<CitySuggestion[]> => {
  const fn = requireDesktopAction(getDesktopApi()?.searchCities)
  return fn(query) as Promise<CitySuggestion[]>
}

// ── File System ─────────────────────────────────────────────────────────────

import type { FileEntry, FileReadResponse } from '../shared/schema'

export const fetchFileList = async (workspacePath: string, relativePath = ''): Promise<FileEntry[]> => {
  const desktop = getDesktopApi()
  if (desktop?.listFiles) {
    const result = await desktop.listFiles({ workspacePath, relativePath })
    return result.entries
  }

  const response = await fetch('/api/files/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, relativePath }),
  })

  if (!response.ok) throw new Error('Failed to list files')
  const data = await response.json()
  return data.entries as FileEntry[]
}

export const searchFiles = async (
  workspacePath: string,
  query: string,
  limit = 200,
): Promise<FileSearchEntry[]> => {
  const request = fileSearchRequestSchema.parse({ workspacePath, query, limit })
  const desktop = getDesktopApi()

  if (desktop?.searchFiles) {
    const result = await desktop.searchFiles(request)
    return fileSearchResponseSchema.parse(result).entries
  }

  const response = await fetch('/api/files/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) throw new Error('Failed to search files')
  return fileSearchResponseSchema.parse(await response.json()).entries
}

export const createWorkspaceFile = async (
  workspacePath: string,
  parentRelativePath: string,
  name: string,
): Promise<void> => {
  const request: FileCreateRequest = fileCreateRequestSchema.parse({
    workspacePath,
    parentRelativePath,
    name,
  })
  const desktop = getDesktopApi()

  if (desktop?.createFile) {
    return desktop.createFile(request)
  }

  const response = await fetch('/api/files/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(
      payload && typeof payload.message === 'string' ? payload.message : 'Failed to create file',
    )
  }
}

export const createWorkspaceDirectory = async (
  workspacePath: string,
  parentRelativePath: string,
  name: string,
): Promise<void> => {
  const request: FileCreateRequest = fileCreateRequestSchema.parse({
    workspacePath,
    parentRelativePath,
    name,
  })
  const desktop = getDesktopApi()

  if (desktop?.createDirectory) {
    return desktop.createDirectory(request)
  }

  const response = await fetch('/api/files/create-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(
      payload && typeof payload.message === 'string'
        ? payload.message
        : 'Failed to create directory',
    )
  }
}

export const renameWorkspaceEntry = async (
  workspacePath: string,
  relativePath: string,
  nextName: string,
): Promise<void> => {
  const request: FileRenameRequest = fileRenameRequestSchema.parse({
    workspacePath,
    relativePath,
    nextName,
  })
  const desktop = getDesktopApi()

  if (desktop?.renameEntry) {
    return desktop.renameEntry(request)
  }

  const response = await fetch('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(
      payload && typeof payload.message === 'string' ? payload.message : 'Failed to rename entry',
    )
  }
}

export const moveWorkspaceEntry = async (
  workspacePath: string,
  relativePath: string,
  destinationParentRelativePath: string,
): Promise<void> => {
  const request: FileMoveRequest = fileMoveRequestSchema.parse({
    workspacePath,
    relativePath,
    destinationParentRelativePath,
  })
  const desktop = getDesktopApi()

  if (desktop?.moveEntry) {
    return desktop.moveEntry(request)
  }

  const response = await fetch('/api/files/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(
      payload && typeof payload.message === 'string' ? payload.message : 'Failed to move entry',
    )
  }
}

export const deleteWorkspaceEntry = async (
  workspacePath: string,
  relativePath: string,
): Promise<void> => {
  const request: FileDeleteRequest = fileDeleteRequestSchema.parse({
    workspacePath,
    relativePath,
  })
  const desktop = getDesktopApi()

  if (desktop?.deleteEntry) {
    return desktop.deleteEntry(request)
  }

  const response = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(
      payload && typeof payload.message === 'string' ? payload.message : 'Failed to delete entry',
    )
  }
}

export const fetchFileContent = async (workspacePath: string, relativePath: string): Promise<FileReadResponse> => {
  const desktop = getDesktopApi()
  if (desktop?.readFile) {
    return desktop.readFile({ workspacePath, relativePath })
  }

  const response = await fetch('/api/files/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, relativePath }),
  })

  if (!response.ok) throw new Error('Failed to read file')
  return response.json() as Promise<FileReadResponse>
}

export const saveFileContent = async (workspacePath: string, relativePath: string, content: string): Promise<void> => {
  const desktop = getDesktopApi()
  if (desktop?.writeFile) {
    return desktop.writeFile({ workspacePath, relativePath, content })
  }

  const response = await fetch('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspacePath, relativePath, content }),
  })

  if (!response.ok) throw new Error('Failed to write file')
}

// ── App Update ───────────────────────────────────────────────────────────────

export type UpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  assetUrl?: string
  releaseNotes?: string
  htmlUrl?: string
  error?: string
}

export const getAppVersion = async (): Promise<string> => {
  const fn = requireDesktopAction(getDesktopApi()?.getAppVersion)
  return fn() as Promise<string>
}

export const checkForUpdate = async (): Promise<UpdateCheckResult> => {
  const fn = requireDesktopAction(getDesktopApi()?.checkForUpdate)
  return fn() as Promise<UpdateCheckResult>
}

export const downloadUpdate = async (assetUrl: string): Promise<string> => {
  const fn = requireDesktopAction(getDesktopApi()?.downloadUpdate)
  return fn(assetUrl) as Promise<string>
}

export const installUpdate = async (assetPath: string): Promise<void> => {
  const fn = requireDesktopAction(getDesktopApi()?.installUpdate)
  await fn(assetPath)
}

export const clearUserData = async (): Promise<void> => {
  const fn = requireDesktopAction(getDesktopApi()?.clearUserData)
  await fn()
}

export const onUpdateDownloadProgress = (listener: (progress: number) => void): (() => void) => {
  const fn = requireDesktopAction(getDesktopApi()?.onUpdateDownloadProgress)
  return fn(listener) as () => void
}

export const openChatStream = (streamId: string, handlers: StreamHandlers): ChatStreamSource => {
  const desktopApi = getDesktopApi()
  const subscribeChatStream = requireDesktopAction(desktopApi?.subscribeChatStream)
  const unsubscribeChatStream = requireDesktopAction(desktopApi?.unsubscribeChatStream)

  if (typeof window === 'undefined') {
    throw new Error(desktopBridgeUnavailableMessage)
  }

  const subscriptionId = crypto.randomUUID()

  const onDesktopEvent = (event: WindowEventMap['chill-vibe:chat-stream']) => {
    if (event.detail.subscriptionId !== subscriptionId) {
      return
    }

    const { data } = event.detail

    if (event.detail.event === 'session') {
      handlers.onSession?.(data as StreamEventMap['session'])
      return
    }

    if (event.detail.event === 'delta') {
      handlers.onDelta?.(data as StreamEventMap['delta'])
      return
    }

    if (event.detail.event === 'log') {
      handlers.onLog?.(data as StreamEventMap['log'])
      return
    }

    if (event.detail.event === 'assistant_message') {
      handlers.onAssistantMessage?.(data as StreamEventMap['assistant_message'])
      return
    }

    if (event.detail.event === 'activity') {
      handlers.onActivity?.(data as StreamEventMap['activity'])
      return
    }

    if (event.detail.event === 'stats') {
      handlers.onStats?.(data as StreamEventMap['stats'])
      return
    }

    if (event.detail.event === 'done') {
      handlers.onDone?.(data as StreamEventMap['done'])
      return
    }

    const errorPayload = data as StreamEventMap['error']
    handlers.onError?.({
      ...errorPayload,
      recoverable: errorPayload.recoverable ?? false,
    })
  }

  window.addEventListener('chill-vibe:chat-stream', onDesktopEvent)

  void subscribeChatStream(streamId, subscriptionId).catch((error) => {
    window.removeEventListener('chill-vibe:chat-stream', onDesktopEvent)
    handlers.onError?.({
      message: error instanceof Error ? error.message : 'The desktop stream could not be opened.',
      recoverable: false,
    })
  })

  return {
    close() {
      window.removeEventListener('chill-vibe:chat-stream', onDesktopEvent)
      void unsubscribeChatStream(subscriptionId)
    },
  }
}
