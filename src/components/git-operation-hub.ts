import {
  commitGitChanges as apiCommitGitChanges,
  fetchGitStatus as apiFetchGitStatus,
  flashWindowOnce as apiFlashWindowOnce,
  openChatStream as apiOpenChatStream,
  pullGitChanges as apiPullGitChanges,
  pushGitChanges as apiPushGitChanges,
  requestChat as apiRequestChat,
  setGitStage as apiSetGitStage,
  stopChat as apiStopChat,
} from '../api'
import type { AppLanguage, GitStatus, ModelPromptRule } from '../../shared/schema'
import {
  buildCodexChatRequestOverrides,
  defaultCodexChatSettings,
  type CodexChatSettings,
} from '../../shared/codex-chat-settings'
import { getGitLocaleText } from '../../shared/i18n'
import { getDefaultReasoningEffort } from '../../shared/reasoning'
import { buildSystemPromptForModel } from '../../shared/system-prompt'
import { errorMessage } from './git-utils'
import {
  getGitAgentAnalysisTimeouts,
  refreshGitAgentAnalysisTimeout,
} from './git-agent-stream'
import {
  buildAnalysisPrompt,
  parseAnalysisResult,
  type AnalysisResult,
  type CommitStrategy,
} from './git-agent-panel-utils'
import { getGitChangesSinceLastSnapshot, rememberGitChangeSnapshot } from './git-change-tracker'

// Git 卡片的长操作（AI 分析、策略执行、pull/push 同步、快速提交）必须在组件外存活：
// 卡片被拖到别的 pane / 列会 unmount 整个组件树，任何存在组件本地 state 里的进行中
// 状态都会被重置，挂在组件 cleanup 上的流也会被误关。这个 hub 按 workspacePath 持有
// 操作生命周期，组件只负责订阅渲染，unmount 不中断操作，remount 直接恢复画面。

export type GitAgentPhase =
  | { kind: 'idle' }
  | { kind: 'analyzing'; streamId: string }
  | { kind: 'result'; data: AnalysisResult }
  | { kind: 'executing'; strategyIndex: number; progress: string }
  | { kind: 'done'; success: boolean; message: string }
  | { kind: 'error'; message: string }

