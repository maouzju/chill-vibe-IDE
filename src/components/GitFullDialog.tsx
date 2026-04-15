import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  commitGitChanges,
  fetchCommitDiff,
  fetchGitLog,
  fetchGitStatus,
  pullGitChanges,
  pushGitChanges,
  setGitStage,
} from '../api'
import type { AppLanguage, GitChange, GitCommit, GitStatus } from '../../shared/schema'
import { getGitLocaleText } from '../../shared/i18n'
import { GitDiffPreview } from './GitDiffPreview'
import { CloseIcon, IconButton, SlidersIcon } from './Icons'
import {
  changeMatchesFilter,
  commitTimestamp,
  errorMessage,
  getRepositoryName,
  statusBadge,
  summarizeGitChanges,
} from './git-utils'
import {
  getGitChangesSinceLastSnapshot,
  rememberGitChangeSnapshot,
} from './git-change-tracker'
import {
  applyOptimisticGitStageState,
  mergeGitStatusPreservingPreviews,
} from './git-status-previews'
import { getVirtualizedListWindow } from './git-change-windowing'

type NoticeTone = 'info' | 'success' | 'error'

type NoticeState = {
  tone: NoticeTone
  message: string
}

type ActiveTab = 'changes' | 'history'
export type GitFullDialogMode = 'full' | 'incremental'

type GitFullDialogProps = {
  gitStatus: GitStatus
  workspacePath: string
  language: AppLanguage
  mode?: GitFullDialogMode
  onClose: () => void
  onStatusChange: (status: GitStatus) => void
}

type ChangeListMetrics = {
  scrollTop: number
  clientHeight: number
}

const gitChangeVirtualizationThreshold = 60
const gitChangeRowEstimatedHeight = 52
const gitChangeWindowOverscan = 6

const defaultCommitSummary = (language: AppLanguage) =>
  language === 'zh-CN' ? '提交信息' : 'Commit message'

const splitGitPath = (value: string) => {
  const normalized = value.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  const fileName = segments.at(-1) ?? value
  const directory = segments.slice(0, -1).join('/')

  return {
    fileName,
    directory: directory || null,
  }
}

const describeDiffState = (language: AppLanguage, change: GitChange) => {
  if (change.conflicted) {
    return language === 'zh-CN'
      ? '这个文件仍有冲突，先在编辑器里解决后再回来暂存或提交。'
      : 'This file still has conflicts. Resolve them in your editor before staging or committing.'
  }

  if (change.kind === 'untracked') {
    return language === 'zh-CN'
      ? '这是一个尚未跟踪的新文件。勾选左侧复选框后即可加入提交。'
      : 'This is a new untracked file. Select its checkbox on the left to include it in a commit.'
  }

  if (change.staged && change.workingTreeStatus !== ' ') {
    return language === 'zh-CN'
      ? '这个文件同时有已暂存和未暂存改动，右侧展示的是当前工作区补丁。'
      : 'This file has both staged and unstaged edits. The preview shows the current working-tree patch.'
  }

  if (change.staged) {
    return language === 'zh-CN'
      ? '这个文件已经加入暂存区，可以直接提交。'
      : 'This file is already staged and ready to commit.'
  }

  if (change.originalPath) {
    return language === 'zh-CN'
      ? `这个文件从 ${change.originalPath} 重命名而来。`
      : `This file was renamed from ${change.originalPath}.`
  }

  return language === 'zh-CN'
    ? '这里展示当前文件的补丁预览，方便像 GitHub Desktop 一样快速过一遍改动。'
    : 'This preview shows the file patch so you can review the change the same way you would in GitHub Desktop.'
}

