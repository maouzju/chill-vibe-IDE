import { resolveImageAttachmentPath, storeImageAttachment } from '../server/attachments.ts'
import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import { importCcSwitchProfiles } from '../server/cc-switch-import.ts'
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  listFiles,
  moveWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from '../server/file-system.ts'
import { listExternalSessions, loadExternalSession } from '../server/external-history.ts'
import {
  commitAllGitWorkspace,
  commitGitWorkspace,
  fetchCommitDiff,
  fetchGitLog,
  initGitWorkspace,
  inspectGitWorkspace,
  pullGitWorkspace,
  pushGitWorkspace,
  setGitWorkspaceStage,
} from '../server/git-workspace.ts'
import { inspectOnboardingStatus } from '../server/onboarding-status.ts'
import {
  getProviderSlashCommands,
  getProviderStatuses,
  validateWorkspacePath,
} from '../server/providers.ts'
import { resilientProxyPool } from '../server/resilient-proxy.ts'
import { SetupManager } from '../server/setup-manager.ts'
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
  attachmentUploadRequestSchema,
  appStateSchema,
  rendererCrashCaptureRequestSchema,
  ccSwitchImportRequestSchema,
  externalHistoryListRequestSchema,
  externalSessionLoadRequestSchema,
  internalSessionHistoryLoadRequestSchema,
  chatRequestSchema,
  gitCommitAllRequestSchema,
  gitCommitDiffRequestSchema,
  gitCommitRequestSchema,
  gitLogRequestSchema,
  gitPullRequestSchema,
  gitPushRequestSchema,
  gitStageRequestSchema,
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
  type AppState,
  type AttachmentUploadRequest,
  type CcSwitchImportRequest,
  type ExternalHistoryListRequest,
  type ExternalSessionLoadRequest,
  type InternalSessionHistoryLoadRequest,
  type ChatRequest,
  type GitCommitAllRequest,
  type GitCommitDiffRequest,
  type GitCommitRequest,
  type GitLogRequest,
  type GitPullRequest,
  type GitPushRequest,
  type GitStageRequest,
  type SlashCommandRequest,
} from '../shared/schema.ts'

type StreamListener = (payload: StreamEnvelope) => void

type ChatManagerLike = Pick<ChatManager, 'closeAll' | 'createStream' | 'stop' | 'subscribe'>
type SetupManagerLike = Pick<SetupManager, 'dispose' | 'getStatus' | 'start'>
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
  createMusicManager?: () => MusicManagerLike
}

export const createDesktopBackend = (deps: DesktopBackendDependencies = {}) => {
  let chatManager: ChatManagerLike | null = null
  let setupManager: SetupManagerLike | null = null
  let musicManager: MusicManagerLike | null = null

  const getChatManager = () => {
    if (!chatManager) {
      chatManager = deps.createChatManager?.() ?? new ChatManager()
    }

    return chatManager
  }

  const getSetupManager = () => {
    if (!setupManager) {
      setupManager = deps.createSetupManager?.() ?? new SetupManager()
    }

    return setupManager
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
    runEnvironmentSetup() {
      return getSetupManager().start()
    },
    async fetchOnboardingStatus() {
      return inspectOnboardingStatus()
    },
    async fetchGitStatus(workspacePath: string) {
      return inspectGitWorkspace(gitPullRequestSchema.parse({ workspacePath }).workspacePath)
    },
    async setGitStage(request: GitStageRequest) {
      return setGitWorkspaceStage(gitStageRequestSchema.parse(request))
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
    async stopChat(streamId: string) {
      if (!getChatManager().stop(streamId)) {
        throw new Error('Unable to stop the current run.')
      }
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

    async dispose() {
      chatManager?.closeAll()
      setupManager?.dispose()
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
    async writeFile(request: unknown) {
      await writeWorkspaceFile(fileWriteRequestSchema.parse(request))
    },

    // ── Proxy Stats ────────────────────────────────────────────────────────
    fetchProxyStats(since?: number) {
      return resilientProxyPool.getStats(since)
    },
    resetProxyStats() {
      resilientProxyPool.resetStats()
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