export type GitSyncStep =
  | { kind: 'idle' }
  | { kind: 'pull' }
  | { kind: 'conflict'; streamId: string }
  | { kind: 'push' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

export type GitOperationNotice = {
  tone: 'info' | 'success' | 'error'
  message: string
}

export type GitOperationSnapshot = {
  agentPanelOpen: boolean
  agentPhase: GitAgentPhase
  syncPanelOpen: boolean
  syncStep: GitSyncStep
  blockedFiles: string[] | null
  commitingBlocked: boolean
  commitNewPending: boolean
  lastStatus: GitStatus | null
  notice: GitOperationNotice | null
}

export type GitOperationContext = {
  workspacePath: string
  language: AppLanguage
  gitAgentModel: string
  systemPrompt: string
  modelPromptRules: ModelPromptRule[]
  codexChatSettings?: CodexChatSettings
  crossProviderSkillReuseEnabled: boolean
}

type ChatStreamHandlers = {
  onSession?: (payload: unknown) => void
  onDelta?: (payload: { content: string }) => void
  onAssistantMessage?: (payload: { content: string }) => void
  onActivity?: (payload: unknown) => void
  onLog?: (payload: unknown) => void
  onDone?: () => void
  onError?: (payload: { message: string }) => void
}

export type GitOperationHubDeps = {
  requestChat: (request: Record<string, unknown>) => Promise<{ streamId: string }>
  openChatStream: (streamId: string, handlers: ChatStreamHandlers) => { close: () => void }
  stopChat: (streamId: string) => Promise<unknown>
  fetchGitStatus: (workspacePath: string) => Promise<GitStatus>
  setGitStage: (request: {
    workspacePath: string
    paths: string[]
    staged: boolean
  }) => Promise<GitStatus>
  commitGitChanges: (request: {
    workspacePath: string
    summary: string
    description: string
    paths?: string[]
  }) => Promise<{ status: GitStatus; commit: { shortHash: string; summary: string } }>
  pullGitChanges: (request: {
    workspacePath: string
  }) => Promise<{ status: GitStatus; blockedFiles?: string[] }>
  pushGitChanges: (request: { workspacePath: string }) => Promise<{ status: GitStatus }>
  flashWindowOnce: () => Promise<unknown>
}

const createEmptySnapshot = (): GitOperationSnapshot => ({
  agentPanelOpen: false,
  agentPhase: { kind: 'idle' },
  syncPanelOpen: false,
  syncStep: { kind: 'idle' },
  blockedFiles: null,
  commitingBlocked: false,
  commitNewPending: false,
  lastStatus: null,
  notice: null,
})

type WorkspaceSession = {
  snapshot: GitOperationSnapshot
  listeners: Set<() => void>
  analysisStream: { close: () => void } | null
  analysisTimeout: ReturnType<typeof setTimeout> | null
  analysisDone: boolean
  analysisRunId: number
  conflictStream: { close: () => void } | null
  syncRunId: number
}

const getCommitNewVerb = (change: GitStatus['changes'][number]) => {
  switch (change.kind) {
    case 'added':
    case 'untracked':
      return { zh: '新增', en: 'Add' }
    case 'deleted':
      return { zh: '删除', en: 'Delete' }
    case 'renamed':
      return { zh: '重命名', en: 'Rename' }
    default:
      return { zh: '更新', en: 'Update' }
  }
}

const getFileLabel = (relativePath: string) =>
  relativePath.split(/[\\/]/).filter(Boolean).at(-1) ?? relativePath

export const buildCommitNewSummary = (
  language: AppLanguage,
  changes: GitStatus['changes'],
) => {
  const relevantChanges = changes.filter((change) => !change.conflicted)

  if (relevantChanges.length === 0) {
    return language === 'zh-CN' ? '提交新增改动' : 'Commit new changes'
  }

  if (relevantChanges.length === 1) {
    const change = relevantChanges[0]!
    const verb = getCommitNewVerb(change)
    return language === 'zh-CN'
      ? `${verb.zh} ${getFileLabel(change.path)}`
      : `${verb.en} ${getFileLabel(change.path)}`
  }

  const primaryVerb = getCommitNewVerb(relevantChanges[0]!)
  const mixedKinds = relevantChanges.some((change) => {
    const verb = getCommitNewVerb(change)
    return verb.zh !== primaryVerb.zh
  })

  if (language === 'zh-CN') {
    return `${mixedKinds ? '更新' : primaryVerb.zh} ${relevantChanges.length} 个文件`
  }

  return `${mixedKinds ? 'Update' : primaryVerb.en} ${relevantChanges.length} files`
}

export const createGitOperationHub = (deps: GitOperationHubDeps) => {
  const sessions = new Map<string, WorkspaceSession>()

  const getSession = (workspacePath: string): WorkspaceSession => {
    let session = sessions.get(workspacePath)
    if (!session) {
      session = {
        snapshot: createEmptySnapshot(),
        listeners: new Set(),
        analysisStream: null,
        analysisTimeout: null,
        analysisDone: false,
        analysisRunId: 0,
        conflictStream: null,
        syncRunId: 0,
      }
      sessions.set(workspacePath, session)
    }
    return session
  }

  const patch = (workspacePath: string, changes: Partial<GitOperationSnapshot>) => {
    const session = getSession(workspacePath)
    session.snapshot = { ...session.snapshot, ...changes }
    for (const listener of session.listeners) {
      listener()
    }
  }

  const settleAnalysisStream = (session: WorkspaceSession) => {
    session.analysisDone = true
    if (session.analysisTimeout) {
      clearTimeout(session.analysisTimeout)
      session.analysisTimeout = null
    }
    session.analysisStream?.close()
    session.analysisStream = null
  }

  const buildAgentRequest = (
    context: GitOperationContext,
    prompt: string,
    extras: Record<string, unknown> = {},
  ) => {
    const parts = context.gitAgentModel.trim().split(/\s+/)
    const model = parts[0] || ''
    const reasoningEffort = parts[1] || getDefaultReasoningEffort('codex')
    return {
      provider: 'codex',
      ...buildCodexChatRequestOverrides(
        'codex',
        context.codexChatSettings ?? defaultCodexChatSettings,
      ),
      workspacePath: context.workspacePath,
      language: context.language,
      systemPrompt: buildSystemPromptForModel(context.systemPrompt, model, context.modelPromptRules),
      modelPromptRules: context.modelPromptRules,
      crossProviderSkillReuseEnabled: context.crossProviderSkillReuseEnabled,
      prompt,
      model,
      reasoningEffort,
      thinkingEnabled: true,
      planMode: false,
      attachments: [],
      ...extras,
    }
  }

  const openAgentAnalysis = async (context: GitOperationContext, gitStatus: GitStatus) => {
    const { workspacePath, language } = context
    if (!workspacePath.trim()) return
    const session = getSession(workspacePath)
    const text = getGitLocaleText(language)

    settleAnalysisStream(session)
    session.analysisDone = false
    const runId = session.analysisRunId + 1
    session.analysisRunId = runId

    patch(workspacePath, { agentPanelOpen: true, agentPhase: { kind: 'idle' } })

    let accumulated = ''

    try {
      const prompt = buildAnalysisPrompt(gitStatus, language)
      const result = await deps.requestChat(
        buildAgentRequest(context, prompt, { sandboxMode: 'read-only' }),
      )

      if (session.analysisRunId !== runId) {
        // 期间被关闭或重开，本次结果不再属于当前面板
        void deps.stopChat(result.streamId).catch(() => {})
        return
      }

      patch(workspacePath, { agentPhase: { kind: 'analyzing', streamId: result.streamId } })

      const { firstByteTimeoutMs, stallTimeoutMs } = getGitAgentAnalysisTimeouts(
        gitStatus.changes.length,
      )
      const timeoutRef = {
        get current() {
          return session.analysisTimeout
        },
        set current(value: ReturnType<typeof setTimeout> | null) {
          session.analysisTimeout = value
        },
      }
      const doneRef = {
        get current() {
          return session.analysisDone
        },
        set current(value: boolean) {
          session.analysisDone = value
        },
      }
      const handleAnalysisTimeout = () => {
        if (session.analysisDone || session.analysisRunId !== runId) return
        settleAnalysisStream(session)
        void deps.stopChat(result.streamId).catch(() => {})
        patch(workspacePath, {
          agentPhase: {
            kind: 'error',
            message: language === 'zh-CN' ? '分析超时，请重试。' : 'Analysis timed out. Please try again.',
          },
        })
      }
      const refreshTimeout = (timeoutMs: number) => {
        refreshGitAgentAnalysisTimeout({
          timeoutRef,
          doneRef,
          timeoutMs,
          onTimeout: handleAnalysisTimeout,
        })
      }

      refreshTimeout(firstByteTimeoutMs)

      session.analysisStream = deps.openChatStream(result.streamId, {
        onSession: () => refreshTimeout(firstByteTimeoutMs),
        onDelta: (payload) => {
          accumulated += payload.content
          refreshTimeout(stallTimeoutMs)
        },
        onAssistantMessage: (payload) => {
          accumulated = payload.content
          refreshTimeout(stallTimeoutMs)
        },
        onActivity: () => refreshTimeout(stallTimeoutMs),
        onLog: () => refreshTimeout(stallTimeoutMs),
        onDone: () => {
          if (session.analysisRunId !== runId) return
          settleAnalysisStream(session)
          void deps.flashWindowOnce().catch(() => undefined)

          const data = parseAnalysisResult(accumulated)
          if (data) {
            patch(workspacePath, { agentPhase: { kind: 'result', data } })
            return
          }

          patch(workspacePath, {
            agentPhase: {
              kind: 'error',
              message:
                language === 'zh-CN'
                  ? '无法解析 Agent 返回的结果，请手动操作。'
                  : 'Could not parse agent result. Please commit manually.',
            },
          })
        },
        onError: (payload) => {
          if (session.analysisRunId !== runId) return
          settleAnalysisStream(session)
          patch(workspacePath, {
            agentPhase: { kind: 'error', message: payload.message || text.commitError },
          })
        },
      })
    } catch (error) {
      if (session.analysisRunId !== runId) return
      settleAnalysisStream(session)
      patch(workspacePath, {
        agentPhase: {
          kind: 'error',
          message: errorMessage(
            error,
            language === 'zh-CN' ? '无法启动分析。' : 'Unable to start analysis.',
          ),
        },
      })
    }
  }

  const closeAgentPanel = (workspacePath: string) => {
    const session = getSession(workspacePath)
    const phase = session.snapshot.agentPhase
    session.analysisRunId += 1
    if (phase.kind === 'analyzing') {
      void deps.stopChat(phase.streamId).catch(() => {})
    }
    settleAnalysisStream(session)
    patch(workspacePath, { agentPanelOpen: false, agentPhase: { kind: 'idle' } })
  }

  const executeAgentStrategy = async (
    context: GitOperationContext,
    strategy: CommitStrategy,
    strategyIndex: number,
  ) => {
    const { workspacePath, language } = context
    if (!workspacePath.trim()) return

    patch(workspacePath, {
      agentPhase: { kind: 'executing', strategyIndex, progress: '' },
    })

    let latestStatus = getSession(workspacePath).snapshot.lastStatus

    try {
      for (let i = 0; i < strategy.commits.length; i += 1) {
        const commit = strategy.commits[i]!
        patch(workspacePath, {
          agentPhase: {
            kind: 'executing',
            strategyIndex,
            progress: `${i + 1}/${strategy.commits.length}: ${commit.summary}`,
          },
        })

        latestStatus = await deps.setGitStage({
          workspacePath,
          paths: commit.paths,
          staged: true,
        })

        const result = await deps.commitGitChanges({
          workspacePath,
          summary: commit.summary,
          description: '',
        })
        latestStatus = result.status
      }

      patch(workspacePath, {
        lastStatus: latestStatus,
        agentPhase: {
          kind: 'done',
          success: true,
          message:
            language === 'zh-CN'
              ? `已按策略完成 ${strategy.commits.length} 个提交。`
              : `Completed ${strategy.commits.length} commits per strategy.`,
        },
      })
    } catch (error) {
      patch(workspacePath, {
        lastStatus: latestStatus,
        agentPhase: {
          kind: 'error',
          message: errorMessage(
            error,
            language === 'zh-CN' ? '执行策略时出错。' : 'Error executing strategy.',
          ),
        },
      })
    }
  }

  const resolveConflicts = (
    context: GitOperationContext,
    conflictStatus: GitStatus,
  ): Promise<GitStatus> => {
    const { workspacePath, language } = context
    const session = getSession(workspacePath)
    const text = getGitLocaleText(language)

    return new Promise((resolve, reject) => {
      const conflictFiles = conflictStatus.changes
        .filter((change) => change.conflicted)
        .map((change) => change.path)
        .join(', ')

      const prompt =
        language === 'zh-CN'
          ? `当前 Git 仓库在 pull 后出现了合并冲突。请自动解决以下文件的冲突，保留双方有意义的改动，然后执行 git add 暂存已解决的文件；如果 Git 仍处于合并中，请完成合并提交，让仓库恢复到可以 push 的状态：\n冲突文件: ${conflictFiles}`
          : `The Git repository has merge conflicts after pulling. Please automatically resolve the conflicts in these files, keep the meaningful changes from both sides, run git add to stage the resolved files, and if Git is still mid-merge, complete the merge commit so the repository is ready to push:\nConflict files: ${conflictFiles}`

      void deps
        .requestChat(buildAgentRequest(context, prompt))
        .then((result) => {
          patch(workspacePath, { syncStep: { kind: 'conflict', streamId: result.streamId } })

          let settled = false
          const settle = () => {
            settled = true
            clearTimeout(timeout)
            session.conflictStream?.close()
            session.conflictStream = null
          }
          const timeout = setTimeout(() => {
            if (settled) return
            settle()
            void deps.stopChat(result.streamId).catch(() => {})
            reject(new Error(language === 'zh-CN' ? '冲突解决超时。' : 'Conflict resolution timed out.'))
          }, 60000)

          session.conflictStream = deps.openChatStream(result.streamId, {
            onDone: () => {
              if (settled) return
              settle()
              void deps.flashWindowOnce().catch(() => undefined)
              void deps.fetchGitStatus(workspacePath).then(resolve, reject)
            },
            onError: (payload) => {
              if (settled) return
              settle()
              reject(new Error(payload.message || text.syncError))
            },
          })
        })
        .catch(reject)
    })
  }

  const runSyncPipeline = async (
    context: GitOperationContext,
    initialStatus: GitStatus,
    pullAlreadyDone: boolean,
  ) => {
    const { workspacePath, language } = context
    const session = getSession(workspacePath)
    const runId = session.syncRunId + 1
    session.syncRunId = runId
    const text = getGitLocaleText(language)
    let latestStatus = initialStatus

    const stillCurrent = () => session.syncRunId === runId

    if (!pullAlreadyDone) {
      patch(workspacePath, { syncStep: { kind: 'pull' } })
      let pullFailedMessage = ''

      try {
        const pullResult = await deps.pullGitChanges({ workspacePath })
        latestStatus = pullResult.status
        if (!stillCurrent()) return
        patch(workspacePath, { lastStatus: latestStatus })
      } catch (error) {
        pullFailedMessage = errorMessage(error, text.pullError)

        try {
          latestStatus = await deps.fetchGitStatus(workspacePath)
          if (!stillCurrent()) return
          patch(workspacePath, { lastStatus: latestStatus })
        } catch {
          if (!stillCurrent()) return
          patch(workspacePath, { syncStep: { kind: 'error', message: pullFailedMessage } })
          return
        }

        if (!latestStatus.hasConflicts) {
          patch(workspacePath, { syncStep: { kind: 'error', message: pullFailedMessage } })
          return
        }
      }
    }

    if (latestStatus.hasConflicts) {
      try {
        latestStatus = await resolveConflicts(context, latestStatus)
        if (!stillCurrent()) return
        patch(workspacePath, { lastStatus: latestStatus })
      } catch (error) {
        if (!stillCurrent()) return
        patch(workspacePath, {
          syncStep: { kind: 'error', message: errorMessage(error, text.syncError) },
        })
        return
      }

      if (latestStatus.hasConflicts) {
        patch(workspacePath, {
          syncStep: {
            kind: 'error',
            message:
              language === 'zh-CN'
                ? '冲突仍未解决，请先手动完成合并后再同步。'
                : 'Merge conflicts are still present. Finish the merge manually before syncing again.',
          },
        })
        return
      }
    }

    patch(workspacePath, { syncStep: { kind: 'push' } })
    try {
      const pushResult = await deps.pushGitChanges({ workspacePath })
      latestStatus = pushResult.status
      if (!stillCurrent()) return
      patch(workspacePath, {
        lastStatus: latestStatus,
        syncStep: { kind: 'done', message: text.syncSuccess },
      })
    } catch (error) {
      if (!stillCurrent()) return
      patch(workspacePath, {
        syncStep: { kind: 'error', message: errorMessage(error, text.pushError) },
      })
    }
  }

  const beginSync = async (context: GitOperationContext) => {
    const { workspacePath, language } = context
    if (!workspacePath.trim()) return
    const text = getGitLocaleText(language)

    patch(workspacePath, { syncPanelOpen: false, syncStep: { kind: 'pull' } })

    try {
      const result = await deps.pullGitChanges({ workspacePath })
      if (result.blockedFiles && result.blockedFiles.length > 0) {
        patch(workspacePath, {
          lastStatus: result.status,
          blockedFiles: result.blockedFiles,
          syncStep: { kind: 'idle' },
        })
        return
      }

      patch(workspacePath, { lastStatus: result.status, syncPanelOpen: true })
      await runSyncPipeline(context, result.status, true)
    } catch (error) {
      // pull 失败也交给同步面板的状态机接管（冲突解决 / 错误展示）
      patch(workspacePath, { syncPanelOpen: true })

      let latestStatus: GitStatus
      try {
        latestStatus = await deps.fetchGitStatus(workspacePath)
      } catch {
        patch(workspacePath, {
          syncStep: { kind: 'error', message: errorMessage(error, text.pullError) },
        })
        return
      }

      patch(workspacePath, { lastStatus: latestStatus })

      if (!latestStatus.hasConflicts) {
        patch(workspacePath, {
          syncStep: { kind: 'error', message: errorMessage(error, text.pullError) },
        })
        return
      }

      await runSyncPipeline(context, latestStatus, true)
    }
  }

  const retrySync = async (context: GitOperationContext) => {
    const session = getSession(context.workspacePath)
    const latestStatus = session.snapshot.lastStatus
    if (!latestStatus) {
      await beginSync(context)
      return
    }
    patch(context.workspacePath, { syncPanelOpen: true, syncStep: { kind: 'pull' } })
    await runSyncPipeline(context, latestStatus, false)
  }

  const closeSyncPanel = (workspacePath: string) => {
    const session = getSession(workspacePath)
    session.syncRunId += 1
    session.conflictStream?.close()
    session.conflictStream = null
    patch(workspacePath, { syncPanelOpen: false, syncStep: { kind: 'idle' } })
  }

  const confirmBlockedCommit = async (context: GitOperationContext) => {
    const { workspacePath, language } = context
    const session = getSession(workspacePath)
    const blockedFiles = session.snapshot.blockedFiles
    if (!blockedFiles || blockedFiles.length === 0) return
    const text = getGitLocaleText(language)

    patch(workspacePath, { commitingBlocked: true })

    try {
      await deps.setGitStage({ workspacePath, paths: blockedFiles, staged: true })
      const summary =
        language === 'zh-CN' ? '同步前自动提交冲突文件' : 'Auto-commit conflicting files before sync'
      await deps.commitGitChanges({ workspacePath, summary, description: '' })
      const updated = await deps.fetchGitStatus(workspacePath)
      patch(workspacePath, {
        lastStatus: updated,
        commitingBlocked: false,
        blockedFiles: null,
      })
    } catch (error) {
      patch(workspacePath, {
        commitingBlocked: false,
        blockedFiles: null,
        notice: { tone: 'error', message: errorMessage(error, text.commitError) },
      })
      return
    }

    await beginSync(context)
  }

  const dismissBlockedFiles = (workspacePath: string) => {
    patch(workspacePath, { blockedFiles: null })
  }

  const runCommitNew = async (context: GitOperationContext) => {
    const { workspacePath, language } = context
    const nextWorkspacePath = workspacePath.trim()
    if (!nextWorkspacePath) return
    const session = getSession(nextWorkspacePath)
    if (session.snapshot.commitNewPending) return
    const text = getGitLocaleText(language)

    patch(nextWorkspacePath, { commitNewPending: true })

    try {
      const latestStatus = await deps.fetchGitStatus(nextWorkspacePath)
      const { changedPaths, autoStagePaths } = getGitChangesSinceLastSnapshot(
        nextWorkspacePath,
        latestStatus.changes,
      )

      if (changedPaths.length === 0) {
        rememberGitChangeSnapshot(nextWorkspacePath, latestStatus.changes)
        patch(nextWorkspacePath, {
          lastStatus: latestStatus,
          notice: { tone: 'info', message: text.commitNewEmptyCopy },
        })
        return
      }

      const changedPathSet = new Set(changedPaths)
      const stagedStatus =
        autoStagePaths.length > 0
          ? await deps.setGitStage({
              workspacePath: nextWorkspacePath,
              paths: autoStagePaths,
              staged: true,
            })
          : latestStatus
      const scopedChanges = stagedStatus.changes.filter((change) => changedPathSet.has(change.path))
      const commitPaths = scopedChanges
        .filter((change) => !change.conflicted)
        .map((change) => change.path)

      if (commitPaths.length === 0) {
        rememberGitChangeSnapshot(nextWorkspacePath, stagedStatus.changes)
        patch(nextWorkspacePath, {
          lastStatus: stagedStatus,
          notice: { tone: 'info', message: text.commitNewEmptyCopy },
        })
        return
      }

      const result = await deps.commitGitChanges({
        workspacePath: nextWorkspacePath,
        summary: buildCommitNewSummary(language, scopedChanges),
        description: '',
        paths: commitPaths,
      })

      rememberGitChangeSnapshot(nextWorkspacePath, result.status.changes)
      patch(nextWorkspacePath, {
        lastStatus: result.status,
        notice: {
          tone: 'success',
          message: text.commitSuccess(result.commit.shortHash, result.commit.summary),
        },
      })
    } catch (error) {
      patch(nextWorkspacePath, {
        notice: { tone: 'error', message: errorMessage(error, text.commitError) },
      })
    } finally {
      patch(nextWorkspacePath, { commitNewPending: false })
    }
  }

  return {
    subscribe: (workspacePath: string, listener: () => void) => {
      const session = getSession(workspacePath)
      session.listeners.add(listener)
      return () => {
        session.listeners.delete(listener)
      }
    },
    getSnapshot: (workspacePath: string): GitOperationSnapshot =>
      getSession(workspacePath).snapshot,
    reportStatus: (workspacePath: string, status: GitStatus) => {
      const session = getSession(workspacePath)
      if (session.snapshot.lastStatus === status) return
      session.snapshot = { ...session.snapshot, lastStatus: status }
      // 状态回写来自订阅组件自身的刷新，不需要回声通知
    },
    clearNotice: (workspacePath: string) => {
      const session = getSession(workspacePath)
      if (!session.snapshot.notice) return
      patch(workspacePath, { notice: null })
    },
    openAgentAnalysis,
    closeAgentPanel,
    executeAgentStrategy,
    beginSync,
    retrySync,
    closeSyncPanel,
    confirmBlockedCommit,
    dismissBlockedFiles,
    runCommitNew,
  }
}

export type GitOperationHub = ReturnType<typeof createGitOperationHub>

export const gitOperationHub: GitOperationHub = createGitOperationHub({
  requestChat: apiRequestChat as unknown as GitOperationHubDeps['requestChat'],
  openChatStream: apiOpenChatStream as unknown as GitOperationHubDeps['openChatStream'],
  stopChat: apiStopChat,
  fetchGitStatus: apiFetchGitStatus,
  setGitStage: apiSetGitStage,
  commitGitChanges: apiCommitGitChanges,
  pullGitChanges: apiPullGitChanges,
  pushGitChanges: apiPushGitChanges,
  flashWindowOnce: apiFlashWindowOnce,
})
