import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  commitGitChanges,
  fetchGitStatus,
  initGitWorkspace,
  pullGitChanges,
  setGitStage,
} from '../api'
import { defaultGitToolCardSize, minGitToolCardSize } from '../../shared/default-state'
import type { AppLanguage, GitChange, GitStatus } from '../../shared/schema'
import { getGitLocaleText } from '../../shared/i18n'
import { errorMessage, computeTotalStats, getRepositoryName } from './git-utils'
import { GitFullDialog, type GitFullDialogMode } from './GitFullDialog'
import { GitAgentPanel } from './GitAgentPanel'
import { GitSyncPanel } from './GitSyncPanel'
import { HoverTooltip } from './HoverTooltip'
import { getGitChangesSinceLastSnapshot, rememberGitChangeSnapshot } from './git-change-tracker'

type NoticeTone = 'info' | 'success' | 'error'

type NoticeState = {
  tone: NoticeTone
  message: string
}

export type GitInfoSummary = {
  repoName: string
  branch: string
  ahead: number
  behind: number
}

type GitToolCardProps = {
  workspacePath: string
  language: AppLanguage
  gitAgentModel: string
  systemPrompt: string
  isActive?: boolean
  requestedHeight: number
  onCompactHeightChange?: (height: number) => void
  onAgentPanelToggle?: (open: boolean) => void
  onGitInfoChange?: (info: GitInfoSummary | null) => void
}

const legacyGitToolCompactHeight = 190
const gitCompactBottomPadding = 12
const compactableGitCardHeights = new Set([
  minGitToolCardSize,
  defaultGitToolCardSize,
  legacyGitToolCompactHeight,
  380,
  440,
  470,
  560,
])

