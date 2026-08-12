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
import {
  FileWatcherManager,
  type FileWatchEvent,
  type FileWatchSubscribeResult,
} from '../server/file-watcher.ts'
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
import { proxyStats } from '../server/proxy-stats-store.ts'
import {
  buildRemoteMonitorCardHistory,
  buildRemoteMonitorSnapshot,
  createRemoteMonitorManager,
  type RemoteMonitorManager,
} from '../server/remote-monitor.ts'
import {
  forgetWorkspaceSessionMirror as forgetWorkspaceSessionMirrorState,
  publishWorkspaceSessionMirror as publishWorkspaceSessionMirrorState,
  setWorkspaceAdminCommandDispatcher,
} from '../server/automation-board-session.ts'
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
  ensureStickyNoteWorkspaceDirectory as ensureStickyNoteWorkspaceDirectoryOnDisk,
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
  workspaceSessionMirrorSchema,
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

// 聊天流的事件通道载荷：只有 subscriptionId + 事件名 + 纯数据，没有任何函数。
// 后端搬进 utilityProcess 后，这个 sink 直接换成向主进程 postMessage，
// subscribeChatStream 本身不再持有任何回调。
export type ChatStreamSubscriptionEvent = StreamEnvelope & {
  subscriptionId: string
}

export type ChatStreamSubscribeResult = {
  subscribed: boolean
}

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
  // 聊天流的唯一事件通道：所有已登记订阅的流事件都从这里出去，只带
  // subscriptionId（纯数据）。宿主按 subscriptionId 路由到对应的 webContents。
  onChatStreamEvent?: (event: ChatStreamSubscriptionEvent) => void
  // 文件监听的唯一事件通道：所有已登记订阅的变化都从这里出去，只带
  // subscriptionId（纯数据）。后端搬进 utilityProcess 后，这个 sink 直接换成
  // 向主进程 postMessage，watchFile 本身不再持有任何回调。
  onFileWatchEvent?: (event: FileWatchEvent) => void
  // 手机监工的写命令出口：宿主（electron/main.ts）把命令广播给渲染窗口，
  // 渲染进程复用电脑端 handler 执行。返回 false = 当前无窗口可执行。
  // 可返回 Promise：后端搬进 utilityProcess 后只有主进程知道"哪个窗口收下了"，
  // 投递结果必须跨进程异步回来；当前同进程的同步实现继续原样可用。
  dispatchRemoteCommand?: (command: RemoteMonitorCommand) => boolean | Promise<boolean>
  dispatchWorkspaceAdminCommand?: (command: WorkspaceAdminCommand) => boolean | Promise<boolean>
}

