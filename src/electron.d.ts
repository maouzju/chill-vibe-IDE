import type {
  AppSettings,
  AppState,
  AppStateLoadResponse,
  AttachmentUploadRequest,
  CcSwitchImportRequest,
  CcSwitchImportResponse,
  ChatRequest,
  ChatStartResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  NativeTurnCompletionRequest,
  NativeTurnCompletionResponse,
  ExternalHistoryListRequest,
  ExternalHistoryListResponse,
  ExternalSessionLoadRequest,
  ExternalSessionLoadResponse,
  InternalSessionHistoryLoadRequest,
  InternalSessionHistoryLoadResponse,
  InternalSessionHistoryHideRequest,
  InternalSessionHistoryListRequest,
  InternalSessionHistoryListResponse,
  FileCreateRequest,
  FileDeleteRequest,
  FileListRequest,
  FileListResponse,
  FileMoveRequest,
  FileSearchRequest,
  FileSearchResponse,
  FileReadRequest,
  FileReadResponse,
  FileRenameRequest,
  FileWriteRequest,
  FileWriteResponse,
  GitCommitAllRequest,
  GitCommitDiffRequest,
  GitCommitDiffResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiscardRequest,
  GitFileHeadStateResponse,
  GitFileLineDiffResponse,
  GitFilePathRequest,
  GitLogRequest,
  GitLogResponse,
  GitOperationResponse,
  GitPullRequest,
  GitPushRequest,
  GitStageRequest,
  GitStatus,
  ImageAttachment,
  OnboardingStatus,
  ProviderStatus,
  RecentCrashRecovery,
  RendererCrashCaptureRequest,
  SetupRunRequestInput,
  SetupStatus,
  OllamaJudgeRequest,
  OllamaJudgeResponse,
  OllamaPullRequest,
  OllamaStatus,
  OllamaTask,
  SlashCommand,
  SlashCommandRequest,
  StateRecoverySelection,
  StreamEventMap,
} from '../shared/schema'

type DesktopStreamEventDetail = {
  subscriptionId: string
  event: keyof StreamEventMap
  data: StreamEventMap[keyof StreamEventMap]
}