const getCommitNewVerb = (change: GitChange) => {
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

const buildCommitNewSummary = (language: AppLanguage, changes: GitChange[]) => {
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

export const GitToolCard = ({
  workspacePath,
  language,
  gitAgentModel,
  systemPrompt,
  isActive = true,
  requestedHeight,
  onCompactHeightChange,
  onAgentPanelToggle,
  onGitInfoChange,
}: GitToolCardProps) => {
  const text = useMemo(() => getGitLocaleText(language), [language])
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [fullDialogMode, setFullDialogMode] = useState<GitFullDialogMode | null>(null)
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [agentAnalysisPending, setAgentAnalysisPending] = useState(false)
  const [syncPanelOpen, setSyncPanelOpen] = useState(false)
  const [blockedFiles, setBlockedFiles] = useState<string[] | null>(null)
  const [commitingBlocked, setCommitingBlocked] = useState(false)
  const [commitNewPending, setCommitNewPending] = useState(false)
  const [createRepoPending, setCreateRepoPending] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const gitStatusRef = useRef<GitStatus | null>(null)
  const refreshingRef = useRef(false)
  const autoCompactedRef = useRef(false)

  useEffect(() => {
    gitStatusRef.current = gitStatus
  }, [gitStatus])

  const refreshStatus = useCallback(async (nextNotice?: NoticeState | null) => {
    const nextWorkspacePath = workspacePath.trim()

    if (!nextWorkspacePath) {
      startTransition(() => {
        setGitStatus(null)
        setLoadState('idle')
        setNotice(nextNotice ?? null)
      })
      return
    }

    if (refreshingRef.current) return
    refreshingRef.current = true

    setLoadState((current) =>
      gitStatusRef.current?.workspacePath === nextWorkspacePath ? current : 'loading',
    )

    try {
      const nextStatus = await fetchGitStatus(nextWorkspacePath)
      startTransition(() => {
        setGitStatus(nextStatus)
        setLoadState('ready')
        setNotice(nextNotice ?? null)
      })
    } catch (error) {
      startTransition(() => {
        setLoadState('error')
        setNotice({
          tone: 'error',
          message: errorMessage(error, text.refreshError),
        })
      })
    } finally {
      refreshingRef.current = false
    }
  }, [text.refreshError, workspacePath])

  useEffect(() => {
    if (!isActive) {
      return
    }

    void refreshStatus()
  }, [isActive, refreshStatus])

  useLayoutEffect(() => {
    if (autoCompactedRef.current || agentPanelOpen || !onCompactHeightChange) {
      return
    }

    if (!compactableGitCardHeights.has(requestedHeight)) {
      return
    }

    const card = cardRef.current
    const compactContent = card?.matches('.git-tool-empty-state')
      ? card
      : (card?.querySelector('.git-dashboard-compact-content, .git-dashboard-empty') as HTMLDivElement | null)

    if (!card || !compactContent) {
      return
    }

    const cardRect = card.getBoundingClientRect()
    const compactContentRect = compactContent.getBoundingClientRect()
    const compactHeight = Math.max(
      minGitToolCardSize,
      Math.ceil(compactContentRect.bottom - cardRect.top + gitCompactBottomPadding),
    )

    if (requestedHeight - compactHeight < 24) {
      return
    }

    autoCompactedRef.current = true
    onCompactHeightChange(compactHeight)
  }, [agentPanelOpen, gitStatus, loadState, notice, onCompactHeightChange, requestedHeight, syncPanelOpen])

  const hasWorkspace = workspacePath.trim().length > 0
  const isBusy = loadState === 'loading' || commitNewPending || createRepoPending
  const hasFloatingPanelOpen = agentPanelOpen || syncPanelOpen
  const createRepoButtonLabel = language === 'zh-CN' ? '创建 Git 仓库' : 'Create Git Repository'
  const creatingRepoButtonLabel = language === 'zh-CN' ? '正在创建 Git 仓库...' : 'Creating Git repository...'
  const createRepoSuccessMessage = language === 'zh-CN' ? '已创建 Git 仓库。' : 'Created a new Git repository.'
  const createRepoErrorMessage = language === 'zh-CN' ? '无法创建 Git 仓库。' : 'Unable to create the Git repository.'
  const analyzeButtonLabel = agentAnalysisPending
    ? text.analyzing.replace(/[\s.。…]+$/u, '')
    : text.analyzeChanges

  // Auto-refresh when the card gains focus (throttled to once per 3s)
  const lastRefreshRef = useRef(0)
  const handleCardFocus = useCallback(() => {
    const now = Date.now()
    if (now - lastRefreshRef.current < 3000 || isBusy) return
    lastRefreshRef.current = now
    void refreshStatus()
  }, [isBusy, refreshStatus])
  const repositoryName = getRepositoryName(gitStatus?.repoRoot ?? workspacePath)
  const totalStats = useMemo(() => computeTotalStats(gitStatus?.changes ?? []), [gitStatus?.changes])

  const prevGitInfoRef = useRef<GitInfoSummary | null>(null)

  useEffect(() => {
    if (!onGitInfoChange || !isActive) return
    if (gitStatus?.isRepository) {
      const next: GitInfoSummary = {
        repoName: repositoryName,
        branch: gitStatus.branch,
        ahead: gitStatus.ahead,
        behind: gitStatus.behind,
      }
      const prev = prevGitInfoRef.current
      if (
        prev &&
        prev.repoName === next.repoName &&
        prev.branch === next.branch &&
        prev.ahead === next.ahead &&
        prev.behind === next.behind
      ) {
        return
      }
      prevGitInfoRef.current = next
      onGitInfoChange(next)
    } else {
      if (prevGitInfoRef.current !== null) {
        prevGitInfoRef.current = null
        onGitInfoChange(null)
      }
    }
  }, [gitStatus, isActive, onGitInfoChange, repositoryName])

  const handleStatusChange = useCallback((nextStatus: GitStatus) => {
    startTransition(() => {
      setGitStatus(nextStatus)
      setLoadState('ready')
    })
  }, [])

  const handleCommitNew = useCallback(async () => {
    const nextWorkspacePath = workspacePath.trim()

    if (!nextWorkspacePath) {
      return
    }

    setCommitNewPending(true)

    try {
      const latestStatus = await fetchGitStatus(nextWorkspacePath)
      const { changedPaths, autoStagePaths } = getGitChangesSinceLastSnapshot(
        nextWorkspacePath,
        latestStatus.changes,
      )

      if (changedPaths.length === 0) {
        rememberGitChangeSnapshot(nextWorkspacePath, latestStatus.changes)
        startTransition(() => {
          handleStatusChange(latestStatus)
          setNotice({
            tone: 'info',
            message: text.commitNewEmptyCopy,
          })
        })
        return
      }

      const changedPathSet = new Set(changedPaths)
      const stagedStatus =
        autoStagePaths.length > 0
          ? await setGitStage({
              workspacePath: nextWorkspacePath,
              paths: autoStagePaths,
              staged: true,
            })
          : latestStatus
      const scopedChanges = stagedStatus.changes.filter((change) => changedPathSet.has(change.path))
      const commitPaths = scopedChanges.filter((change) => !change.conflicted).map((change) => change.path)

      if (commitPaths.length === 0) {
        rememberGitChangeSnapshot(nextWorkspacePath, stagedStatus.changes)
        startTransition(() => {
          handleStatusChange(stagedStatus)
          setNotice({
            tone: 'info',
            message: text.commitNewEmptyCopy,
          })
        })
        return
      }

      const result = await commitGitChanges({
        workspacePath: nextWorkspacePath,
        summary: buildCommitNewSummary(language, scopedChanges),
        description: '',
        paths: commitPaths,
      })

      rememberGitChangeSnapshot(nextWorkspacePath, result.status.changes)
      startTransition(() => {
        handleStatusChange(result.status)
        setNotice({
          tone: 'success',
          message: text.commitSuccess(result.commit.shortHash, result.commit.summary),
        })
      })
    } catch (error) {
      const nextNotice: NoticeState = {
        tone: 'error',
        message: errorMessage(error, text.commitError),
      }
      await refreshStatus(nextNotice)
    } finally {
      setCommitNewPending(false)
    }
  }, [handleStatusChange, language, refreshStatus, text, workspacePath])

  const handleCreateRepository = useCallback(async () => {
    const nextWorkspacePath = workspacePath.trim()

    if (!nextWorkspacePath || createRepoPending) {
      return
    }

    setCreateRepoPending(true)
    startTransition(() => {
      setNotice(null)
    })

    try {
      const result = await initGitWorkspace({ workspacePath: nextWorkspacePath })
      startTransition(() => {
        handleStatusChange(result.status)
        setNotice({
          tone: 'success',
          message: language === 'zh-CN' ? createRepoSuccessMessage : (result.message ?? createRepoSuccessMessage),
        })
      })
    } catch (error) {
      startTransition(() => {
        setNotice({
          tone: 'error',
          message: errorMessage(error, createRepoErrorMessage),
        })
      })
    } finally {
      setCreateRepoPending(false)
    }
  }, [
    createRepoErrorMessage,
    createRepoPending,
    createRepoSuccessMessage,
    handleStatusChange,
    language,
    workspacePath,
  ])

  const setAgentPanelOpenState = useCallback((next: boolean) => {
    setAgentPanelOpen(next)
    onAgentPanelToggle?.(next)
  }, [onAgentPanelToggle])

  const handleAnalyzeToggle = useCallback(() => {
    const next = !agentPanelOpen
    setAgentAnalysisPending(next)
    setAgentPanelOpenState(next)
  }, [agentPanelOpen, setAgentPanelOpenState])

  const handleCloseAgentPanel = useCallback(() => {
    setAgentAnalysisPending(false)
    setAgentPanelOpenState(false)
  }, [setAgentPanelOpenState])

  const renderNotRepositoryState = (message: string) => (
    <div ref={cardRef} className="git-tool-card git-tool-empty-state">
      <strong>{text.notRepoTitle}</strong>
      <p>{message}</p>
      <button
        type="button"
        className="git-tool-button is-primary"
        onClick={() => void handleCreateRepository()}
        disabled={createRepoPending}
      >
        {createRepoPending ? creatingRepoButtonLabel : createRepoButtonLabel}
      </button>
    </div>
  )

  // ── Early returns ────────────────────────────────────────────────────────

  if (!hasWorkspace) {
    return (
      <div ref={cardRef} className="git-tool-card git-tool-empty-state">
        <strong>{text.noWorkspaceTitle}</strong>
        <p>{text.noWorkspaceCopy}</p>
      </div>
    )
  }

  if (!gitStatus && loadState === 'loading') {
    return (
      <div ref={cardRef} className="git-tool-card git-tool-empty-state">
        <strong>{text.loading}</strong>
      </div>
    )
  }

  if (!gitStatus) {
    return (
      <div ref={cardRef} className="git-tool-card git-tool-empty-state">
        <strong>{text.notRepoTitle}</strong>
        <p>{notice?.message ?? text.notRepoCopy}</p>
        <button type="button" className="git-tool-button" onClick={() => void refreshStatus()}>
          {text.refresh}
        </button>
      </div>
    )
  }

  if (!gitStatus.isRepository) {
    return renderNotRepositoryState(notice?.message ?? gitStatus.note ?? text.notRepoCopy)
  }

  return (
    <div
      ref={cardRef}
      className={`git-tool-card${hasFloatingPanelOpen ? ' is-agent-panel-open' : ''}`}
      onFocus={handleCardFocus}
      onMouseEnter={handleCardFocus}
    >
      {/* ── Notice ─────────────────────────────────────────────────────────── */}
      {notice ? (
        <div
          className={`git-tool-notice is-${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
        </div>
      ) : null}

      {/* ── Conflict banner ────────────────────────────────────────────────── */}
      {gitStatus.hasConflicts ? (
        <div className="git-tool-conflict-banner" role="alert">
          <strong>{text.conflicted}</strong>
          <p>{text.resolveConflicts}</p>
        </div>
      ) : null}

      {/* ── Change summary (top) ─────────────────────────────────────────── */}
      {gitStatus.clean ? (
        <div className="git-dashboard-empty">
          <span style={{ fontSize: '0.85em', opacity: 0.7 }}>{text.cleanTitle}</span>
        </div>
      ) : (
        <div className="git-dashboard-compact-content">
          <div className="git-dashboard-summary-top">
            <div className="git-dashboard-summary-inline">
              <span className="git-dashboard-summary-count">
                {text.changedFiles(gitStatus.changes.length)}
              </span>
              <span className="git-dashboard-stats">
                {text.totalAddRemove(totalStats.added, totalStats.removed)}
              </span>
            </div>
            <div className="git-dashboard-actions-bar">
              <div className="git-dashboard-actions-inline">
                {/* ── Action buttons ────────────────────────────────────────── */}
                <HoverTooltip content={text.commitNewTooltip}>
                  <button
                    type="button"
                    className="git-tool-button"
                    disabled={isBusy || gitStatus.clean || syncPanelOpen || agentPanelOpen}
                    onClick={() => void handleCommitNew()}
                  >
                    {text.commitNew}
                  </button>
                </HoverTooltip>
                <HoverTooltip content={text.analyzeChangesTooltip}>
                  <button
                    type="button"
                    className="git-tool-button"
                    disabled={isBusy || gitStatus.clean || syncPanelOpen || agentAnalysisPending}
                    onClick={handleAnalyzeToggle}
                  >
                    {analyzeButtonLabel}
                  </button>
                </HoverTooltip>
              {gitStatus.upstream ? (
                <HoverTooltip content={text.syncTooltip}>
                  <button
                    type="button"
                    className="git-tool-button"
                    disabled={isBusy || syncPanelOpen || agentPanelOpen || blockedFiles !== null || commitingBlocked}
                    onClick={async () => {
                      try {
                        const result = await pullGitChanges({ workspacePath })
                        if (result.blockedFiles && result.blockedFiles.length > 0) {
                          startTransition(() => {
                            handleStatusChange(result.status)
                            setBlockedFiles(result.blockedFiles!)
                          })
                          return
                        }
                      } catch {
                        // pull failed for other reasons — let SyncPanel handle it
                      }
                      setSyncPanelOpen(true)
                    }}
                  >
                    {text.sync}
                    {(gitStatus.ahead > 0 || gitStatus.behind > 0) ? (
                      <span className="git-sync-counts">
                        {gitStatus.ahead > 0 ? <span className="git-sync-ahead">↑{gitStatus.ahead}</span> : null}
                        {gitStatus.behind > 0 ? <span className="git-sync-behind">↓{gitStatus.behind}</span> : null}
                      </span>
                    ) : null}
                  </button>
                </HoverTooltip>
              ) : null}
              <HoverTooltip content={text.openFullGitTooltip}>
                <button
                  type="button"
                  className="git-tool-button"
                  onClick={() => setFullDialogMode('full')}
                  >
                    {text.openFullGit}
                  </button>
                </HoverTooltip>
              </div>
            </div>
          </div>

          <div className="git-dashboard-file-list">
            {gitStatus.changes.map((c) => (
              <span key={c.path} className="git-dashboard-file-item" title={c.path}>{c.path}</span>
            ))}
          </div>
        </div>
      )}

      {/* ── Agent panel (analysis summary + strategy cards) ────────────────── */}
      {agentPanelOpen && gitStatus && !gitStatus.clean ? (
        <div className="git-agent-panel-shell">
          <GitAgentPanel
            gitStatus={gitStatus}
            workspacePath={workspacePath}
            language={language}
            gitAgentModel={gitAgentModel}
            systemPrompt={systemPrompt}
            onAnalysisPendingChange={setAgentAnalysisPending}
            onClose={handleCloseAgentPanel}
            onStatusChange={handleStatusChange}
          />
        </div>
      ) : null}

      {/* ── Blocked files confirmation ──────────────────────────────────── */}
      {blockedFiles !== null && !syncPanelOpen ? (
        <div className="git-agent-panel-shell">
          <div className="git-agent-panel">
            {commitingBlocked ? (
            <div className="git-agent-loading">
              <span>{text.syncStepCommit}</span>
            </div>
          ) : (
            <>
              <span>{text.syncConfirmCommitMessage(blockedFiles.length)}</span>
              <ul className="git-sync-blocked-files">
                {blockedFiles.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <div className="git-agent-error-actions">
                <button
                  type="button"
                  className="git-tool-button"
                  onClick={async () => {
                    setCommitingBlocked(true)
                    try {
                      await setGitStage({ workspacePath, paths: blockedFiles, staged: true })
                      const summary = language === 'zh-CN' ? '同步前自动提交冲突文件' : 'Auto-commit conflicting files before sync'
                      await commitGitChanges({ workspacePath, summary, description: '' })
                      const updated = await fetchGitStatus(workspacePath)
                      startTransition(() => handleStatusChange(updated))
                    } catch (error) {
                      setCommitingBlocked(false)
                      setBlockedFiles(null)
                      setNotice({ tone: 'error', message: errorMessage(error, text.commitError) })
                      return
                    }
                    setCommitingBlocked(false)
                    setBlockedFiles(null)
                    setSyncPanelOpen(true)
                  }}
                >
                  {text.syncConfirmCommitYes}
                </button>
                <button
                  type="button"
                  className="git-tool-button"
                  onClick={() => setBlockedFiles(null)}
                >
                  {text.syncConfirmCommitNo}
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      ) : null}

      {/* ── Sync panel ─────────────────────────────────────────────────────── */}
      {syncPanelOpen && gitStatus ? (
        <div className="git-agent-panel-shell">
          <GitSyncPanel
            gitStatus={gitStatus}
            workspacePath={workspacePath}
            language={language}
            gitAgentModel={gitAgentModel}
            systemPrompt={systemPrompt}
            onClose={() => setSyncPanelOpen(false)}
            onStatusChange={handleStatusChange}
          />
        </div>
      ) : null}

      {/* ── Full dialog overlay ────────────────────────────────────────────── */}
      {fullDialogMode ? (
        <GitFullDialog
          gitStatus={gitStatus}
          workspacePath={workspacePath}
          language={language}
          mode={fullDialogMode}
          onClose={() => setFullDialogMode(null)}
          onStatusChange={handleStatusChange}
        />
      ) : null}
    </div>
  )
}
