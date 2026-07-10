import { resolveImageAttachmentPath, storeImageAttachment } from '../server/attachments.ts'
import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import { importCcSwitchProfiles } from '../server/cc-switch-import.ts'
import {
  copyWorkspaceFileToClipboard,
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  FileRevisionConflictError,
  listFiles,
  moveWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from '../server/file-system.ts'
import { FileWatcherManager } from '../server/file-watcher.ts'
import { readNearestTsconfig } from '../server/tsconfig-discovery.ts'
import { listExternalSessions, loadExternalSession } from '../server/external-history.ts'
import { forkProviderSession } from '../server/session-fork.ts'
import {
  commitAllGitWorkspace,
  commitGitWorkspace,
  fetchCommitDiff,
  fetchGitLog,
  discardGitWorkspaceChanges,
  initGitWorkspace,
  inspectGitWorkspace,
  pullGitWorkspace,
  pushGitWorkspace,
  readGitFileLineDiff,
  readGitHeadFileState,
  setGitWorkspaceStage,
} from '../server/git-workspace.ts'
import { inspectOnboardingStatus } from '../server/onboarding-status.ts'
import {
  getProviderSlashCommands,
  recordProviderProxyStatsEvent,
  getProviderStatuses,
  setProviderRuntimeSettingsOverride,
  validateWorkspacePath,
} from '../server/providers.ts'
import {
  buildRemoteMonitorSnapshot,
  createRemoteMonitorManager,
  type RemoteMonitorManager,
} from '../server/remote-monitor.ts'
import { resilientProxyPool } from '../server/resilient-proxy.ts'
import { SetupManager } from '../server/setup-manager.ts'
import { OllamaManager } from '../server/ollama-manager.ts'
import {
  captureRendererCrash as captureRendererCrashState,
  dismissRecentCrashRecovery as dismissRecentCrashRecoveryState,
  loadStateForRenderer,
  loadSessionHistoryEntry as loadInternalSessionHistoryEntry,
  queueSaveState,
  resetState,
  resolveStateRecoveryOption as resolveStateRecoverySelection,
  saveState,
  waitForPendingStateWrites,
} from '../server/state-store.ts'
import { MusicManager } from '../server/music/music-manager.ts'
import {
  readScenes,
  addScene,
  removeScene,
  type NoiseScene,
} from '../server/whitenoise/whitenoise-store.ts'
import { fetchWeather, searchCities } from '../server/weather/weather-service.ts'
import { generateScene } from '../server/whitenoise/whitenoise-generator.ts'
import {
  appSettingsSchema,
  attachmentUploadRequestSchema,
  appStateSchema,
  rendererCrashCaptureRequestSchema,
  ccSwitchImportRequestSchema,
  externalHistoryListRequestSchema,
  externalSessionLoadRequestSchema,
  internalSessionHistoryLoadRequestSchema,
  chatRequestSchema,
  forkSessionRequestSchema,
  gitCommitAllRequestSchema,
  gitCommitDiffRequestSchema,
  gitCommitRequestSchema,
  gitDiscardRequestSchema,
  gitLogRequestSchema,
  gitPullRequestSchema,
  gitPushRequestSchema,
  gitStageRequestSchema,
  setupRunRequestSchema,
  ollamaJudgeRequestSchema,
  ollamaPullRequestSchema,
  stateRecoverySelectionSchema,
  slashCommandRequestSchema,
  fileCreateRequestSchema,
  fileDeleteRequestSchema,
  fileListRequestSchema,
  fileMoveRequestSchema,
  fileReadRequestSchema,
  fileRenameRequestSchema,
  fileSearchRequestSchema,
  fileWriteRequestSchema,
  gitFilePathRequestSchema,
  type AppState,
  type AttachmentUploadRequest,
  type CcSwitchImportRequest,
  type ExternalHistoryListRequest,
  type ExternalSessionLoadRequest,
  type InternalSessionHistoryLoadRequest,
  type ChatRequest,
  type RemoteMonitorCommand,
  type GitCommitAllRequest,
  type GitCommitDiffRequest,
  type GitCommitRequest,
  type GitDiscardRequest,
  type GitLogRequest,
  type GitPullRequest,
  type GitPushRequest,
  type GitStageRequest,
  type SlashCommandRequest,
} from '../shared/schema.ts'

type StreamListener = (payload: StreamEnvelope) => void

type ChatManagerLike = Pick<
  ChatManager,
  'closeAll' | 'createStream' | 'stop' | 'subscribe' | 'tapAll' | 'listActiveStreams'
>
type SetupManagerLike = Pick<SetupManager, 'dispose' | 'getStatus' | 'start'>
type OllamaManagerLike = Pick<OllamaManager, 'dispose' | 'getStatus' | 'startInstall' | 'startPull' | 'judge'>
type MusicManagerLike = Pick<
  MusicManager,
  | 'getLoginStatus'
  | 'createQrLogin'
  | 'checkQrLogin'
  | 'logout'
  | 'fetchPlaylists'
  | 'fetchPlaylistTracks'
  | 'getSongUrl'
  | 'recordPlay'
  | 'getExplorePlaylists'
>

type DesktopBackendDependencies = {
  createChatManager?: () => ChatManagerLike
  createSetupManager?: () => SetupManagerLike
  createOllamaManager?: () => OllamaManagerLike
  createMusicManager?: () => MusicManagerLike
  // Desktop push channel for Claude keepalive: when a pooled CLI process wakes
  // itself between turns (background task finished), the new stream is
  // announced here so the renderer can attach the owning card to it.
  onUnsolicitedStream?: (notification: { cardId: string; streamId: string }) => void
  // 手机监工的写命令出口：宿主（electron/main.ts）把命令广播给渲染窗口，
  // 渲染进程复用电脑端 handler 执行。返回 false = 当前无窗口可执行。
  dispatchRemoteCommand?: (command: RemoteMonitorCommand) => boolean
}

export const createDesktopBackend = (deps: DesktopBackendDependencies = {}) => {
  let chatManager: ChatManagerLike | null = null
  let setupManager: SetupManagerLike | null = null
  let ollamaManager: OllamaManagerLike | null = null
  let musicManager: MusicManagerLike | null = null
  let fileWatcherManager: FileWatcherManager | null = null
  let remoteMonitorManager: RemoteMonitorManager | null = null

  const getFileWatcherManager = () => {
    if (!fileWatcherManager) {
      fileWatcherManager = new FileWatcherManager()
    }

    return fileWatcherManager
  }

  const getChatManager = () => {
    if (!chatManager) {
      chatManager =
        deps.createChatManager?.() ??
        new ChatManager({
          enableClaudeKeepalive: true,
          onUnsolicitedStream: (notification) => deps.onUnsolicitedStream?.(notification),
        })
    }

    return chatManager
  }

  const getSetupManager = () => {
    if (!setupManager) {
      setupManager = deps.createSetupManager?.() ?? new SetupManager()
    }

    return setupManager
  }

  const getOllamaManager = () => {
    if (!ollamaManager) {
      ollamaManager = deps.createOllamaManager?.() ?? new OllamaManager()
    }

    return ollamaManager
  }

  // Lazy like the other desktop services (pitfall 79): nothing about the
  // monitor may resolve paths or bind sockets before the user turns it on.
  const getRemoteMonitorManager = () => {
    if (!remoteMonitorManager) {
      remoteMonitorManager = createRemoteMonitorManager({
        loadSnapshot: async () => {
          const response = await loadStateForRenderer()
          return buildRemoteMonitorSnapshot(response.state)
        },
        tapStreams: (listener) => getChatManager().tapAll(listener),
        listActiveStreams: () => getChatManager().listActiveStreams(),
        dispatchCommand: (command) => deps.dispatchRemoteCommand?.(command) ?? false,
      })
    }

    return remoteMonitorManager
  }

  const getMusicManager = () => {
    if (!musicManager) {
      musicManager = deps.createMusicManager?.() ?? new MusicManager()
    }

    return musicManager
  }

  return {
    async fetchState() {
      return loadStateForRenderer()
    },
    async loadSessionHistoryEntry(request: InternalSessionHistoryLoadRequest) {
      return loadInternalSessionHistoryEntry(internalSessionHistoryLoadRequestSchema.parse(request))
    },
    async saveState(state: AppState) {
      return saveState(appStateSchema.parse(state))
    },
    queueStateSave(state: AppState) {
      void queueSaveState(appStateSchema.parse(state))
    },
    syncRuntimeSettings(settings: AppState['settings']) {
      const parsed = appSettingsSchema.parse(settings)
      setProviderRuntimeSettingsOverride(parsed)
      void resilientProxyPool.configure({
        firstByteTimeoutMs: parsed.resilientProxyFirstByteTimeoutSec * 1000,
        stallTimeoutMs: parsed.resilientProxyStallTimeoutSec * 1000,
        maxRecoveryRetries: parsed.resilientProxyMaxRetries,
      })
    },
    async flushStateWrites() {
      await waitForPendingStateWrites()
    },
    async resetState() {
      return resetState()
    },
    async resolveStateRecoveryOption(request: { optionId: string }) {
      return resolveStateRecoverySelection(stateRecoverySelectionSchema.parse(request).optionId)
    },
    async captureRendererCrash(request: unknown) {
      return captureRendererCrashState(rendererCrashCaptureRequestSchema.parse(request))
    },
    async dismissRecentCrashRecovery() {
      await dismissRecentCrashRecoveryState()
    },
    async fetchProviders() {
      return getProviderStatuses()
    },
    async importCcSwitchRouting(request: CcSwitchImportRequest) {
      return importCcSwitchProfiles(ccSwitchImportRequestSchema.parse(request))
    },
    fetchSetupStatus() {
      return getSetupManager().getStatus()
    },
    runEnvironmentSetup(request?: unknown) {
      return getSetupManager().start(setupRunRequestSchema.parse(request ?? {}))
    },
    async fetchOllamaStatus() {
      return getOllamaManager().getStatus()
    },
    runOllamaInstall() {
      return getOllamaManager().startInstall()
    },
    runOllamaPull(request: unknown) {
      return getOllamaManager().startPull(ollamaPullRequestSchema.parse(request ?? {}).model)
    },
    async judgeUrgeWithOllama(request: unknown) {
      return getOllamaManager().judge(ollamaJudgeRequestSchema.parse(request ?? {}))
    },
    async fetchOnboardingStatus() {
      return inspectOnboardingStatus()
    },
    async fetchGitStatus(workspacePath: string) {
      return inspectGitWorkspace(gitPullRequestSchema.parse({ workspacePath }).workspacePath)
    },
    async fetchGitStatusPreview(workspacePath: string) {
      return inspectGitWorkspace(gitPullRequestSchema.parse({ workspacePath }).workspacePath, {
        includeChangePreviews: false,
        includeRepositoryDetails: false,
      })
    },
    async setGitStage(request: GitStageRequest) {
      return setGitWorkspaceStage(gitStageRequestSchema.parse(request))
    },
    async discardGitChanges(request: GitDiscardRequest) {
      return discardGitWorkspaceChanges(gitDiscardRequestSchema.parse(request))
    },
    async initGitWorkspace(request: GitPullRequest) {
      return initGitWorkspace(gitPullRequestSchema.parse(request).workspacePath)
    },
    async commitGitChanges(request: GitCommitRequest) {
      return commitGitWorkspace(gitCommitRequestSchema.parse(request))
    },
    async pullGitChanges(request: GitPullRequest) {
      return pullGitWorkspace(gitPullRequestSchema.parse(request).workspacePath)
    },
    async pushGitChanges(request: GitPushRequest) {
      return pushGitWorkspace(gitPushRequestSchema.parse(request).workspacePath)
    },
    async commitAllGitChanges(request: GitCommitAllRequest) {
      return commitAllGitWorkspace(gitCommitAllRequestSchema.parse(request))
    },
    async fetchGitLog(request: GitLogRequest) {
      return fetchGitLog(gitLogRequestSchema.parse(request))
    },
    async fetchCommitDiff(request: GitCommitDiffRequest) {
      const parsed = gitCommitDiffRequestSchema.parse(request)
      const patch = await fetchCommitDiff(parsed.workspacePath, parsed.hash)
      return { patch }
    },
    async fetchSlashCommands(request: SlashCommandRequest) {
      return getProviderSlashCommands(slashCommandRequestSchema.parse(request))
    },
    async requestChat(request: ChatRequest) {
      const parsed = chatRequestSchema.parse(request)
      const workspaceCheck = await validateWorkspacePath(parsed.workspacePath, parsed.language)

      if (!workspaceCheck.valid) {
        throw new Error(workspaceCheck.reason ?? 'Invalid workspace path.')
      }

      const streamId = getChatManager().createStream(parsed)
      return { streamId }
    },
    async uploadImageAttachment(request: AttachmentUploadRequest) {
      return storeImageAttachment(attachmentUploadRequestSchema.parse(request))
    },
    async forkProviderSession(request: unknown) {
      const parsed = forkSessionRequestSchema.parse(request)
      const sessionId = await forkProviderSession({
        provider: parsed.provider,
        workspacePath: parsed.workspacePath,
        sessionId: parsed.sessionId,
        forkPoint: parsed.forkPoint,
      })
      return { sessionId }
    },
    async stopChat(streamId: string) {
      // Stop is intentionally idempotent from the renderer's point of view.
      // A stream can finish naturally between the user's click and the IPC call,
      // or a restored card can keep a stale stream id. In both cases the UI is
      // trying to leave the running state, so surfacing a hard IPC error only
      // pollutes the transcript without making the provider any more stopped.
      getChatManager().stop(streamId)
    },
    subscribeChatStream(streamId: string, listener: StreamListener) {
      return getChatManager().subscribe(streamId, listener)
    },
    async resolveAttachmentPath(attachmentId: string) {
      return resolveImageAttachmentPath(attachmentId)
    },

    // ── External history ────────────────────────────────────────────────────
    async listExternalHistory(request: ExternalHistoryListRequest) {
      return listExternalSessions(externalHistoryListRequestSchema.parse(request))
    },
    async loadExternalSession(request: ExternalSessionLoadRequest) {
      return loadExternalSession(externalSessionLoadRequestSchema.parse(request))
    },

    // ── Remote Monitor（手机远程监工）────────────────────────────────────────
    async startRemoteMonitor() {
      const info = await getRemoteMonitorManager().start()
      const { toDataURL } = await import('qrcode')
      const qrDataUrl = await toDataURL(info.url, { margin: 1, width: 320 })
      return { ...info, qrDataUrl }
    },
    async stopRemoteMonitor() {
      await remoteMonitorManager?.stop()
    },
    fetchRemoteMonitorStatus() {
      return (
        remoteMonitorManager?.getStatus() ?? { running: false, clientCount: 0 }
      )
    },

    async dispose() {
      await remoteMonitorManager?.stop()
      chatManager?.closeAll()
      setupManager?.dispose()
      ollamaManager?.dispose()
      await resilientProxyPool.dispose()
    },

    // ── Music ────────────────────────────────────────────────────────────────
    fetchMusicLoginStatus() {
      return getMusicManager().getLoginStatus()
    },
    async createMusicQrLogin() {
      return getMusicManager().createQrLogin()
    },
    async checkMusicQrLogin(key: string) {
      return getMusicManager().checkQrLogin(key)
    },
    async musicLogout() {
      return getMusicManager().logout()
    },
    async fetchMusicPlaylists() {
      return getMusicManager().fetchPlaylists()
    },
    async fetchMusicPlaylistTracks(playlistId: number) {
      return getMusicManager().fetchPlaylistTracks(playlistId)
    },
    async getMusicSongUrl(songId: number, preferredQuality?: string) {
      return getMusicManager().getSongUrl(songId, preferredQuality)
    },
    async recordMusicPlay(trackId: number) {
      return getMusicManager().recordPlay(trackId)
    },
    async fetchMusicExplorePlaylists(query?: string) {
      return getMusicManager().getExplorePlaylists(query)
    },

    // ── White Noise ─────────────────────────────────────────────────────────
    fetchWhiteNoiseScenes(): NoiseScene[] {
      return readScenes()
    },
    async generateWhiteNoiseScene(prompt: string | null): Promise<NoiseScene[]> {
      const scene = await generateScene(prompt)
      return addScene(scene)
    },
    deleteWhiteNoiseScene(sceneId: string): NoiseScene[] {
      return removeScene(sceneId)
    },
    async ensureAmbientAudio(generator: string, url?: string): Promise<string> {
      const { ensureAudioCached } = await import('../server/whitenoise/audio-cache.js')
      return ensureAudioCached(generator, url)
    },
    async readAmbientAudioBuffer(generator: string, url?: string): Promise<Buffer> {
      const { ensureAudioCached } = await import('../server/whitenoise/audio-cache.js')
      const fs = await import('node:fs')
      const filePath = await ensureAudioCached(generator, url)
      return fs.readFileSync(filePath)
    },

    // ── File System ────────────────────────────────────────────────────────
    async listFiles(request: unknown) {
      return listFiles(fileListRequestSchema.parse(request))
    },
    async searchFiles(request: unknown) {
      return searchWorkspaceFiles(fileSearchRequestSchema.parse(request))
    },
    async createFile(request: unknown) {
      await createWorkspaceFile(fileCreateRequestSchema.parse(request))
    },
    async createDirectory(request: unknown) {
      await createWorkspaceDirectory(fileCreateRequestSchema.parse(request))
    },
    async renameEntry(request: unknown) {
      await renameWorkspaceEntry(fileRenameRequestSchema.parse(request))
    },
    async moveEntry(request: unknown) {
      await moveWorkspaceEntry(fileMoveRequestSchema.parse(request))
    },
    async deleteEntry(request: unknown) {
      await deleteWorkspaceEntry(fileDeleteRequestSchema.parse(request))
    },
    async readFile(request: unknown) {
      return readWorkspaceFile(fileReadRequestSchema.parse(request))
    },
    async copyFileToClipboard(request: unknown) {
      await copyWorkspaceFileToClipboard(fileReadRequestSchema.parse(request))
    },
    async writeFile(request: unknown) {
      try {
        return await writeWorkspaceFile(fileWriteRequestSchema.parse(request))
      } catch (error) {
        // Conflicts cross the IPC bridge as structured data — Error subclasses lose
        // their custom fields during serialization, so they cannot be detected there.
        if (error instanceof FileRevisionConflictError) {
          return { conflict: true }
        }
        throw error
      }
    },
    async readNearestTsconfig(request: unknown) {
      return readNearestTsconfig(fileReadRequestSchema.parse(request))
    },
    async readGitHeadFile(request: unknown) {
      return readGitHeadFileState(gitFilePathRequestSchema.parse(request))
    },
    async readGitFileLineDiff(request: unknown) {
      return readGitFileLineDiff(gitFilePathRequestSchema.parse(request))
    },
    watchFile(workspacePath: string, relativePath: string, subscriptionId: string, listener: () => void) {
      return getFileWatcherManager().subscribe(workspacePath, relativePath, subscriptionId, listener)
    },
    unwatchFile(subscriptionId: string) {
      fileWatcherManager?.unsubscribe(subscriptionId)
    },
    disposeFileWatchers() {
      fileWatcherManager?.dispose()
      fileWatcherManager = null
    },

    // ── Proxy Stats ────────────────────────────────────────────────────────
    fetchProxyStats(since?: number) {
      return resilientProxyPool.getStats(since)
    },
    resetProxyStats() {
      resilientProxyPool.resetStats()
    },
    recordProxyStatsEvent(request: unknown) {
      recordProviderProxyStatsEvent(request)
    },

    // ── Weather ─────────────────────────────────────────────────────────────
    async fetchWeather(city?: string) {
      return fetchWeather(city)
    },

    async searchCities(query: string) {
      return searchCities(query)
    },
  }
}

export type DesktopBackend = ReturnType<typeof createDesktopBackend>