export const createDesktopBackend = (deps: DesktopBackendDependencies = {}) => {
  let chatManager: ChatManagerLike | null = null
  let setupManager: SetupManagerLike | null = null
  let ollamaManager: OllamaManagerLike | null = null
  let musicManager: MusicManagerLike | null = null
  let fileWatcherManager: FileWatcherManager | null = null
  let remoteMonitorManager: RemoteMonitorManager | null = null
  // subscriptionId -> ChatManager 的退订句柄。句柄留在后端内部，绝不越过接口，
  // 所以 backend 对象整体保持"纯可克隆"。
  const chatStreamSubscriptions = new Map<string, () => void>()

  // 只是登记一个回调，没有任何 IO 或路径解析，所以在这里做是安全的
  // （pitfall 79：真正的服务必须保持懒构造）。超管桥接自身仍然是懒启动的：
  // 它只在第一次有超管回合时才创建 HTTP 监听。
  setWorkspaceAdminCommandDispatcher(
    (command) => deps.dispatchWorkspaceAdminCommand?.(command) ?? false,
  )

  const getFileWatcherManager = () => {
    if (!fileWatcherManager) {
      fileWatcherManager = new FileWatcherManager((event) => {
        deps.onFileWatchEvent?.(event)
      })
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
    // 症状：发消息/切模型/关 tab/改设置都会整窗卡顿，长期使用后窗口无响应被系统杀掉。
    // 根因：2026-08-12 实测 `saveState()` 返回完整 state，而 `ipcMain.handle` 会把 handler
    // 的返回值结构化克隆送回渲染进程；用户机 state.json 实测 1,083,925 字节，UTF-16 下
    // 一趟回程约 2.1MB，但 usePersistence.ts:39 只 `await` 从不取值，纯白付。
    // 不能改在 state-store 里不返回：web 路由 server/index.ts:229 仍要用它回 HTTP 响应；
    // 也不能只在 api.ts 丢弃返回值——克隆发生在 IPC 层，只有 handler 不返回才省得下来。
    async saveState(state: AppState): Promise<void> {
      await saveState(appStateSchema.parse(state))
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
    // 显式订阅协议：调用方生成 subscriptionId，这里只收纯数据、只回纯数据，
    // 流事件走 deps.onChatStreamEvent 这条独立通道。
    //
    // 症状 — 旧形状是 subscribeChatStream(streamId, listener)，返回 unsubscribe
    //   函数或 null；main.ts 用 `if (!unsubscribe)` 判"流不存在"并给渲染进程发
    //   error，同时把函数存进 streamSubscriptions 供三处清理。
    // 根因 — 2026-08-12：后端要搬进 utilityProcess（同一批 git 操作在主进程单次
    //   最长停摆 6827ms / 11 次超 1s / 2 次超 5s，在 utilityProcess 只有 58ms /
    //   0 次），而函数不可结构化克隆。跨进程后返回值会变成恒真的 Promise：
    //   "Stream not found" 分支永久不可达，并且每次订阅都登记一条永不清理的
    //   幽灵条目——静默走错分支，不报错。
    // 为什么不能保留回调形状 — 那要求端口层为函数句柄做反向代理与生命周期管理，
    //   等于自建一套分布式 GC。改成 { subscribed } 之后，同进程与跨进程形状一致。
    subscribeChatStream(streamId: string, subscriptionId: string): ChatStreamSubscribeResult {
      // 同一个 subscriptionId 重复订阅先退掉旧的，避免两条监听叠在一张卡上。
      chatStreamSubscriptions.get(subscriptionId)?.()
      chatStreamSubscriptions.delete(subscriptionId)

      const unsubscribe = getChatManager().subscribe(streamId, (payload) => {
        deps.onChatStreamEvent?.({
          subscriptionId,
          event: payload.event,
          data: payload.data,
        } as ChatStreamSubscriptionEvent)
      })

      if (!unsubscribe) {
        return { subscribed: false }
      }

      chatStreamSubscriptions.set(subscriptionId, unsubscribe)
      return { subscribed: true }
    },
    // 幂等：重复退订、退订一个从未登记过的 id 都必须安静返回。宿主侧有三条清理
    // 路径（webContents 销毁、渲染端显式退订、will-quit），它们互相重叠。
    unsubscribeChatStream(subscriptionId: string) {
      const unsubscribe = chatStreamSubscriptions.get(subscriptionId)
      if (!unsubscribe) {
        return
      }

      chatStreamSubscriptions.delete(subscriptionId)
      unsubscribe()
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

    // ── Workspace Admin 镜像（超管权限）──────────────────────────────────────
    // 症状（跨进程后）：超管会话的 list_sessions / read_session 恒返回空，MCP
    // tools/call 全无数据，但**不报任何错**。
    // 根因：2026-08-12 核实，镜像存在 server/automation-board-session.ts:42 的
    // 模块级 `mirrors` Map。写它的是主进程（main.ts:927-938 直接 import），读它
    // 的是跑在 backend 那一侧的超管桥接；后端搬进 utilityProcess 后两侧各持一份
    // 模块副本 = 两个 Map，主进程写自己那份，桥接读另一份。
    // 为什么不能换写法：不能把 Map 提到共享层——它必须和读它的桥接在同一进程；
    // 也不能让主进程转发裸函数（跨进程只传可结构化克隆的数据）。所以写入口必须
    // 经 backend 对象，主进程只留 IPC 收发。
    // 校验也一并搬进来：截断在 publish 里跑（pitfall 183/258），schema 校验紧贴
    // 存储侧才不会被将来新增的调用方绕过。
    publishWorkspaceSessionMirror(payload: unknown): boolean {
      const parsed = workspaceSessionMirrorSchema.safeParse(payload)
      if (parsed.success) {
        publishWorkspaceSessionMirrorState(parsed.data)
      }
      return parsed.success
    },
    forgetWorkspaceSessionMirror(columnId: unknown): void {
      if (typeof columnId === 'string' && columnId.trim()) {
        forgetWorkspaceSessionMirrorState(columnId)
      }
    },

    async dispose() {
      await remoteMonitorManager?.stop()
      chatStreamSubscriptions.clear()
      chatManager?.closeAll()
      setupManager?.dispose()
      ollamaManager?.dispose()
      await resilientProxyPool.dispose()
      // Proxy stats now buffer in memory and write on a throttle, so an ordinary
      // quit has to drain them explicitly. The process-exit hook inside the store
      // is the backstop for paths that never reach dispose().
      await proxyStats.flush()
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
    // 症状（跨进程后）：`desktop:reveal-sticky-note-location` 打开的目录与后端
    // 实际写便签的目录可能不是同一次序列化下的同一份状态。
    // 根因：2026-08-12 核实，这条 handler 原本在 main.ts 里 `await import(
    // '../server/sticky-note-store.js')`，即在主进程里第二次加载该模块——它有
    // 模块级 `workspaceQueues` 写序列化 Map（sticky-note-store.ts:75），而
    // ensureStickyNoteWorkspaceDirectory 会真的 mkdir + 写 workspace.json，
    // 那次写不经过后端那份队列。
    // 为什么不能换写法：主进程仍需 `shell.openPath`（Electron-only），所以只能
    // 拆两半——路径解析/落盘留后端，打开文件夹留主进程。
    async ensureStickyNoteWorkspaceDirectory(workspacePath: string) {
      return ensureStickyNoteWorkspaceDirectoryOnDisk(workspacePath)
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
    // 显式订阅协议（与 subscribeChatStream 同形）：调用方生成 subscriptionId，
    // 这里只收纯数据、只回纯数据，变化事件走 deps.onFileWatchEvent 这条独立通道。
    watchFile(workspacePath: string, relativePath: string, subscriptionId: string): FileWatchSubscribeResult {
      return getFileWatcherManager().subscribe(workspacePath, relativePath, subscriptionId)
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
