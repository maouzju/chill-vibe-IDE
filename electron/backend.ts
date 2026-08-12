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
import { loadCompactedCardHistoryForDisplay } from '../server/compacted-card-history.ts'
import { getAppDataDir } from '../server/app-paths.ts'
import { forkProviderSession } from '../server/session-fork.ts'
import {
  getClaudeNativeTurnCompletion,
  getCodexNativeTurnCompletion,
} from '../server/native-turn-completion.ts'
import {
  hideInternalSessionHistoryEntries,
  listInternalSessionHistory,
  runSessionHistoryCatalogMaintenanceSlice,
} from '../server/session-history-catalog.ts'
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
  readCodexManagementPolicy,
  recordProviderProxyStatsEvent,
  getProviderStatuses,
  setProviderRuntimeSettingsOverride,
  validateWorkspacePath,
} from '../server/providers.ts'
import {
  buildRemoteMonitorCardHistory,
  buildRemoteMonitorSnapshot,
  createRemoteMonitorManager,
  type RemoteMonitorManager,
} from '../server/remote-monitor.ts'
import { setWorkspaceAdminCommandDispatcher } from '../server/automation-board-session.ts'
import { resilientProxyPool } from '../server/resilient-proxy.ts'
import { SetupManager } from '../server/setup-manager.ts'
import { OllamaManager } from '../server/ollama-manager.ts'
import {
  captureRendererCrash as captureRendererCrashState,
  dismissRecentCrashRecovery as dismissRecentCrashRecoveryState,
  loadStateForRenderer,
  loadSessionHistoryEntry as loadInternalSessionHistoryEntry,
  loadClosedWorkspaceSnapshot as loadClosedWorkspaceSnapshotState,
  queueSaveState,
  resetState,
  resolveStateRecoveryOption as resolveStateRecoverySelection,
  saveClosedWorkspaceSnapshot as saveClosedWorkspaceSnapshotState,
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
  listStickyNotes,
  loadStickyNote,
  loadStickyNoteVersion,
  restoreStickyNoteVersion,
  saveStickyNote,
  searchStickyNotes,
} from '../server/sticky-note-store.ts'
import {
  appSettingsSchema,
  attachmentUploadRequestSchema,
  appStateSchema,
  compactedCardHistoryLoadRequestSchema,
  closedWorkspaceLoadRequestSchema,
  closedWorkspaceSnapshotSchema,
  rendererCrashCaptureRequestSchema,
  ccSwitchImportRequestSchema,
  externalHistoryListRequestSchema,
  externalSessionLoadRequestSchema,
  internalSessionHistoryHideRequestSchema,
  internalSessionHistoryListRequestSchema,
  internalSessionHistoryLoadRequestSchema,
  chatRequestSchema,
  forkSessionRequestSchema,
  nativeTurnCompletionRequestSchema,
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
  stickyNoteListRequestSchema,
  stickyNoteRequestSchema,
  stickyNoteSaveRequestSchema,
  stickyNoteSearchRequestSchema,
  stickyNoteVersionRequestSchema,
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
  type ClosedWorkspaceLoadRequest,
  type ClosedWorkspaceSnapshot,
  type CcSwitchImportRequest,
  type CompactedCardHistoryLoadRequest,
  type ExternalHistoryListRequest,
  type ExternalSessionLoadRequest,
  type InternalSessionHistoryHideRequest,
  type InternalSessionHistoryListRequest,
  type InternalSessionHistoryLoadRequest,
  type ChatRequest,
  type WorkspaceAdminCommand,
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
  dispatchWorkspaceAdminCommand?: (command: WorkspaceAdminCommand) => boolean
}

