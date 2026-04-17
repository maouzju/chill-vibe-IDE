import type {
  AppState,
  AppStateLoadResponse,
  AttachmentUploadRequest,
  CcSwitchImportRequest,
  CcSwitchImportResponse,
  ChatRequest,
  ChatStartResponse,
  ExternalHistoryListRequest,
  ExternalHistoryListResponse,
  ExternalSessionLoadRequest,
  ExternalSessionLoadResponse,
  InternalSessionHistoryLoadRequest,
  InternalSessionHistoryLoadResponse,
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
  GitCommitAllRequest,
  GitCommitDiffRequest,
  GitCommitDiffResponse,
  GitCommitRequest,
  GitCommitResponse,
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
  SetupStatus,
  SlashCommand,
  SlashCommandRequest,
  StateRecoverySelection,
  StreamEventMap,
  SpecEnsureRequest,
} from '../shared/schema'
import type { EnsureSpecDocumentsResult } from '../shared/spec-first'

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
      saveState?: (state: AppState) => Promise<AppState>
      queueStateSave?: (state: AppState) => void
      resetState?: () => Promise<AppState>
      resolveStateRecoveryOption?: (request: StateRecoverySelection) => Promise<AppStateLoadResponse>
      captureRendererCrash?: (request: RendererCrashCaptureRequest) => Promise<RecentCrashRecovery | null>
      dismissRecentCrashRecovery?: () => Promise<void>
      fetchProviders?: () => Promise<ProviderStatus[]>
      importCcSwitchRouting?: (request: CcSwitchImportRequest) => Promise<CcSwitchImportResponse>
      fetchSetupStatus?: () => Promise<SetupStatus>
      runEnvironmentSetup?: () => Promise<SetupStatus>
      fetchOnboardingStatus?: () => Promise<OnboardingStatus>
      fetchGitStatus?: (workspacePath: string) => Promise<GitStatus>
      setGitStage?: (request: GitStageRequest) => Promise<GitStatus>
      initGitWorkspace?: (request: GitPullRequest) => Promise<GitOperationResponse>
      commitGitChanges?: (request: GitCommitRequest) => Promise<GitCommitResponse>
      pullGitChanges?: (request: GitPullRequest) => Promise<GitOperationResponse>
      pushGitChanges?: (request: GitPushRequest) => Promise<GitOperationResponse>
      commitAllGitChanges?: (request: GitCommitAllRequest) => Promise<GitCommitResponse>
      fetchGitLog?: (request: GitLogRequest) => Promise<GitLogResponse>
      fetchCommitDiff?: (request: GitCommitDiffRequest) => Promise<GitCommitDiffResponse>
      fetchSlashCommands?: (request: SlashCommandRequest) => Promise<SlashCommand[]>
      requestChat?: (request: ChatRequest) => Promise<ChatStartResponse>
      uploadImageAttachment?: (request: AttachmentUploadRequest) => Promise<ImageAttachment>
      stopChat?: (streamId: string) => Promise<void>
      listExternalHistory?: (request: ExternalHistoryListRequest) => Promise<ExternalHistoryListResponse>
      loadExternalSession?: (request: ExternalSessionLoadRequest) => Promise<ExternalSessionLoadResponse>
      subscribeChatStream?: (streamId: string, subscriptionId: string) => Promise<void>
      unsubscribeChatStream?: (subscriptionId: string) => Promise<void>
      getAttachmentUrl?: (attachmentId: string) => string
      ensureSpecDocuments?: (request: SpecEnsureRequest) => Promise<EnsureSpecDocumentsResult>

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
      writeFile?: (request: FileWriteRequest) => Promise<void>

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
  }
}

export {}