export const GitFullDialog = ({
  gitStatus: initialStatus,
  workspacePath,
  language,
  mode = 'full',
  onClose,
  onStatusChange,
}: GitFullDialogProps) => {
  const text = useMemo(() => getGitLocaleText(language), [language])
  const [gitStatus, setGitStatus] = useState<GitStatus>(initialStatus)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [commitSummary, setCommitSummary] = useState('')
  const [commitDescription, setCommitDescription] = useState('')
  const [pendingStagePaths, setPendingStagePaths] = useState<Record<string, true>>({})
  const [pullPending, setPullPending] = useState(false)
  const [pushPending, setPushPending] = useState(false)
  const [commitPending, setCommitPending] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [filterValue, setFilterValue] = useState('')
  const [activeTab, setActiveTab] = useState<ActiveTab>('changes')
  const [scopedPaths, setScopedPaths] = useState<string[] | null>(mode === 'incremental' ? [] : null)
  const [optimisticStageByPath, setOptimisticStageByPath] = useState<Record<string, boolean>>({})
  const [changeListMetrics, setChangeListMetrics] = useState<ChangeListMetrics>({
    scrollTop: 0,
    clientHeight: 0,
  })
  const changeListRef = useRef<HTMLDivElement | null>(null)
  const deferredFilterValue = useDeferredValue(filterValue)

  // History state
  const [historyCommits, setHistoryCommits] = useState<GitCommit[]>([])
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null)
  const [commitDiffPatch, setCommitDiffPatch] = useState<string | null>(null)
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)

  const propagateStatus = useCallback((status: GitStatus) => {
    rememberGitChangeSnapshot(workspacePath, status.changes)
    setGitStatus(status)
    onStatusChange(status)
  }, [onStatusChange, workspacePath])

  const seedCommitSummary = useCallback(() => {
    setCommitSummary((current) =>
      current.trim().length > 0 ? current : defaultCommitSummary(language),
    )
  }, [language])

  const refreshStatus = useCallback(async (nextNotice?: NoticeState | null) => {
    try {
      const nextStatus = await fetchGitStatus(workspacePath)
      startTransition(() => {
        propagateStatus(nextStatus)
        setNotice(nextNotice ?? null)
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: errorMessage(error, text.refreshError),
      })
    }
  }, [propagateStatus, text.refreshError, workspacePath])

  const scopedChangeSet = useMemo(
    () => (mode === 'incremental' && scopedPaths ? new Set(scopedPaths) : null),
    [mode, scopedPaths],
  )
  const visibleChanges = useMemo(() => {
    const scopedChanges =
      scopedChangeSet === null
        ? gitStatus.changes
        : gitStatus.changes.filter((change) => scopedChangeSet.has(change.path))

    return scopedChanges.filter((change) => changeMatchesFilter(change, deferredFilterValue))
  }, [deferredFilterValue, gitStatus.changes, scopedChangeSet])
  const renderedChanges = useMemo(
    () =>
      visibleChanges.map((change) => {
        const optimisticStage = optimisticStageByPath[change.path]
        return typeof optimisticStage === 'boolean'
          ? applyOptimisticGitStageState(change, optimisticStage)
          : change
      }),
    [optimisticStageByPath, visibleChanges],
  )
  const visibleSummary = useMemo(() => summarizeGitChanges(renderedChanges), [renderedChanges])
  const scopedStagedPaths = useMemo(
    () => renderedChanges.filter((change) => change.staged).map((change) => change.path),
    [renderedChanges],
  )
  const syncChangeListMetrics = useCallback(() => {
    const node = changeListRef.current
    if (!node) {
      return
    }

    setChangeListMetrics((current) => {
      const next = {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
      }

      return current.scrollTop === next.scrollTop && current.clientHeight === next.clientHeight
        ? current
        : next
    })
  }, [])
  const changeListWindow = useMemo(
    () =>
      getVirtualizedListWindow({
        itemCount: renderedChanges.length,
        itemHeight: gitChangeRowEstimatedHeight,
        viewportHeight: changeListMetrics.clientHeight,
        scrollTop: changeListMetrics.scrollTop,
        overscan: gitChangeWindowOverscan,
        threshold: gitChangeVirtualizationThreshold,
      }),
    [changeListMetrics.clientHeight, changeListMetrics.scrollTop, renderedChanges.length],
  )
  const visibleChangeRows = useMemo(
    () => renderedChanges.slice(changeListWindow.startIndex, changeListWindow.endIndex),
    [changeListWindow.endIndex, changeListWindow.startIndex, renderedChanges],
  )

  useEffect(() => {
    seedCommitSummary()

    let cancelled = false

    const initializeDialog = async () => {
      try {
        const latestStatus = await fetchGitStatus(workspacePath)

        if (cancelled) {
          return
        }

        const {
          changedPaths,
          autoStagePaths,
          latestSignatures,
        } = getGitChangesSinceLastSnapshot(workspacePath, latestStatus.changes)

        // Record the newly opened snapshot up front so React's dev replay does not double-stage it.
        rememberGitChangeSnapshot(workspacePath, latestSignatures)

        const resolvedStatus =
          mode === 'incremental' && autoStagePaths.length > 0
            ? await setGitStage({
                workspacePath,
                paths: autoStagePaths,
                staged: true,
              })
            : latestStatus
        const hydratedStatus =
          mode === 'incremental' && autoStagePaths.length > 0
            ? mergeGitStatusPreservingPreviews(latestStatus, resolvedStatus)
            : resolvedStatus

        if (cancelled) {
          return
        }

        startTransition(() => {
          setScopedPaths(mode === 'incremental' ? changedPaths : null)
          propagateStatus(hydratedStatus)
          setNotice(
            mode === 'incremental' && changedPaths.length === 0
              ? {
                  tone: 'info',
                  message: text.commitNewEmptyCopy,
                }
              : null,
          )
        })
      } catch (error) {
        if (cancelled) {
          return
        }

        setNotice({
          tone: 'error',
          message: errorMessage(error, text.refreshError),
        })
      }
    }

    void initializeDialog()

    return () => {
      cancelled = true
    }
  }, [mode, propagateStatus, seedCommitSummary, text.commitNewEmptyCopy, text.refreshError, workspacePath])

  useEffect(() => {
    if (activeTab !== 'changes') return
    const nextSelectedPath = renderedChanges[0]?.path ?? null
    if (!nextSelectedPath) {
      setSelectedPath(null)
      return
    }
    if (!selectedPath || !renderedChanges.some((change) => change.path === selectedPath)) {
      setSelectedPath(nextSelectedPath)
    }
  }, [activeTab, renderedChanges, selectedPath])

  const selectedChange = useMemo(
    () => renderedChanges.find((change) => change.path === selectedPath) ?? null,
    [renderedChanges, selectedPath],
  )

  useEffect(() => {
    if (activeTab !== 'changes') {
      return
    }

    syncChangeListMetrics()

    const node = changeListRef.current
    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      syncChangeListMetrics()
    })
    resizeObserver.observe(node)

    return () => {
      resizeObserver.disconnect()
    }
  }, [activeTab, renderedChanges.length, syncChangeListMetrics])

  // Load history when switching to the history tab
  useEffect(() => {
    if (activeTab !== 'history' || historyCommits.length > 0) return

    const loadHistory = async () => {
      setHistoryLoading(true)
      try {
        const result = await fetchGitLog({ workspacePath, limit: 20, skip: 0 })
        startTransition(() => {
          setHistoryCommits(result.commits)
          setHistoryHasMore(result.hasMore)
        })
      } catch {
        // silently fail — the tab just won't show history
      } finally {
        setHistoryLoading(false)
      }
    }

    void loadHistory()
  }, [activeTab, historyCommits.length, workspacePath])

  const loadMoreHistory = async () => {
    if (historyLoading || !historyHasMore) return
    setHistoryLoading(true)
    try {
      const result = await fetchGitLog({
        workspacePath,
        limit: 20,
        skip: historyCommits.length,
      })
      startTransition(() => {
        setHistoryCommits((prev) => {
          const existingHashes = new Set(prev.map((c) => c.hash))
          const deduped = result.commits.filter((c: GitCommit) => !existingHashes.has(c.hash))
          return [...prev, ...deduped]
        })
        setHistoryHasMore(result.hasMore)
      })
    } catch {
      // silently fail
    } finally {
      setHistoryLoading(false)
    }
  }

  const handleSelectCommit = async (commit: GitCommit) => {
    setSelectedCommitHash(commit.hash)
    setCommitDiffPatch(null)
    setCommitDiffLoading(true)
    try {
      const result = await fetchCommitDiff({ workspacePath, hash: commit.hash })
      startTransition(() => {
        setCommitDiffPatch(result.patch)
      })
    } catch {
      setCommitDiffPatch(null)
    } finally {
      setCommitDiffLoading(false)
    }
  }

  const stagedCount = mode === 'incremental' ? scopedStagedPaths.length : gitStatus.summary.staged
  const hasPendingStageChanges = Object.keys(pendingStagePaths).length > 0
  const stageAllPending = pendingStagePaths.__all__ === true
  const isBusy = hasPendingStageChanges || pullPending || pushPending || commitPending
  const canCommit =
    stagedCount > 0 &&
    !gitStatus.hasConflicts &&
    commitSummary.trim().length > 0 &&
    !isBusy
  const repositoryName = getRepositoryName(gitStatus.repoRoot || workspacePath)
  const filteredChangeCount = renderedChanges.length

  const allStaged = filteredChangeCount > 0 && visibleSummary.staged === filteredChangeCount
  const someStaged = visibleSummary.staged > 0
  const showIncrementalEmpty =
    mode === 'incremental' &&
    filterValue.trim().length === 0 &&
    filteredChangeCount === 0

  const setOptimisticStageState = useCallback((paths: string[], staged: boolean) => {
    if (paths.length === 0) {
      return
    }

    setOptimisticStageByPath((current) => ({
      ...current,
      ...Object.fromEntries(paths.map((path) => [path, staged])),
    }))
  }, [])

  const clearOptimisticStageState = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return
    }

    setOptimisticStageByPath((current) => {
      let changed = false
      const next = { ...current }

      for (const path of paths) {
        if (!(path in next)) {
          continue
        }

        delete next[path]
        changed = true
      }

      return changed ? next : current
    })
  }, [])

  const markStagePending = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return
    }

    setPendingStagePaths((current) => ({
      ...current,
      ...Object.fromEntries(paths.map((path) => [path, true])),
    }))
  }, [])

  const clearStagePending = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return
    }

    setPendingStagePaths((current) => {
      let changed = false
      const next = { ...current }

      for (const path of paths) {
        if (!(path in next)) {
          continue
        }

        delete next[path]
        changed = true
      }

      return changed ? next : current
    })
  }, [])

  const handleStageAll = async (staged: boolean) => {
    const paths = renderedChanges.filter((c) => !c.conflicted && c.staged !== staged).map((c) => c.path)
    if (paths.length === 0) return
    setOptimisticStageState(paths, staged)
    markStagePending(['__all__'])
    try {
      const nextStatus = await setGitStage({ workspacePath, paths, staged })
      const hydratedStatus = mergeGitStatusPreservingPreviews(gitStatus, nextStatus)
      startTransition(() => {
        clearOptimisticStageState(paths)
        propagateStatus(hydratedStatus)
        setNotice(null)
      })
    } catch (error) {
      clearOptimisticStageState(paths)
      setNotice({
        tone: 'error',
        message: errorMessage(error, text.stageError),
      })
      await refreshStatus()
    } finally {
      clearStagePending(['__all__'])
    }
  }

  const handleStageToggle = async (change: GitChange, staged: boolean) => {
    setOptimisticStageState([change.path], staged)
    markStagePending([change.path])
    try {
      const nextStatus = await setGitStage({
        workspacePath,
        paths: [change.path],
        staged,
      })
      const hydratedStatus = mergeGitStatusPreservingPreviews(gitStatus, nextStatus)
      startTransition(() => {
        clearOptimisticStageState([change.path])
        propagateStatus(hydratedStatus)
        setNotice(null)
      })
    } catch (error) {
      clearOptimisticStageState([change.path])
      setNotice({
        tone: 'error',
        message: errorMessage(error, text.stageError),
      })
      await refreshStatus()
    } finally {
      clearStagePending([change.path])
    }
  }

  const handlePull = async () => {
    setPullPending(true)
    try {
      const result = await pullGitChanges({ workspacePath })
      startTransition(() => {
        propagateStatus(result.status)
        setNotice(result.message ? { tone: 'info', message: result.message } : null)
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: errorMessage(error, text.pullError),
      })
      await refreshStatus()
    } finally {
      setPullPending(false)
    }
  }

  const handlePush = async () => {
    setPushPending(true)
    try {
      const result = await pushGitChanges({ workspacePath })
      startTransition(() => {
        propagateStatus(result.status)
        setNotice({
          tone: 'success',
          message: result.message ?? text.pushSuccess,
        })
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: errorMessage(error, text.pushError),
      })
      await refreshStatus()
    } finally {
      setPushPending(false)
    }
  }

  const handleCommit = async () => {
    if (!canCommit) return

    const commitPaths = mode === 'incremental' ? scopedStagedPaths : undefined
    setCommitPending(true)
    try {
      const result = await commitGitChanges({
        workspacePath,
        summary: commitSummary.trim(),
        description: commitDescription.trim(),
        ...(commitPaths ? { paths: commitPaths } : {}),
      })
      startTransition(() => {
        propagateStatus(result.status)
        setCommitSummary(defaultCommitSummary(language))
        setCommitDescription('')
        setNotice({
          tone: 'success',
          message: text.commitSuccess(result.commit.shortHash, result.commit.summary),
        })
        // Invalidate history cache so it reloads
        setHistoryCommits([])
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: errorMessage(error, text.commitError),
      })
      await refreshStatus()
    } finally {
      setCommitPending(false)
    }
  }

  const handleBackdropClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  const headerActionTitle = gitStatus.upstream || (language === 'zh-CN' ? '发布仓库' : 'Publish repository')
  const headerActionSubtitle = gitStatus.upstream
    ? language === 'zh-CN'
      ? `与 ${gitStatus.upstream} 保持同步`
      : `Keep ${gitStatus.upstream} in sync`
    : language === 'zh-CN'
      ? '当前仓库还没有配置远端。'
      : 'This repository does not have a remote configured yet.'
  const commitButtonLabel =
    stagedCount > 0
      ? language === 'zh-CN'
        ? `提交 ${stagedCount} 个文件到 ${gitStatus.branch}`
        : `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'} to ${gitStatus.branch}`
      : text.commitSelected
  const summaryRequiredLabel = language === 'zh-CN' ? '必填' : 'Required'
  const selectedChangeParts = selectedChange ? splitGitPath(selectedChange.path) : null
  const selectedChangeNotice = selectedChange ? describeDiffState(language, selectedChange) : null

  const dialog = (
    <div
      className="structured-preview-layer"
      onClick={handleBackdropClick}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="structured-preview-backdrop" aria-hidden="true" />
      <div
        className="structured-preview-dialog is-git-full"
        role="dialog"
        aria-modal="true"
      >
        <div className="structured-preview-card">
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className="structured-preview-header">
            <div className="structured-preview-title git-desktop-topbar">
              <div className="git-desktop-segment is-picker">
                <span className="git-desktop-label">{text.repository}</span>
                <div className="git-desktop-picker-row">
                  <strong className="git-desktop-value">{repositoryName}</strong>
                  <span className="git-desktop-picker-chevron" aria-hidden="true" />
                </div>
              </div>

              <div className="git-desktop-segment is-picker">
                <span className="git-desktop-label">{text.branch}</span>
                <div className="git-desktop-picker-row">
                  <strong className="git-desktop-value">{gitStatus.branch}</strong>
                  <span className="git-desktop-picker-chevron" aria-hidden="true" />
                </div>
                <div className="git-desktop-branch-row">
                  {gitStatus.ahead > 0 ? <span className="git-desktop-pill">{text.ahead(gitStatus.ahead)}</span> : null}
                  {gitStatus.behind > 0 ? <span className="git-desktop-pill">{text.behind(gitStatus.behind)}</span> : null}
                </div>
              </div>

              <div className="git-desktop-segment is-actions">
                <div className="git-desktop-action-copy">
                  <strong className="git-desktop-value">{headerActionTitle}</strong>
                  <span className="git-desktop-subvalue">{headerActionSubtitle}</span>
                </div>
                <div className="git-desktop-toolbar">
                  <button
                    type="button"
                    className="git-tool-button"
                    onClick={() => void refreshStatus()}
                    disabled={isBusy}
                  >
                    {text.refresh}
                  </button>
                  <button
                    type="button"
                    className="git-tool-button"
                    onClick={() => void handlePull()}
                    disabled={isBusy}
                  >
                    {text.pull}
                  </button>
                  <button
                    type="button"
                    className="git-tool-button is-primary"
                    onClick={() => void handlePush()}
                    disabled={isBusy}
                  >
                    {text.push}
                  </button>
                </div>
              </div>
            </div>
            <div className="structured-preview-actions">
              <IconButton
                label={text.closeFullGit}
                className="git-full-close-button"
                onClick={onClose}
              >
                <CloseIcon />
              </IconButton>
            </div>
          </div>

          {/* ── Notice ──────────────────────────────────────────────────── */}
          {notice ? (
            <div
              className={`git-tool-notice is-${notice.tone}`}
              role={notice.tone === 'error' ? 'alert' : 'status'}
            >
              {notice.message}
            </div>
          ) : null}

          {/* ── Conflict banner ─────────────────────────────────────────── */}
          {gitStatus.hasConflicts ? (
            <div className="git-tool-conflict-banner" role="alert">
              <strong>{text.conflicted}</strong>
              <p>{text.resolveConflicts}</p>
            </div>
          ) : null}

          {/* ── Body: sidebar + diff panel ──────────────────────────────── */}
          <div className="git-desktop-content">
            <div className="git-tool-sidebar">
              <div className="git-tool-tabs">
                <button
                  type="button"
                  className={`git-tool-tab${activeTab === 'changes' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('changes')}
                >
                  <span>{text.changesTab}</span>
                  <span className="git-tool-tab-count">{gitStatus.changes.length}</span>
                </button>
                <button
                  type="button"
                  className={`git-tool-tab${activeTab === 'history' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  <span>{text.historyTab}</span>
                </button>
              </div>

              {activeTab === 'changes' ? (
                <>
                  <div className="git-tool-filter-bar">
                    <button
                      type="button"
                      className="git-tool-filter-button"
                      aria-label={text.filterLabel}
                      title={text.filterLabel}
                    >
                      <SlidersIcon />
                    </button>
                    <input
                      className="control git-tool-filter-input"
                      value={filterValue}
                      placeholder={text.filterPlaceholder}
                      aria-label={text.filterLabel}
                      onChange={(event) => setFilterValue(event.target.value)}
                    />
                  </div>

                  <div className="git-change-list-header">
                    <div className="git-change-list-header-top">
                      <input
                        className="git-change-checkbox"
                        type="checkbox"
                        checked={allStaged}
                        ref={(el) => { if (el) el.indeterminate = someStaged && !allStaged }}
                        disabled={
                          pullPending ||
                          pushPending ||
                          commitPending ||
                          stageAllPending ||
                          filteredChangeCount === 0
                        }
                        aria-label={allStaged ? text.unstageAll : text.stageAll}
                        onChange={() => void handleStageAll(!allStaged)}
                      />
                      <strong>{text.changedFiles(filteredChangeCount)}</strong>
                    </div>
                    <span>
                      {text.staged} {visibleSummary.staged} · {text.unstaged} {visibleSummary.unstaged} ·{' '}
                      {text.untracked} {visibleSummary.untracked}
                      {visibleSummary.conflicted > 0 ? ` · ${text.conflicted} ${visibleSummary.conflicted}` : ''}
                    </span>
                  </div>

                  <div
                    ref={changeListRef}
                    className="git-change-list"
                    data-virtualized={changeListWindow.isVirtualized ? 'true' : 'false'}
                    onScroll={syncChangeListMetrics}
                  >
                    {gitStatus.clean ? (
                      <div className="git-tool-empty-state is-inline">
                        <strong>{text.cleanTitle}</strong>
                        <p>{text.cleanCopy}</p>
                      </div>
                    ) : showIncrementalEmpty ? (
                      <div className="git-tool-empty-state is-inline">
                        <strong>{text.commitNewEmptyTitle}</strong>
                        <p>{text.commitNewEmptyCopy}</p>
                      </div>
                    ) : filteredChangeCount === 0 ? (
                      <div className="git-tool-empty-state is-inline">
                        <strong>{text.noMatchesTitle}</strong>
                        <p>{text.noMatchesCopy}</p>
                      </div>
                    ) : (
                      <>
                        {changeListWindow.topSpacerHeight > 0 ? (
                          <div
                            aria-hidden="true"
                            style={{
                              flex: '0 0 auto',
                              height: `${changeListWindow.topSpacerHeight}px`,
                            }}
                          />
                        ) : null}
                        {visibleChangeRows.map((change) => {
                          const toggleDisabled =
                            pullPending ||
                            pushPending ||
                            commitPending ||
                            stageAllPending ||
                            change.conflicted ||
                            pendingStagePaths[change.path] === true
                          const isSelected = change.path === selectedChange?.path
                          const pathParts = splitGitPath(change.path)
                          const secondaryPath = change.originalPath ?? pathParts.directory

                          return (
                            <div
                              key={`${change.path}:${change.stagedStatus}:${change.workingTreeStatus}`}
                              className={`git-change-row${change.conflicted ? ' is-conflicted' : ''}${change.staged ? ' is-staged' : ''}${isSelected ? ' is-selected' : ''}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => setSelectedPath(change.path)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  setSelectedPath(change.path)
                                }
                              }}
                            >
                              <input
                                className="git-change-checkbox"
                                type="checkbox"
                                checked={change.staged}
                                disabled={toggleDisabled}
                                aria-label={
                                  change.staged ? text.stagedToggleOff(change.path) : text.stagedToggleOn(change.path)
                                }
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => void handleStageToggle(change, event.target.checked)}
                              />
                              <span className="git-change-copy">
                                <span className="git-change-header">
                                  <span className="git-change-path">{pathParts.fileName}</span>
                                  {secondaryPath ? (
                                    <span className="git-change-origin">{secondaryPath}</span>
                                  ) : null}
                                </span>
                                {change.conflicted ? (
                                  <span className="git-change-note">{text.markResolved}</span>
                                ) : null}
                              </span>
                              <span className="git-change-meta">
                                <span className={`git-change-status is-${change.kind}`}>{statusBadge(change)}</span>
                                {(typeof change.addedLines === 'number' || typeof change.removedLines === 'number') ? (
                                  <span className="git-change-stats">
                                    {typeof change.addedLines === 'number' ? (
                                      <span className="structured-diff-stat is-added">{`+${change.addedLines}`}</span>
                                    ) : null}
                                    {typeof change.removedLines === 'number' ? (
                                      <span className="structured-diff-stat is-removed">{`-${change.removedLines}`}</span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          )
                        })}
                        {changeListWindow.bottomSpacerHeight > 0 ? (
                          <div
                            aria-hidden="true"
                            style={{
                              flex: '0 0 auto',
                              height: `${changeListWindow.bottomSpacerHeight}px`,
                            }}
                          />
                        ) : null}
                      </>
                    )}
                  </div>

                  <div className="git-commit-panel">
                    <div className="git-commit-header">
                      <div className="git-commit-avatar" aria-hidden="true">
                        {repositoryName.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="git-commit-header-copy">
                        <strong>{text.composeCommit}</strong>
                        <span>{text.commitSelected}</span>
                      </div>
                    </div>

                    <label className="git-commit-field">
                      <span className="git-commit-field-label">
                        <span>{text.summary}</span>
                        <em>{summaryRequiredLabel}</em>
                      </span>
                      <input
                        className="control git-commit-summary"
                        value={commitSummary}
                        placeholder={text.commitPlaceholder}
                        onChange={(event) => setCommitSummary(event.target.value)}
                        onBlur={seedCommitSummary}
                      />
                    </label>

                    <label className="git-commit-field">
                      <span>{text.description}</span>
                      <textarea
                        className="control textarea git-commit-description"
                        rows={4}
                        value={commitDescription}
                        placeholder={text.descriptionPlaceholder}
                        onChange={(event) => setCommitDescription(event.target.value)}
                      />
                    </label>

                    <button
                      type="button"
                      className="git-tool-button is-primary is-block"
                      aria-label={text.commitSelected}
                      disabled={!canCommit}
                      onClick={() => void handleCommit()}
                    >
                      {commitButtonLabel}
                    </button>

                    {gitStatus.lastCommit ? (
                      <div className="git-commit-footer">
                        <span className="git-commit-footer-label">{text.lastCommit}</span>
                        <strong>{gitStatus.lastCommit.summary}</strong>
                        <span>
                          {gitStatus.lastCommit.shortHash} / {gitStatus.lastCommit.authorName} /{' '}
                          {commitTimestamp(language, gitStatus.lastCommit.authoredAt)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="git-history-list">
                  {historyCommits.length === 0 && !historyLoading ? (
                    <div className="git-tool-empty-state is-inline">
                      <strong>{text.noHistoryTitle}</strong>
                      <p>{text.noHistoryCopy}</p>
                    </div>
                  ) : (
                    <>
                      {historyCommits.map((commit) => (
                        <div
                          key={commit.hash}
                          className={`git-history-row${selectedCommitHash === commit.hash ? ' is-selected' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => void handleSelectCommit(commit)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void handleSelectCommit(commit)
                            }
                          }}
                        >
                          <strong>{commit.summary}</strong>
                          <span>
                            {commit.shortHash} / {commit.authorName}
                          </span>
                          <span>{commitTimestamp(language, commit.authoredAt)}</span>
                        </div>
                      ))}
                      {historyHasMore ? (
                        <button
                          type="button"
                          className="git-tool-button is-block"
                          disabled={historyLoading}
                          onClick={() => void loadMoreHistory()}
                        >
                          {historyLoading ? text.loading : text.loadMore}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="git-tool-diff-panel">
              {activeTab === 'changes' ? (
                selectedChange ? (
                  <>
                    <div className="git-tool-diff-header">
                      <div className="git-tool-diff-title">
                        <span className="git-tool-diff-eyebrow">{text.diffPreview}</span>
                        <strong>{selectedChangeParts?.fileName ?? selectedChange.path}</strong>
                        {selectedChangeParts?.directory ? (
                          <span className="git-tool-diff-origin">{selectedChangeParts.directory}</span>
                        ) : null}
                      </div>
                      <div className="git-tool-diff-stats">
                        {typeof selectedChange.addedLines === 'number' ? (
                          <span className="structured-diff-stat is-added">{`+${selectedChange.addedLines}`}</span>
                        ) : null}
                        {typeof selectedChange.removedLines === 'number' ? (
                          <span className="structured-diff-stat is-removed">{`-${selectedChange.removedLines}`}</span>
                        ) : null}
                      </div>
                    </div>

                    {selectedChangeNotice ? (
                      <div className={`git-tool-diff-notice${selectedChange.conflicted ? ' is-warning' : ''}`}>
                        {selectedChangeNotice}
                      </div>
                    ) : null}

                    <GitDiffPreview
                      patch={selectedChange.patch}
                      emptyTitle={text.noDiffTitle}
                      emptyCopy={text.noDiffCopy}
                    />
                  </>
                ) : (
                  <div className="git-tool-diff-empty">
                    <strong>{text.selectChangeTitle}</strong>
                    <p>{text.selectChangeCopy}</p>
                  </div>
                )
              ) : selectedCommitHash ? (
                commitDiffLoading ? (
                  <div className="git-tool-diff-empty">
                    <strong>{text.loading}</strong>
                  </div>
                ) : (
                  <GitDiffPreview
                    patch={commitDiffPatch ?? ''}
                    emptyTitle={text.noDiffTitle}
                    emptyCopy={text.noDiffCopy}
                  />
                )
              ) : (
                <div className="git-tool-diff-empty">
                  <strong>{text.selectChangeTitle}</strong>
                  <p>{text.selectChangeCopy}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(dialog, document.body)
}