export const createDesktopBackend = (deps: DesktopBackendDependencies = {}) => {
  let chatManager: ChatManagerLike | null = null
  let setupManager: SetupManagerLike | null = null
  let ollamaManager: OllamaManagerLike | null = null
  let musicManager: MusicManagerLike | null = null
  let fileWatcherManager: FileWatcherManager | null = null
  let remoteMonitorManager: RemoteMonitorManager | null = null

  // 只是登记一个回调，没有任何 IO 或路径解析，所以在这里做是安全的
  // （pitfall 79：真正的服务必须保持懒构造）。超管桥接自身仍然是懒启动的：
  // 它只在第一次有超管回合时才创建 HTTP 监听。
  setWorkspaceAdminCommandDispatcher(
    (command) => deps.dispatchWorkspaceAdminCommand?.(command) ?? false,
  )

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
        loadCardHistory: async (cardId) => {
          const response = await loadStateForRenderer()
          for (const column of response.state.columns) {
            const card = column.cards[cardId]
            if (card) {
              return buildRemoteMonitorCardHistory(card.messages)
            }
          }
          return null
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
    async loadCompactedCardHistory(request: CompactedCardHistoryLoadRequest) {
      const parsed = compactedCardHistoryLoadRequestSchema.parse(request)
      return loadCompactedCardHistoryForDisplay(getAppDataDir(), parsed.cardId)
    },
    async saveClosedWorkspaceSnapshot(snapshot: ClosedWorkspaceSnapshot) {
      return saveClosedWorkspaceSnapshotState(closedWorkspaceSnapshotSchema.parse(snapshot))
    },
    async loadClosedWorkspaceSnapshot(request: ClosedWorkspaceLoadRequest) {
      return loadClosedWorkspaceSnapshotState(closedWorkspaceLoadRequestSchema.parse(request))
    },
    async listInternalSessionHistory(request: InternalSessionHistoryListRequest) {
      const parsed = internalSessionHistoryListRequestSchema.parse(request)
      await runSessionHistoryCatalogMaintenanceSlice().catch(() => undefined)
      return listInternalSessionHistory(parsed)
    },
    async hideInternalSessionHistory(request: InternalSessionHistoryHideRequest) {
      await hideInternalSessionHistoryEntries(internalSessionHistoryHideRequestSchema.parse(request))
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
    async fetchCodexManagementPolicy() {
      return readCodexManagementPolicy()
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
    async getNativeTurnCompletion(request: unknown) {
      const parsed = nativeTurnCompletionRequestSchema.parse(request)
      // 症状：packaged Electron 中 Codex 原生已 task_complete，恢复层仍得到 unknown 并幽灵续跑。
      // 根因：2026-07-28 实测此 Claude-only 早退让下方 Codex 分支永久不可达。
      // 不能只靠浏览器路由测试；桌面 bridge 必须对两种 provider 都透传（Known Pitfall #225）。
      return {
        completion: parsed.provider === 'claude'
          ? await getClaudeNativeTurnCompletion(parsed.sessionId)
          : await getCodexNativeTurnCompletion(parsed.sessionId),
      }
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
      // The result is still returned: settlingWithinMs tells the renderer how long
      // the terminal envelope was deliberately deferred for the settling workspace
      // diff, so its own no-server-ack fallback can stand down for that long.
      return getChatManager().stop(streamId)
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
    async listStickyNotes(request: unknown) {
      return listStickyNotes(stickyNoteListRequestSchema.parse(request))
    },
    async loadStickyNote(request: unknown) {
      return loadStickyNote(stickyNoteRequestSchema.parse(request))
    },
    async saveStickyNote(request: unknown) {
      return saveStickyNote(stickyNoteSaveRequestSchema.parse(request))
    },
    async searchStickyNotes(request: unknown) {
      return searchStickyNotes(stickyNoteSearchRequestSchema.parse(request))
    },
    async loadStickyNoteVersion(request: unknown) {
      return loadStickyNoteVersion(stickyNoteVersionRequestSchema.parse(request))
    },
    async restoreStickyNoteVersion(request: unknown) {
      return restoreStickyNoteVersion(stickyNoteVersionRequestSchema.parse(request))
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