declare global {
  interface Window {
    electronAPI?: {
      minimizeWindow?: () => Promise<void>
      toggleMaximizeWindow?: () => Promise<boolean>
      closeWindow?: () => Promise<void>
      flashWindowOnce?: () => Promise<boolean>
      setUiZoomFactor?: (zoomFactor: number) => Promise<void>
      isWindowMaximized?: () => Promise<boolean>
      onWindowMaximizedChanged?: (listener: (maximized: boolean) => void) => (() => void)
      openFolderDialog?: () => Promise<string | null>
      openMessageLocalLink?: (href: string, workspacePath?: string) => Promise<void>
      openExternalLink?: (href: string) => Promise<void>
      fetchState?: () => Promise<AppStateLoadResponse | AppState>
      loadSessionHistoryEntry?: (request: InternalSessionHistoryLoadRequest) => Promise<InternalSessionHistoryLoadResponse>
      listInternalSessionHistory?: (request: InternalSessionHistoryListRequest) => Promise<InternalSessionHistoryListResponse>
      hideInternalSessionHistory?: (request: InternalSessionHistoryHideRequest) => Promise<void>
      saveState?: (state: AppState) => Promise<AppState>
      syncRuntimeSettings?: (settings: AppSettings) => Promise<void>
      queueStateSave?: (state: AppState) => void
      resetState?: () => Promise<AppState>
      resolveStateRecoveryOption?: (request: StateRecoverySelection) => Promise<AppStateLoadResponse>
      captureRendererCrash?: (request: RendererCrashCaptureRequest) => Promise<RecentCrashRecovery | null>
      dismissRecentCrashRecovery?: () => Promise<void>
      fetchProviders?: () => Promise<ProviderStatus[]>
      importCcSwitchRouting?: (request: CcSwitchImportRequest) => Promise<CcSwitchImportResponse>
      fetchSetupStatus?: () => Promise<SetupStatus>
      runEnvironmentSetup?: (request?: SetupRunRequestInput) => Promise<SetupStatus>
      fetchOllamaStatus?: () => Promise<OllamaStatus>
      runOllamaInstall?: () => Promise<OllamaTask>
      runOllamaPull?: (request: OllamaPullRequest) => Promise<OllamaTask>
      judgeUrgeWithOllama?: (request: OllamaJudgeRequest) => Promise<OllamaJudgeResponse>
      fetchOnboardingStatus?: () => Promise<OnboardingStatus>
      fetchGitStatus?: (workspacePath: string) => Promise<GitStatus>
      fetchGitStatusPreview?: (workspacePath: string) => Promise<GitStatus>
      setGitStage?: (request: GitStageRequest) => Promise<GitStatus>
      discardGitChanges?: (request: GitDiscardRequest) => Promise<GitStatus>
      initGitWorkspace?: (request: GitPullRequest) => Promise<GitOperationResponse>
      commitGitChanges?: (request: GitCommitRequest) => Promise<GitCommitResponse>
      pullGitChanges?: (request: GitPullRequest) => Promise<GitOperationResponse>
      pushGitChanges?: (request: GitPushRequest) => Promise<GitOperationResponse>
      commitAllGitChanges?: (request: GitCommitAllRequest) => Promise<GitCommitResponse>
      fetchGitLog?: (request: GitLogRequest) => Promise<GitLogResponse>
      fetchCommitDiff?: (request: GitCommitDiffRequest) => Promise<GitCommitDiffResponse>
      fetchSlashCommands?: (request: SlashCommandRequest) => Promise<SlashCommand[]>
      requestChat?: (request: ChatRequest) => Promise<ChatStartResponse>
      forkProviderSession?: (request: ForkSessionRequest) => Promise<ForkSessionResponse>
      getNativeTurnCompletion?: (
        request: NativeTurnCompletionRequest,
      ) => Promise<NativeTurnCompletionResponse>
      uploadImageAttachment?: (request: AttachmentUploadRequest) => Promise<ImageAttachment>
      stopChat?: (streamId: string) => Promise<void>
      listExternalHistory?: (request: ExternalHistoryListRequest) => Promise<ExternalHistoryListResponse>
      loadExternalSession?: (request: ExternalSessionLoadRequest) => Promise<ExternalSessionLoadResponse>
      subscribeChatStream?: (streamId: string, subscriptionId: string) => Promise<void>
      unsubscribeChatStream?: (subscriptionId: string) => Promise<void>
      getAttachmentUrl?: (attachmentId: string) => string
      getPathForFile?: (file: File) => string

      // Remote Monitor
      startRemoteMonitor?: () => Promise<unknown>
      stopRemoteMonitor?: () => Promise<void>
      fetchRemoteMonitorStatus?: () => Promise<unknown>

      // Music
      fetchMusicLoginStatus?: () => Promise<unknown>
      createMusicQrLogin?: () => Promise<unknown>
      checkMusicQrLogin?: (key: string) => Promise<unknown>
      musicLogout?: () => Promise<void>
      fetchMusicPlaylists?: () => Promise<unknown>
      fetchMusicPlaylistTracks?: (playlistId: number) => Promise<unknown>
      getMusicSongUrl?: (songId: number, quality?: string) => Promise<unknown>
      recordMusicPlay?: (trackId: number) => Promise<unknown>
      fetchMusicExplorePlaylists?: (query?: string) => Promise<unknown>

      // Proxy Stats
      fetchProxyStats?: (since?: number) => Promise<unknown>
      resetProxyStats?: () => Promise<void>
      recordProxyStatsEvent?: (request: {
        provider: 'codex' | 'claude'
        event: 'request' | 'disconnect' | 'recovery_success' | 'recovery_fail'
        endpoint: string
        attempt?: number
        errorType?: string
      }) => Promise<void>

      // White Noise
      fetchWhiteNoiseScenes?: () => Promise<unknown>
      generateWhiteNoiseScene?: (prompt: string | null) => Promise<unknown>
      deleteWhiteNoiseScene?: (sceneId: string) => Promise<unknown>
      ensureAmbientAudio?: (generator: string, url?: string) => Promise<string>
      readAmbientAudioBuffer?: (generator: string, url?: string) => Promise<ArrayBuffer>

      // Weather
      fetchWeather?: (city?: string) => Promise<unknown>
      searchCities?: (query: string) => Promise<unknown>

      // File System
      listFiles?: (request: FileListRequest) => Promise<FileListResponse>
      searchFiles?: (request: FileSearchRequest) => Promise<FileSearchResponse>
      createFile?: (request: FileCreateRequest) => Promise<void>
      createDirectory?: (request: FileCreateRequest) => Promise<void>
      renameEntry?: (request: FileRenameRequest) => Promise<void>
      moveEntry?: (request: FileMoveRequest) => Promise<void>
      deleteEntry?: (request: FileDeleteRequest) => Promise<void>
      readFile?: (request: FileReadRequest) => Promise<FileReadResponse>
      copyFileToClipboard?: (request: FileReadRequest) => Promise<void>
      writeFile?: (request: FileWriteRequest) => Promise<FileWriteResponse | void>
      readNearestTsconfig?: (request: FileReadRequest) => Promise<{
        compilerOptions: Record<string, unknown> | null
      }>
      readGitHeadFile?: (request: GitFilePathRequest) => Promise<GitFileHeadStateResponse>
      readGitFileLineDiff?: (request: GitFilePathRequest) => Promise<GitFileLineDiffResponse>
      watchFile?: (request: {
        workspacePath: string
        relativePath: string
        subscriptionId: string
      }) => Promise<boolean>
      unwatchFile?: (subscriptionId: string) => Promise<void>

      // App Update
      getAppVersion?: () => Promise<string>
      checkForUpdate?: () => Promise<unknown>
      downloadUpdate?: (assetUrl: string) => Promise<string>
      installUpdate?: (assetPath: string) => Promise<void>
      clearUserData?: () => Promise<void>
      onUpdateDownloadProgress?: (listener: (progress: number) => void) => (() => void)

      // Crash Logging
      logError?: (level: string, message: string, meta?: unknown) => Promise<void>
    }
  }

  interface WindowEventMap {
    'chill-vibe:chat-stream': CustomEvent<DesktopStreamEventDetail>
    'chill-vibe:file-changed': CustomEvent<{ subscriptionId: string }>
  }
}

export {}
