import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'

import { minColumnWidth } from '../../shared/default-state'
import { formatLocalizedDateTime, getLocaleText } from '../../shared/i18n'
import type {
  AppLanguage,
  AutoUrgeProfile,
  BoardColumn,
  ExternalSessionSummary,
  ImageAttachment,
  ModelPromptRule,
  Provider,
  ProviderStatus,
  RecentWorkspace,
  SessionHistoryEntry,
} from '../../shared/schema'
import { listExternalHistory, loadExternalSession } from '../api'
import { resizeColumnGroups } from '../column-resize'
import { clearDragPayload, readDragPayload, type Placement, writeDragPayload } from '../dnd'
import type { CardRecoveryStatus } from '../stream-recovery-feedback'
import type { QueuedSendSummary, SendMessageOptions } from './deferred-send-queue'
import { areWorkspaceColumnPropsEqual } from './layout-memoization'
import { filterExternalSessionHistory, filterSessionHistoryEntries, hasSessionHistorySearch } from './workspace-column-history'
import { CloseIcon, FolderIcon, HistoryIcon, IconButton } from './Icons'
import { LayoutRenderer } from './LayoutRenderer'

const openFolderNative = async (): Promise<FolderDialogResult> => {
  if (typeof window === 'undefined' || typeof window.electronAPI?.openFolderDialog !== 'function') {
    return {
      status: 'error',
      message: 'Electron desktop bridge is unavailable.',
    }
  }

  try {
    const picked = await (window as Window & typeof globalThis & {
      electronAPI?: {
        openFolderDialog?: () => Promise<string | null>
      }
    }).electronAPI?.openFolderDialog?.()
    return picked ? { status: 'selected', path: picked } : { status: 'cancelled' }
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

type FolderDialogResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

const getFixedColumnFlexStyle = (width: number) => ({
  flexBasis: width,
  flexGrow: width,
  flexShrink: 1,
})

type WorkspaceColumnProps = {
  column: BoardColumn
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  crossProviderSkillReuseEnabled: boolean
  musicAlbumCoverEnabled: boolean
  weatherCity: string
  gitAgentModel: string
  brainstormRequestModel: string
  availableQuickToolModels: string[]
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  onSetAutoUrgeEnabled: (enabled: boolean) => void
  onChangeColumn: (
    patch: Partial<Pick<BoardColumn, 'title' | 'provider' | 'workspacePath' | 'model'>>,
  ) => void
  onChangeCardModel: (cardId: string, provider: Provider, model: string) => void
  onChangeCardReasoningEffort: (cardId: string, reasoningEffort: string) => void
  onToggleCardPlanMode: (cardId: string) => void
  onToggleCardThinking: (cardId: string) => void
  onToggleCardCollapsed: (cardId: string) => void
  onMarkCardRead: (cardId: string) => void
  onChangeCardDraft: (cardId: string, draft: string) => void
  onChangeCardStickyNote: (cardId: string, content: string) => void
  onPatchCard: (
    cardId: string,
    patch: Partial<
      Pick<
        BoardColumn['cards'][string],
        | 'status'
        | 'sessionId'
        | 'brainstorm'
        | 'autoUrgeActive'
        | 'autoUrgeProfileId'
      >
    >,
  ) => void
  onChangeCardTitle: (cardId: string, title: string) => void
  onReorderColumn: (sourceColumnId: string, targetColumnId: string, placement: Placement) => void
  onRemoveColumn: () => void
  onResizeColumn: (widths: Array<{ columnId: string; width: number }>) => void
  onAddTab: (paneId: string) => void
  onSplitPane: (
    paneId: string,
    direction: 'horizontal' | 'vertical',
    placement?: Placement,
    tabId?: string,
    newPaneId?: string,
  ) => void
  onSplitMoveTab: (
    sourcePaneId: string,
    targetPaneId: string,
    tabId: string,
    direction: 'horizontal' | 'vertical',
    placement: Placement,
    newPaneId: string,
  ) => void
  onCloseTab: (paneId: string, tabId: string) => void
  onMoveTab: (
    sourceColumnId: string,
    sourcePaneId: string,
    tabId: string,
    targetColumnId: string,
    targetPaneId: string,
    index?: number,
  ) => void
  onReorderTab: (paneId: string, tabId: string, index: number) => void
  onSetActiveTab: (paneId: string, tabId: string) => void
  onResizePane: (splitId: string, ratios: number[]) => void
  onActivatePane: (paneId: string) => void
  onSendMessage: (
    cardId: string,
    prompt: string,
    attachments: ImageAttachment[],
    options?: SendMessageOptions,
  ) => Promise<void>
  onStopMessage: (cardId: string) => Promise<void>
  onCancelQueuedSends?: (cardId: string) => void
  onSendNextQueuedNow?: (cardId: string) => void
  onManualRecoverStream?: (cardId: string) => Promise<unknown>
  onForkConversation?: (cardId: string, messageId: string) => void
  onOpenFile?: (paneId: string, relativePath: string) => void
  recentWorkspaces: RecentWorkspace[]
  onRecordRecentWorkspace: (path: string) => void
  onRemoveRecentWorkspaces: (paths: string[]) => void
  sessionHistory: SessionHistoryEntry[]
  onRestoreSession: (entryId: string) => void
  onImportExternalSession: (entry: SessionHistoryEntry) => void
  cardRecoveryStatuses?: ReadonlyMap<string, CardRecoveryStatus>
  queuedSendSummaries?: ReadonlyMap<string, QueuedSendSummary>
}

const getHorizontalPlacement = (event: DragEvent<HTMLElement>) => {
  const bounds = event.currentTarget.getBoundingClientRect()
  return event.clientX <= bounds.left + bounds.width / 2 ? 'before' : 'after'
}

const WorkspaceColumnView = ({
  column,
  providers,
  language,
  systemPrompt,
  modelPromptRules = [],
  crossProviderSkillReuseEnabled,
  musicAlbumCoverEnabled,
  weatherCity,
  gitAgentModel,
  brainstormRequestModel,
  availableQuickToolModels,
  autoUrgeEnabled,
  autoUrgeProfiles = [],
  autoUrgeMessage,
  autoUrgeSuccessKeyword,
  onSetAutoUrgeEnabled,
  onChangeColumn,
  onChangeCardModel,
  onChangeCardReasoningEffort,
  onToggleCardPlanMode,
  onToggleCardThinking,
  onToggleCardCollapsed,
  onMarkCardRead,
  onChangeCardDraft,
  onChangeCardStickyNote,
  onPatchCard,
  onChangeCardTitle,
  onReorderColumn,
  onRemoveColumn,
  onResizeColumn,
  onAddTab,
  onSplitPane,
  onSplitMoveTab,
  onCloseTab,
  onMoveTab,
  onReorderTab,
  onSetActiveTab,
  onResizePane,
  onActivatePane,
  onSendMessage,
  onStopMessage,
  onCancelQueuedSends,
  onSendNextQueuedNow,
  onManualRecoverStream,
  onForkConversation,
  onOpenFile,
  recentWorkspaces,
  onRecordRecentWorkspace,
  onRemoveRecentWorkspaces,
  sessionHistory,
  onRestoreSession,
  onImportExternalSession,
  cardRecoveryStatuses,
  queuedSendSummaries,
}: WorkspaceColumnProps) => {
  const text = getLocaleText(language)
  const [editingPath, setEditingPath] = useState(() => !column.workspacePath.trim())
  const [pathValue, setPathValue] = useState(column.workspacePath)
  const [pathPickerNotice, setPathPickerNotice] = useState<{
    tone: 'info' | 'error'
    message: string
  } | null>(null)
  const [columnDropHint, setColumnDropHint] = useState<Placement | null>(null)
  const [columnDragging, setColumnDragging] = useState(false)
  const isColumnResizingRef = useRef(false)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [recentMenuView, setRecentMenuView] = useState<false | 'list' | 'clear'>(() =>
    !column.workspacePath.trim() ? 'list' : false,
  )
  const [clearSelection, setClearSelection] = useState<Set<string>>(new Set())
  const recentMenuRef = useRef<HTMLDivElement>(null)
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false)
  const [historyTab, setHistoryTab] = useState<'internal' | 'external'>('internal')
  const [historySearch, setHistorySearch] = useState('')
  const [externalSessions, setExternalSessions] = useState<ExternalSessionSummary[]>([])
  const [externalLoading, setExternalLoading] = useState(false)
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null)
  const historyMenuRef = useRef<HTMLDivElement>(null)
  const [flashCardIds, setFlashCardIds] = useState<Set<string>>(new Set())
  const previousCardIdsRef = useRef<Set<string>>(new Set(Object.keys(column.cards)))
  const deferredHistorySearch = useDeferredValue(historySearch)
  const filteredSessionHistory = useMemo(
    () => filterSessionHistoryEntries(sessionHistory, deferredHistorySearch),
    [deferredHistorySearch, sessionHistory],
  )
  const filteredExternalSessions = useMemo(
    () => filterExternalSessionHistory(externalSessions, deferredHistorySearch),
    [deferredHistorySearch, externalSessions],
  )
  const hasHistorySearch = hasSessionHistorySearch(deferredHistorySearch)

  const closeHistoryMenu = useCallback(() => {
    setHistoryMenuOpen(false)
    setHistorySearch('')
  }, [])

  useEffect(() => {
    setPathValue(column.workspacePath)
  }, [column.workspacePath])

  useEffect(() => {
    const previous = previousCardIdsRef.current
    const nextIds = new Set(Object.keys(column.cards))
    const added = Object.keys(column.cards).filter((cardId) => !previous.has(cardId))
    previousCardIdsRef.current = nextIds
    if (added.length > 0) {
      setFlashCardIds((current) => {
        const next = new Set(current)
        for (const cardId of added) {
          const card = column.cards[cardId]
          if (card && card.messages.length > 0) {
            next.add(cardId)
          }
        }
        return next.size === current.size ? current : next
      })
    }
  }, [column.cards])

  useEffect(() => {
    if (!recentMenuView) {
      return
    }

    const handleOutsideClick = (event: globalThis.MouseEvent) => {
      if (recentMenuRef.current && !recentMenuRef.current.contains(event.target as Node)) {
        setRecentMenuView(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [recentMenuView])

  useEffect(() => {
    if (!historyMenuOpen) {
      return
    }

    const handleOutsideClick = (event: globalThis.MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(event.target as Node)) {
        closeHistoryMenu()
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [closeHistoryMenu, historyMenuOpen])

  useEffect(() => {
    if (!historyMenuOpen || historyTab !== 'external' || !column.workspacePath.trim()) {
      return
    }

    let cancelled = false
    setExternalLoading(true)

    listExternalHistory({ workspacePath: column.workspacePath })
      .then((response) => {
        if (!cancelled) {
          setExternalSessions(response.sessions)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExternalSessions([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExternalLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [column.workspacePath, historyMenuOpen, historyTab])

  const commitPath = () => {
    setEditingPath(false)
    setRecentMenuView(false)
    const trimmed = pathValue.trim()
    onChangeColumn({ workspacePath: pathValue })
    if (trimmed) {
      onRecordRecentWorkspace(trimmed)
    }
  }

  const startEditing = () => {
    closeHistoryMenu()
    setEditingPath(true)
    setRecentMenuView('list')
    setClearSelection(new Set())
    window.setTimeout(() => pathInputRef.current?.focus(), 0)
  }

  const openSessionHistory = () => {
    setEditingPath(false)
    setRecentMenuView(false)
    setHistoryTab('internal')
    setHistorySearch('')
    setHistoryMenuOpen(true)
  }

  const handlePathEditorBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return
    }

    if (nextTarget instanceof Node && recentMenuRef.current?.contains(nextTarget)) {
      return
    }

    commitPath()
  }

  const handleFolderClick = (event: MouseEvent) => {
    event.stopPropagation()
    void (async () => {
      const result = await openFolderNative()
      if (result.status === 'selected') {
        setPathPickerNotice(null)
        setPathValue(result.path)
        onChangeColumn({ workspacePath: result.path })
        onRecordRecentWorkspace(result.path)
        setEditingPath(false)
        setRecentMenuView(false)
        return
      }

      if (result.status === 'error') {
        setPathPickerNotice({
          tone: 'error',
          message: text.pathPickerOpenFailed(result.message),
        })
        startEditing()
        return
      }

      setPathPickerNotice(null)
      startEditing()
    })()
  }

  const handleColumnDragStart = (event: DragEvent<HTMLElement>) => {
    if (editingPath) {
      event.preventDefault()
      return
    }

    setColumnDragging(true)
    writeDragPayload(event, { type: 'column', columnId: column.id })
  }

  const handleColumnDragOver = (event: DragEvent<HTMLElement>) => {
    const payload = readDragPayload(event)
    if (payload?.type !== 'column' || payload.columnId === column.id) {
      return
    }

    event.preventDefault()
    setColumnDropHint(getHorizontalPlacement(event))
  }

  const handleColumnDrop = (event: DragEvent<HTMLElement>) => {
    const payload = readDragPayload(event)
    if (payload?.type !== 'column' || payload.columnId === column.id) {
      return
    }

    event.preventDefault()
    onReorderColumn(payload.columnId, column.id, getHorizontalPlacement(event))
    clearDragPayload()
    setColumnDropHint(null)
  }

  const handleImportExternalSession = async (session: ExternalSessionSummary) => {
    setImportingSessionId(session.id)

    try {
      const response = await loadExternalSession({
        provider: session.provider,
        sessionId: session.id,
        workspacePath: session.workspacePath,
      })

      onImportExternalSession(response.entry)
      closeHistoryMenu()
      setHistoryTab('internal')
    } catch {
      // Ignore import errors and leave the menu open.
    } finally {
      setImportingSessionId(null)
    }
  }

  const handleColumnResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const section = event.currentTarget.closest('.workspace-column') as HTMLElement | null
    if (!section) {
      return
    }

    const columnElements = Array.from(section.parentElement?.children ?? []).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('workspace-column'),
    )
    const dividerIndex = columnElements.indexOf(section)

    if (dividerIndex < 0 || dividerIndex >= columnElements.length - 1) {
      return
    }

    const startWidths = columnElements.map((element) =>
      Math.max(minColumnWidth, Math.round(element.getBoundingClientRect().width)),
    )
    const resizeTargets = columnElements.map((element, index) => ({
      element,
      columnId: element.dataset.columnId ?? (index === dividerIndex ? column.id : ''),
    }))

    if (resizeTargets.some((target) => target.columnId.length === 0)) {
      return
    }

    const startX = event.clientX
    let nextWidths = resizeTargets.map((target, index) => ({
      columnId: target.columnId,
      width: startWidths[index] ?? minColumnWidth,
    }))

    isColumnResizingRef.current = true
    document.body.classList.add('is-col-resizing')

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const resizedWidths = resizeColumnGroups(startWidths, dividerIndex, moveEvent.clientX - startX)
      nextWidths = resizeTargets.map((target, index) => ({
        columnId: target.columnId,
        width: resizedWidths[index] ?? startWidths[index] ?? minColumnWidth,
      }))

      nextWidths.forEach((target, index) => {
        const element = resizeTargets[index]?.element
        if (!element) {
          return
        }

        element.style.flexBasis = `${target.width}px`
        element.style.flexGrow = `${target.width}`
        element.style.flexShrink = '1'
      })
    }

    const handleStop = () => {
      isColumnResizingRef.current = false
      document.body.classList.remove('is-col-resizing')
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleStop)
      window.removeEventListener('pointercancel', handleStop)
      window.removeEventListener('blur', handleStop)
      onResizeColumn(nextWidths)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleStop)
    window.addEventListener('pointercancel', handleStop)
    window.addEventListener('blur', handleStop)
  }

  const workspaceLabel =
    column.workspacePath.split(/[/\\]/).filter(Boolean).at(-1) ?? text.clickToSetPath

  return (
    <section
      data-column-id={column.id}
      className={`workspace-column${columnDropHint ? ` drop-${columnDropHint}` : ''}${columnDragging ? ' is-dragging' : ''}`}
      style={typeof column.width === 'number' ? getFixedColumnFlexStyle(column.width) : undefined}
      onDragOver={handleColumnDragOver}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return
        }
        setColumnDropHint(null)
      }}
      onDrop={handleColumnDrop}
    >
      <header className="column-header">
        <div className="column-title-row">
          <div
            className="column-headline"
            draggable={!editingPath}
            onDragStart={handleColumnDragStart}
            onDragEnd={() => {
              setColumnDragging(false)
              clearDragPayload()
              setColumnDropHint(null)
            }}
          >
            {editingPath ? (
              <div className="workspace-path-stack" onBlur={handlePathEditorBlur}>
                <div className="workspace-path-row">
                  <input
                    ref={pathInputRef}
                    className="control workspace-path-input"
                    placeholder={text.pathPlaceholder}
                    value={pathValue}
                    onChange={(event) => {
                      setPathPickerNotice(null)
                      setPathValue(event.target.value)
                      onChangeColumn({ workspacePath: event.target.value })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        commitPath()
                      }
                      if (event.key === 'Escape') {
                        setEditingPath(false)
                        setRecentMenuView(false)
                        setPathValue(column.workspacePath)
                      }
                    }}
                    onClick={(event) => event.stopPropagation()}
                  />
                  <IconButton label={text.selectFolder} onClick={handleFolderClick}>
                    <FolderIcon />
                  </IconButton>
                </div>
                {pathPickerNotice ? (
                  <p
                    className={`workspace-path-note is-${pathPickerNotice.tone}`}
                    role={pathPickerNotice.tone === 'error' ? 'alert' : 'status'}
                  >
                    {pathPickerNotice.message}
                  </p>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                className="column-title-btn"
                draggable={false}
                onClick={startEditing}
                title={column.workspacePath || text.clickToSetPath}
              >
                {workspaceLabel}
              </button>
            )}
          </div>

          <div className="column-actions" data-column-header-control="true">
            <div className="column-actions-main">
              <IconButton
                label={text.sessionHistory}
                className="column-secondary-action"
                draggable={false}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  setEditingPath(false)
                  setRecentMenuView(false)
                  setHistoryMenuOpen((current) => {
                    if (current) {
                      setHistorySearch('')
                      return false
                    }

                    setHistoryTab('internal')
                    setHistorySearch('')
                    return true
                  })
                }}
              >
                <HistoryIcon />
              </IconButton>
            </div>
            <IconButton
              label={text.deleteColumn}
              className="column-close-button column-secondary-action"
              onClick={onRemoveColumn}
            >
              <CloseIcon />
            </IconButton>
          </div>
        </div>

        {recentMenuView && (
          <div className="recent-workspaces-menu" ref={recentMenuRef}>
            {recentMenuView === 'list' ? (
              <>
                <div className="recent-workspaces-header">{text.recentWorkspaces}</div>
                {recentWorkspaces.length === 0 ? (
                  <div className="recent-workspace-empty">{text.noRecentWorkspaces}</div>
                ) : (
                  recentWorkspaces.map((workspace) => {
                    const label = workspace.path.split(/[/\\]/).filter(Boolean).at(-1) ?? workspace.path
                    return (
                      <button
                        key={workspace.path}
                        type="button"
                        className="recent-workspace-item"
                        title={workspace.path}
                        onClick={() => {
                          setPathValue(workspace.path)
                          onChangeColumn({ workspacePath: workspace.path })
                          onRecordRecentWorkspace(workspace.path)
                          setEditingPath(false)
                          setRecentMenuView(false)
                        }}
                      >
                        <span className="recent-workspace-label">{label}</span>
                        <span className="recent-workspace-path">{workspace.path}</span>
                      </button>
                    )
                  })
                )}
                {recentWorkspaces.length > 0 ? (
                  <button
                    type="button"
                    className="recent-workspace-action"
                    onClick={() => {
                      setRecentMenuView('clear')
                      setClearSelection(new Set())
                    }}
                  >
                    {text.clearRecent}
                  </button>
                ) : null}
                <button type="button" className="recent-workspace-action" onClick={openSessionHistory}>
                  {text.sessionHistory}
                </button>
              </>
            ) : (
              <>
                <div className="recent-workspaces-header">
                  <button
                    type="button"
                    className="recent-workspaces-back"
                    onClick={() => setRecentMenuView('list')}
                  >
                    {text.back}
                  </button>
                  <span>{text.clearRecent}</span>
                </div>
                {recentWorkspaces.map((workspace) => {
                  const label = workspace.path.split(/[/\\]/).filter(Boolean).at(-1) ?? workspace.path
                  const checked = clearSelection.has(workspace.path)
                  return (
                    <label key={workspace.path} className="recent-clear-item" title={workspace.path}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setClearSelection((current) => {
                            const next = new Set(current)
                            if (next.has(workspace.path)) {
                              next.delete(workspace.path)
                            } else {
                              next.add(workspace.path)
                            }
                            return next
                          })
                        }}
                      />
                      <span>{label}</span>
                    </label>
                  )
                })}
                <div className="recent-clear-actions">
                  <button
                    type="button"
                    disabled={clearSelection.size === 0}
                    onClick={() => {
                      onRemoveRecentWorkspaces(Array.from(clearSelection))
                      setClearSelection(new Set())
                      setRecentMenuView('list')
                    }}
                  >
                    {text.removeSelected}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {historyMenuOpen && (
          <div className="session-history-menu" ref={historyMenuRef}>
            <div className="session-history-tabs">
              <button
                type="button"
                className={`session-history-tab${historyTab === 'internal' ? ' is-active' : ''}`}
                onClick={() => setHistoryTab('internal')}
              >
                {text.sessionHistory}
              </button>
              <button
                type="button"
                className={`session-history-tab${historyTab === 'external' ? ' is-active' : ''}`}
                onClick={() => setHistoryTab('external')}
              >
                {text.externalHistory}
              </button>
            </div>
            <div className="session-history-search-row">
              <input
                type="search"
                className="control session-history-search"
                placeholder={text.searchSessionHistoryPlaceholder}
                aria-label={text.searchSessionHistory}
                value={historySearch}
                autoFocus
                onChange={(event) => setHistorySearch(event.target.value)}
              />
            </div>

            {historyTab === 'internal' ? (
              filteredSessionHistory.length === 0 ? (
                <div className="session-history-empty">
                  {hasHistorySearch ? text.noMatchingSessionHistory : text.noSessionHistory}
                </div>
              ) : (
                filteredSessionHistory.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="session-history-item"
                    title={entry.title}
                    onClick={() => {
                      onRestoreSession(entry.id)
                      closeHistoryMenu()
                    }}
                  >
                    <span className="session-history-title">{entry.title}</span>
                    <span className="session-history-meta">
                      {entry.provider === 'claude' ? 'Claude' : 'Codex'}
                      {' · '}
                      {formatLocalizedDateTime(language, entry.archivedAt)}
                      {entry.messages.length > 0 ? ` · ${entry.messages.length} msgs` : ''}
                    </span>
                  </button>
                ))
              )
            ) : externalLoading ? (
              <div className="session-history-empty">{text.loadingExternalHistory}</div>
            ) : filteredExternalSessions.length === 0 ? (
              <div className="session-history-empty">
                {hasHistorySearch ? text.noMatchingExternalHistory : text.noExternalHistory}
              </div>
            ) : (
              filteredExternalSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="session-history-item"
                  title={session.title}
                  disabled={importingSessionId === session.id}
                  onClick={() => void handleImportExternalSession(session)}
                >
                  <span className="session-history-title">{session.title}</span>
                  <span className="session-history-meta">
                    {session.provider === 'claude' ? 'Claude' : 'Codex'}
                    {' · '}
                    {formatLocalizedDateTime(language, session.updatedAt)}
                    {` · ${session.messageCount} msgs`}
                    {importingSessionId === session.id ? ` · ${text.importingSession}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </header>

      <div className="column-body">
        <LayoutRenderer
          column={column}
          node={column.layout}
          providers={providers}
          language={language}
          systemPrompt={systemPrompt}
          modelPromptRules={modelPromptRules}
          crossProviderSkillReuseEnabled={crossProviderSkillReuseEnabled}
          musicAlbumCoverEnabled={musicAlbumCoverEnabled}
          weatherCity={weatherCity}
          gitAgentModel={gitAgentModel}
          brainstormRequestModel={brainstormRequestModel}
          availableQuickToolModels={availableQuickToolModels}
          autoUrgeEnabled={autoUrgeEnabled}
          autoUrgeProfiles={autoUrgeProfiles}
          autoUrgeMessage={autoUrgeMessage}
          autoUrgeSuccessKeyword={autoUrgeSuccessKeyword}
          onSetAutoUrgeEnabled={onSetAutoUrgeEnabled}
          flashCardIds={flashCardIds}
          onRestoredAnimationEnd={(cardId) =>
            setFlashCardIds((current) => {
              const next = new Set(current)
              next.delete(cardId)
              return next
            })
          }
          onAddTab={onAddTab}
          onSplitPane={onSplitPane}
          onSplitMoveTab={onSplitMoveTab}
          onCloseTab={onCloseTab}
          onMoveTab={onMoveTab}
          onReorderTab={onReorderTab}
          onSetActiveTab={onSetActiveTab}
          onResizePane={onResizePane}
          onActivatePane={onActivatePane}
          onChangeCardModel={onChangeCardModel}
          onChangeCardReasoningEffort={onChangeCardReasoningEffort}
          onToggleCardPlanMode={onToggleCardPlanMode}
          onToggleCardThinking={onToggleCardThinking}
          onToggleCardCollapsed={onToggleCardCollapsed}
          onMarkCardRead={onMarkCardRead}
          onChangeCardDraft={onChangeCardDraft}
          onChangeCardStickyNote={onChangeCardStickyNote}
          onPatchCard={onPatchCard}
          onChangeCardTitle={onChangeCardTitle}
          onSendMessage={onSendMessage}
          onStopMessage={onStopMessage}
          onCancelQueuedSends={onCancelQueuedSends}
          onSendNextQueuedNow={onSendNextQueuedNow}
          onManualRecoverStream={onManualRecoverStream}
          onForkConversation={onForkConversation}
        onOpenFile={onOpenFile}
        cardRecoveryStatuses={cardRecoveryStatuses}
        queuedSendSummaries={queuedSendSummaries}
      />
      </div>

      <div
        className="column-resize-handle"
        onPointerDown={handleColumnResizeStart}
        title={text.resizeColumn}
      />
    </section>
  )
}

export const WorkspaceColumn = memo(WorkspaceColumnView, areWorkspaceColumnPropsEqual)
WorkspaceColumn.displayName = 'WorkspaceColumn'
