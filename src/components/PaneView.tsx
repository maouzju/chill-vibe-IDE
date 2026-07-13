import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { CodexChatSettings } from '../../shared/codex-chat-settings'
import {
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
} from '../../shared/models'
import type {
  AppLanguage,
  AutoUrgeProfile,
  BoardColumn,
  ChatCard as ChatCardState,
  ImageAttachment,
  ModelPromptRule,
  PaneNode,
  Provider,
  ProviderStatus,
} from '../../shared/schema'
import { clearDragPayload, readDragPayload, releaseDragPayloadIfStale, writeDragPayload } from '../dnd'
import type { CardRecoveryStatus } from '../stream-recovery-feedback'
import {
  composerFocusRequestEventName,
  decideComposerFocusRequest,
  type ComposerFocusRequestDetail,
} from './composer-focus'
import { decideMisroutedTabPointerRescue, isPointerWithinRect } from './pane-tab-rescue'
import { decideTabStripWheelScroll } from './pane-tab-wheel'
import {
  notifyForensicsRescueEvent,
  recordPanelUnmountForForensics,
} from '../diagnostics/stuck-pane-forensics'
import type { QueuedSendSummary, SendMessageOptions } from './deferred-send-queue'
import { arePaneViewPropsEqual } from './layout-memoization'
import { getAutoReadCardId } from './pane-read-state'
import { syncMessageListElementToBottom } from './pane-scroll'
import { ChatCard } from './ChatCard'
import {
  ClaudeIcon,
  CloudIcon,
  CloseIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GptIcon,
  HeadphonesIcon,
  ImageIcon,
  NeteaseCloudMusicIcon,
  PlusIcon,
  SparklesIcon,
  StickyNoteIcon,
} from './Icons'

type DropEdge = 'left' | 'right' | 'top' | 'bottom'
type DropPlacement = 'before' | 'after'
const tabPointerDownFallbackDelayMs = 80

type PaneViewProps = {
  column: BoardColumn
  pane: PaneNode
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  codexChatSettings?: CodexChatSettings
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
  globalUrgeActive: boolean
  globalUrgeProfileId: string
  onSetAutoUrgeEnabled: (enabled: boolean) => void
  onAddTab: (paneId: string) => void
  onSplitPane: (
    paneId: string,
    direction: 'horizontal' | 'vertical',
    placement?: DropPlacement,
    tabId?: string,
    newPaneId?: string,
  ) => void
  onSplitMoveTab: (
    sourcePaneId: string,
    targetPaneId: string,
    tabId: string,
    direction: 'horizontal' | 'vertical',
    placement: DropPlacement,
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
  onActivatePane: (paneId: string) => void
  onChangeCardModel: (cardId: string, provider: Provider, model: string) => void
  onChangeCardReasoningEffort: (cardId: string, reasoningEffort: string) => void
  onToggleCardPlanMode: (cardId: string) => void
  onToggleCardThinking: (cardId: string) => void
  onToggleCardCollapsed: (cardId: string) => void
  onMarkCardRead: (cardId: string) => void
  onChangeCardDraft: (cardId: string, draft: string) => void
  onChangeCardStickyNote: (cardId: string, content: string) => void
  stickyNoteArchivedContent?: string
  onDiscardStickyNoteArchive?: () => void
  onPatchCard: (
    cardId: string,
    patch: Partial<
      Pick<
        ChatCardState,
        | 'status'
        | 'sessionId'
        | 'brainstorm'
        | 'autoUrgeActive'
        | 'autoUrgeProfileId'
      >
    >,
  ) => void
  onChangeCardTitle: (cardId: string, title: string) => void
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
  cardRecoveryStatuses?: ReadonlyMap<string, CardRecoveryStatus>
  queuedSendSummaries?: ReadonlyMap<string, QueuedSendSummary>
}

const getHorizontalPlacement = (event: DragEvent<HTMLElement>): DropPlacement => {
  const bounds = event.currentTarget.getBoundingClientRect()
  return event.clientX <= bounds.left + bounds.width / 2 ? 'before' : 'after'
}

const getPaneEdge = (event: DragEvent<HTMLElement>): DropEdge | null => {
  const bounds = event.currentTarget.getBoundingClientRect()
  const relX = event.clientX - bounds.left
  const relY = event.clientY - bounds.top
  const xRatio = bounds.width > 0 ? relX / bounds.width : 0.5
  const yRatio = bounds.height > 0 ? relY / bounds.height : 0.5

  const centerBand = {
    left: 0.3,
    right: 0.7,
    top: 0.3,
    bottom: 0.7,
  }

  const inCenterX = xRatio > centerBand.left && xRatio < centerBand.right
  const inCenterY = yRatio > centerBand.top && yRatio < centerBand.bottom

  // If cursor is in the center zone, treat as merge (no edge)
  if (inCenterX && inCenterY) return null

  if (inCenterX) {
    return yRatio < 0.5 ? 'top' : 'bottom'
  }

  if (inCenterY) {
    return xRatio < 0.5 ? 'left' : 'right'
  }

  const xOutsideCenter =
    xRatio < centerBand.left ? centerBand.left - xRatio : xRatio > centerBand.right ? xRatio - centerBand.right : 0
  const yOutsideCenter =
    yRatio < centerBand.top ? centerBand.top - yRatio : yRatio > centerBand.bottom ? yRatio - centerBand.bottom : 0

  if (yOutsideCenter > xOutsideCenter + Number.EPSILON) {
    return yRatio < 0.5 ? 'top' : 'bottom'
  }

  if (xOutsideCenter > yOutsideCenter + Number.EPSILON) {
    return xRatio < 0.5 ? 'left' : 'right'
  }

  const distances = [
    { edge: 'left' as const, distance: relX },
    { edge: 'right' as const, distance: bounds.width - relX },
    { edge: 'top' as const, distance: relY },
    { edge: 'bottom' as const, distance: bounds.height - relY },
  ]
  return distances.reduce((best, current) => (current.distance < best.distance ? current : best)).edge
}

const edgeToSplit = (edge: DropEdge): { direction: 'horizontal' | 'vertical'; placement: DropPlacement } =>
  edge === 'left'
    ? { direction: 'horizontal', placement: 'before' }
    : edge === 'right'
      ? { direction: 'horizontal', placement: 'after' }
      : edge === 'top'
        ? { direction: 'vertical', placement: 'before' }
        : { direction: 'vertical', placement: 'after' }

const getPaneTabIcon = (card: ChatCardState) => {
  if (card.model === GIT_TOOL_MODEL) {
    return <GitBranchIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === MUSIC_TOOL_MODEL) {
    return <NeteaseCloudMusicIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === WHITENOISE_TOOL_MODEL) {
    return <HeadphonesIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === WEATHER_TOOL_MODEL) {
    return <CloudIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === STICKYNOTE_TOOL_MODEL) {
    return <StickyNoteIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === FILETREE_TOOL_MODEL) {
    return <FolderIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === BRAINSTORM_TOOL_MODEL) {
    return <SparklesIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === TEXTEDITOR_TOOL_MODEL) {
    return <FileTextIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === IMAGEEDITOR_TOOL_MODEL) {
    return <ImageIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.provider === 'claude') {
    return <ClaudeIcon className="pane-tab-icon" aria-hidden="true" />
  }

  return <GptIcon className="pane-tab-icon" aria-hidden="true" />
}

const getPaneTabTitle = (card: ChatCardState, fallbackTitle: string) => {
  if (card.model === GIT_TOOL_MODEL) {
    return 'Git'
  }

  if (card.model === BRAINSTORM_TOOL_MODEL) {
    return card.title || 'Brainstorm'
  }

  return card.title || fallbackTitle
}

const isTabCloseTarget = (target: EventTarget | null) =>
  target instanceof Element && target.closest('.pane-tab-close') !== null

const isTabChromeActionTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  (target.closest('.pane-tab') !== null || target.closest('.pane-add-tab') !== null)

const cardUsesComposer = (card: ChatCardState) =>
  ![
    FILETREE_TOOL_MODEL,
    BRAINSTORM_TOOL_MODEL,
    GIT_TOOL_MODEL,
    MUSIC_TOOL_MODEL,
    STICKYNOTE_TOOL_MODEL,
    TEXTEDITOR_TOOL_MODEL,
    IMAGEEDITOR_TOOL_MODEL,
    WEATHER_TOOL_MODEL,
    WHITENOISE_TOOL_MODEL,
  ].includes(card.model)

const cardKeepsPaneRuntimeWhenInactive = (card: ChatCardState) =>
  card.model === GIT_TOOL_MODEL

const dragHintExpiryMs = 1200

// Forensics probe (dump 2026-07-11T07-19): React commitDeletion removed the
// focused `pane-tab-panel.is-active` and remounted the same tabId moments
// later, while the reducer has no tab-removal path in a streaming window. The
// cleanup fires at the exact unmount commit and records whether the DATA
// layer still holds the tab — divergence is the React-lane smoking gun.
// Dependencies stay [tabId, paneId] only, so prop churn never fakes an
// unmount; isActive rides a ref for the same reason.
const PaneTabPanelUnmountProbe = ({
  tabId,
  paneId,
  isActive,
}: {
  tabId: string
  paneId: string
  isActive: boolean
}) => {
  const activeRef = useRef(isActive)
  useEffect(() => {
    activeRef.current = isActive
  })
  useEffect(
    () => () =>
      recordPanelUnmountForForensics({ tabId, paneId, activeAtUnmount: activeRef.current }),
    [tabId, paneId],
  )
  return null
}

const PaneViewView = ({
  column,
  pane,
  providers,
  language,
  systemPrompt,
  modelPromptRules = [],
  codexChatSettings,
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
  globalUrgeActive,
  globalUrgeProfileId,
  onSetAutoUrgeEnabled,
  onAddTab,
  onSplitPane,
  onSplitMoveTab,
  onCloseTab,
  onMoveTab,
  onReorderTab,
  onSetActiveTab,
  onActivatePane,
  onChangeCardModel,
  onChangeCardReasoningEffort,
  onToggleCardPlanMode,
  onToggleCardThinking,
  onToggleCardCollapsed,
  onMarkCardRead,
  onChangeCardDraft,
  onChangeCardStickyNote,
  stickyNoteArchivedContent,
  onDiscardStickyNoteArchive,
  onPatchCard,
  onChangeCardTitle,
  onSendMessage,
  onStopMessage,
  onCancelQueuedSends,
  onSendNextQueuedNow,
  onManualRecoverStream,
  onForkConversation,
  onOpenFile,
  cardRecoveryStatuses,
  queuedSendSummaries,
}: PaneViewProps) => {
  const text = getLocaleText(language)
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const paneContentRef = useRef<HTMLDivElement | null>(null)
  const [tabDropHint, setTabDropHint] = useState<{ tabId: string; placement: DropPlacement } | null>(null)
  const [contentDropEdge, setContentDropEdge] = useState<DropEdge | null>(null)
  const tabSizingRef = useRef<'fit' | 'shrink'>('fit')
  const dragHintExpiryRef = useRef<number | null>(null)
  const tabStripRefCallback = useCallback((el: HTMLDivElement | null) => {
    tabStripRef.current = el
    if (el) el.dataset.sizing = tabSizingRef.current
  }, [])
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)

  // Keyboard tab shortcuts (Ctrl+T / Ctrl+Tab) live in App and cannot reach
  // this pane-local counter directly; they dispatch an app-wide focus request
  // event instead (investigation §4.3).
  useEffect(() => {
    const handleComposerFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<ComposerFocusRequestDetail>).detail
      if (detail?.paneId !== pane.id) {
        return
      }
      setComposerFocusRequest((current) => current + 1)
    }

    window.addEventListener(composerFocusRequestEventName, handleComposerFocusRequest)
    return () => {
      window.removeEventListener(composerFocusRequestEventName, handleComposerFocusRequest)
    }
  }, [pane.id])

  // A stale compositor hit-test surface can misroute tab-strip pointerdowns to
  // unrelated subtrees, leaving tabs impossible to activate or close from the
  // user's side (investigation §3.6/F8). Watch at document capture — misrouted
  // events never bubble through this pane — and route manually only when the
  // pure decision core confirms coordinates + layout truth against the target.
  const tabRescueActionsRef = useRef<{
    activate: (tabId: string) => void
    close: (tabId: string) => void
  }>({ activate: () => {}, close: () => {} })

  useEffect(() => {
    const handleMisroutedTabPointerDown = (event: globalThis.PointerEvent) => {
      if (event.button !== 0) {
        return
      }

      const strip = tabStripRef.current
      if (!strip) {
        return
      }

      const point = { x: event.clientX, y: event.clientY }
      if (!isPointerWithinRect(point, strip.getBoundingClientRect())) {
        return
      }

      const target = event.target
      const tabs = [...strip.querySelectorAll<HTMLButtonElement>('button[data-pane-tab-id]')].map(
        (button) => ({
          tabId: button.dataset.paneTabId ?? '',
          rect: button.getBoundingClientRect(),
          ownsEventTarget: target instanceof Node && button.contains(target),
          ownsElement: (element: Element) => button.contains(element),
          ownsCloseElement: (element: Element) =>
            button.querySelector('.pane-tab-close')?.contains(element) ?? false,
        }),
      )

      const decision = decideMisroutedTabPointerRescue(point, tabs, () =>
        document.elementFromPoint(point.x, point.y),
      )
      if (decision.kind === 'activate') {
        notifyForensicsRescueEvent('tab-rescue')
        tabRescueActionsRef.current.activate(decision.tabId)
      } else if (decision.kind === 'close') {
        notifyForensicsRescueEvent('tab-rescue')
        tabRescueActionsRef.current.close(decision.tabId)
      }
    }

    document.addEventListener('pointerdown', handleMisroutedTabPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handleMisroutedTabPointerDown, true)
    }
  }, [])

  // Tab strip wheel scrolling lives on the same misroute-proof footing as the
  // pointerdown rescue above: a React onWheel handler needs the event target
  // to bubble through this pane, so a stale compositor hit-test surface that
  // routes the wheel elsewhere makes an overflowing tab bar impossible to
  // scroll. Watch at document capture with a non-passive listener (React
  // registers root wheel listeners passive, so its preventDefault never
  // worked) and decide purely from pointer geometry + layout truth.
  useEffect(() => {
    const handleTabStripWheel = (event: globalThis.WheelEvent) => {
      const strip = tabStripRef.current
      const bar = strip?.parentElement
      if (!strip || !bar) {
        return
      }

      const point = { x: event.clientX, y: event.clientY }
      const decision = decideTabStripWheelScroll(
        point,
        { deltaX: event.deltaX, deltaY: event.deltaY },
        {
          rect: bar.getBoundingClientRect(),
          scrollLeft: strip.scrollLeft,
          scrollWidth: strip.scrollWidth,
          clientWidth: strip.clientWidth,
        },
        () => {
          const hit = document.elementFromPoint(point.x, point.y)
          return hit !== null && bar.contains(hit)
        },
      )

      if (decision.kind !== 'scroll') {
        return
      }

      strip.scrollLeft = decision.nextScrollLeft
      event.preventDefault()
      event.stopPropagation()
    }

    document.addEventListener('wheel', handleTabStripWheel, { capture: true, passive: false })
    return () => {
      document.removeEventListener('wheel', handleTabStripWheel, { capture: true })
    }
  }, [])

  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const activeCard = pane.activeTabId ? column.cards[pane.activeTabId] : undefined
  const activeTabMounted = pane.activeTabId ? pane.tabs.includes(pane.activeTabId) : false

  // Stable key that only changes when tab titles change, not on every card mutation.
  // Prevents tabSizing from flickering during streaming.
  const tabTitleKey = useMemo(
    () => pane.tabs.map((id) => column.cards[id]?.title ?? '').join('\0'),
    [pane.tabs, column.cards],
  )

  useEffect(() => {
    const strip = tabStripRef.current
    if (!strip) {
      return
    }

    const activeTab = strip.querySelector<HTMLElement>('.pane-tab.is-active')
    if (!activeTab) {
      return
    }

    const nextScrollLeft = (() => {
      const visibleLeft = strip.scrollLeft
      const visibleRight = visibleLeft + strip.clientWidth
      const tabLeft = activeTab.offsetLeft
      const tabRight = tabLeft + activeTab.offsetWidth

      if (tabLeft < visibleLeft) {
        return tabLeft
      }

      if (tabRight > visibleRight) {
        return tabRight - strip.clientWidth
      }

      return null
    })()

    if (nextScrollLeft !== null) {
      strip.scrollTo({ left: nextScrollLeft, behavior: 'auto' })
    }
  }, [pane.activeTabId, pane.tabs])

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip) {
      return
    }

    const updateSizing = () => {
      const tabCount = strip.querySelectorAll('.pane-tab').length
      if (tabCount === 0) {
        if (tabSizingRef.current !== 'fit') {
          tabSizingRef.current = 'fit'
          strip.dataset.sizing = 'fit'
        }
        return
      }

      // Use a fixed per-tab width estimate (min-width in fit mode) to avoid
      // oscillation: reading scrollWidth while in 'shrink' mode yields smaller
      // values, which would flip back to 'fit', triggering an infinite loop.
      const fitWidth = tabCount * 120
      const next = fitWidth <= strip.clientWidth ? 'fit' : 'shrink'
      if (tabSizingRef.current !== next) {
        tabSizingRef.current = next
        strip.dataset.sizing = next
      }
    }

    updateSizing()

    const resizeObserver = new ResizeObserver(() => updateSizing())
    resizeObserver.observe(strip)

    return () => resizeObserver.disconnect()
  }, [pane.tabs, pane.activeTabId, tabTitleKey])

  useLayoutEffect(() => {
    if (!pane.activeTabId || !activeTabMounted) {
      return
    }

    const frameHandles: number[] = []
    const timeoutHandles: number[] = []
    let shouldKeepSyncing = true
    let lastAppliedScrollTop: number | null = null

    const syncActiveMessageListToBottom = () => {
      if (!shouldKeepSyncing) {
        return false
      }

      const activeMessageList = paneContentRef.current?.querySelector<HTMLElement>('.pane-tab-panel.is-active .message-list')
      if (!activeMessageList) {
        return false
      }

      if (
        lastAppliedScrollTop !== null &&
        Math.abs(activeMessageList.scrollTop - lastAppliedScrollTop) > 1
      ) {
        shouldKeepSyncing = false
        return false
      }

      const nextScrollTop = syncMessageListElementToBottom(activeMessageList)
      lastAppliedScrollTop = nextScrollTop
      return true
    }

    const scheduleFrame = () => {
      frameHandles.push(window.requestAnimationFrame(() => {
        syncActiveMessageListToBottom()
      }))
    }

    syncActiveMessageListToBottom()
    scheduleFrame()

    for (const delayMs of [60, 180, 360, 720]) {
      timeoutHandles.push(
        window.setTimeout(() => {
          if (syncActiveMessageListToBottom()) {
            scheduleFrame()
          }
        }, delayMs),
      )
    }

    return () => {
      for (const frameHandle of frameHandles) {
        window.cancelAnimationFrame(frameHandle)
      }
      for (const timeoutHandle of timeoutHandles) {
        window.clearTimeout(timeoutHandle)
      }
    }
  }, [activeTabMounted, pane.activeTabId])

  const clearDragHintExpiry = useCallback(() => {
    if (dragHintExpiryRef.current === null) {
      return
    }

    window.clearTimeout(dragHintExpiryRef.current)
    dragHintExpiryRef.current = null
  }, [])

  const clearHints = useCallback(() => {
    clearDragHintExpiry()
    setTabDropHint(null)
    setContentDropEdge(null)
  }, [clearDragHintExpiry, setContentDropEdge, setTabDropHint])

  const scheduleDragHintExpiry = useCallback(() => {
    clearDragHintExpiry()
    const arm = () => {
      dragHintExpiryRef.current = window.setTimeout(() => {
        dragHintExpiryRef.current = null
        setTabDropHint(null)
        setContentDropEdge(null)
        // Stale hints may be cleared, but the shared drag payload must
        // survive a drag that is still in flight — dragover handlers cannot
        // read dataTransfer mid-drag, so releasing it would silently kill
        // every remaining drop target. Re-arm so a drag that later dies
        // without dragend/drop (pitfall 132) still gets cleaned up.
        if (!releaseDragPayloadIfStale(Date.now())) {
          arm()
        }
      }, dragHintExpiryMs)
    }
    arm()
  }, [clearDragHintExpiry, setContentDropEdge, setTabDropHint])

  useEffect(() => () => clearDragHintExpiry(), [clearDragHintExpiry])

  useEffect(() => {
    if (!tabDropHint && !contentDropEdge) {
      return
    }

    const clearActiveDragState = () => {
      clearDragPayload()
      clearHints()
    }

    window.addEventListener('dragend', clearActiveDragState)
    window.addEventListener('drop', clearActiveDragState)
    window.addEventListener('blur', clearActiveDragState)

    return () => {
      window.removeEventListener('dragend', clearActiveDragState)
      window.removeEventListener('drop', clearActiveDragState)
      window.removeEventListener('blur', clearActiveDragState)
    }
  }, [clearHints, contentDropEdge, tabDropHint])

  const moveIntoPane = (
    sourceColumnId: string,
    sourcePaneId: string,
    tabId: string,
    index?: number,
  ) => {
    if (sourceColumnId === column.id && sourcePaneId === pane.id) {
      onReorderTab(pane.id, tabId, index ?? pane.tabs.length)
      return
    }

    onMoveTab(sourceColumnId, sourcePaneId, tabId, column.id, pane.id, index)
  }

  const cancelPendingTabSwitch = () => {
    if (pendingTabSwitchRef.current === null) {
      return
    }

    window.clearTimeout(pendingTabSwitchRef.current)
    pendingTabSwitchRef.current = null
  }

  const handleTabDragStart = (tabId: string) => (event: DragEvent<HTMLButtonElement>) => {
    const card = column.cards[tabId]
    if (!card) {
      event.preventDefault()
      return
    }

    cancelPendingTabSwitch()
    writeDragPayload(event, { type: 'tab', columnId: column.id, paneId: pane.id, tabId })
  }

  const handleTabDrop = (targetTabId: string) => (event: DragEvent<HTMLElement>) => {
    const payload = readDragPayload(event)
    if (payload?.type !== 'tab') {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const targetIndex = pane.tabs.findIndex((tabId) => tabId === targetTabId)
    const placement = getHorizontalPlacement(event)
    const index = placement === 'before' ? targetIndex : targetIndex + 1
    moveIntoPane(payload.columnId, payload.paneId, payload.tabId, index)
    clearDragPayload()
    clearHints()
  }

  const pendingTabSwitchRef = useRef<number | null>(null)
  const tabPointerDownRef = useRef<{
    tabId: string
    pointerId: number
    x: number
    y: number
    dragging: boolean
  } | null>(null)
  const suppressNextTabClickRef = useRef<string | null>(null)

  const activateTab = (tabId: string) => {
    if (pane.activeTabId === tabId) {
      // Re-clicking the already-active tab is the user's natural recovery
      // gesture when the composer looks dead (stale hit-test surfaces);
      // re-request composer focus instead of silently doing nothing.
      requestComposerFocus(tabId)
      return
    }

    cancelPendingTabSwitch()

    const autoReadCardId = getAutoReadCardId(column.cards[tabId], true)
    onSetActiveTab(pane.id, tabId)
    if (autoReadCardId) {
      onMarkCardRead(autoReadCardId)
    }
    requestComposerFocus(tabId)
  }

  const schedulePointerDownTabActivation = (tabId: string) => {
    cancelPendingTabSwitch()
    pendingTabSwitchRef.current = window.setTimeout(() => {
      pendingTabSwitchRef.current = null
      activateTab(tabId)
    }, tabPointerDownFallbackDelayMs)
  }

  const requestComposerFocus = (tabId: string) => {
    // The rescue reads tab ids from the live DOM but runs the previous
    // render's closure: in the one-frame window after a new tab mounts, its
    // card is not in this cards map yet — never dereference it.
    const card = column.cards[tabId]
    const decision = decideComposerFocusRequest({
      cardPresent: card != null,
      cardUsesComposer: card != null && cardUsesComposer(card),
    })
    if (decision === 'bump') {
      setComposerFocusRequest((current) => current + 1)
    }
  }

  // Keep the document-capture tab rescue pointed at this render's handlers
  // without re-registering the listener on every render. Rescued actions must
  // also activate the pane: the native click would have done it via the
  // section's onMouseDownCapture, but a misrouted event travelled through a
  // different React subtree — without this, global shortcuts (Ctrl+W/T) keep
  // targeting the previously active pane while this pane looks active.
  useEffect(() => {
    tabRescueActionsRef.current = {
      activate: (tabId: string) => {
        onActivatePane(pane.id)
        activateTab(tabId)
      },
      close: (tabId: string) => {
        onActivatePane(pane.id)
        onCloseTab(pane.id, tabId)
      },
    }
  })

  const handleAddTab = () => {
    onAddTab(pane.id)
    setComposerFocusRequest((current) => current + 1)
  }

  const handleTabBarDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isTabChromeActionTarget(event.target)) {
      return
    }

    event.preventDefault()
    onAddTab(pane.id)
    setComposerFocusRequest((current) => current + 1)
  }

  const handleTabPointerDown = (tabId: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || isTabCloseTarget(event.target)) {
      return
    }

    // The stale-suppress reset must precede the coordinate guard: a rejected
    // pointerdown that skipped it would let a stranded suppress (touch-drag
    // cancel paths) eat the next legitimate click.
    suppressNextTabClickRef.current = null

    // A stale-routed pointerdown can name this tab as target while its real
    // coordinates sit on a different surface; scheduling the 80ms fallback
    // from such an event phantom-activates a tab the user never touched
    // (investigation §3.5). Only coordinate-confirmed pointerdowns count.
    if (
      !isPointerWithinRect(
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return
    }
    tabPointerDownRef.current = {
      tabId,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    }
    schedulePointerDownTabActivation(tabId)
  }

  const handleTabPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const pointerDown = tabPointerDownRef.current
    if (!pointerDown || pointerDown.pointerId !== event.pointerId) {
      return
    }

    const deltaX = Math.abs(event.clientX - pointerDown.x)
    const deltaY = Math.abs(event.clientY - pointerDown.y)
    if (deltaX > 12 || deltaY > 12) {
      tabPointerDownRef.current = { ...pointerDown, dragging: true }
      suppressNextTabClickRef.current = pointerDown.tabId
      cancelPendingTabSwitch()
    }
  }

  const handleTabPointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    const pointerDown = tabPointerDownRef.current
    if (pointerDown?.pointerId === event.pointerId) {
      if (pointerDown.dragging) {
        suppressNextTabClickRef.current = pointerDown.tabId
      }
      tabPointerDownRef.current = null
      cancelPendingTabSwitch()
    }
  }

  const handleTabPointerUp = (tabId: string) => (event: PointerEvent<HTMLButtonElement>) => {
    const pointerDown = tabPointerDownRef.current
    if (!pointerDown || pointerDown.pointerId !== event.pointerId) {
      return
    }

    tabPointerDownRef.current = null
    if (pointerDown.tabId === tabId && !pointerDown.dragging) {
      cancelPendingTabSwitch()
      activateTab(tabId)
      suppressNextTabClickRef.current = tabId
    }
  }

  const handleTabClick = (tabId: string) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || isTabCloseTarget(event.target)) {
      return
    }

    // Same phantom guard as pointerdown: a stale surface that misroutes both
    // halves of a click delivers a click whose coordinates sit elsewhere, and
    // acting on it would override the capture rescue's correct routing.
    // Keyboard-synthesized clicks (Enter on the focused tab) carry detail 0
    // and no meaningful coordinates — they always pass.
    if (
      event.detail > 0 &&
      !isPointerWithinRect(
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return
    }

    if (suppressNextTabClickRef.current === tabId) {
      suppressNextTabClickRef.current = null
      return
    }

    activateTab(tabId)
  }

  const handleTabMouseDown = () => (event: MouseEvent<HTMLButtonElement>) => {
    // Never preventDefault a left mousedown here: starting a drag is part of
    // mousedown's default action, so cancelling it kills dragstart on this
    // draggable tab in every browser. The button briefly taking native focus
    // is fine — activateTab always re-requests composer focus and the
    // verify+retry driver moves focus onto the textarea unconditionally.
    if (event.button !== 1) {
      return
    }

    event.preventDefault()
  }

  const handleTabAuxClick = (tabId: string) => (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 1) {
      return
    }

    // Middle-click close is destructive; never act on a phantom-routed event
    // whose coordinates disagree with this button (investigation §3.5).
    if (
      !isPointerWithinRect(
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      )
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    onCloseTab(pane.id, tabId)
  }

  const handleContentDrop = (event: DragEvent<HTMLDivElement>) => {
    const payload = readDragPayload(event)
    if (payload?.type !== 'tab') {
      return
    }

    if (payload.columnId === column.id && payload.paneId === pane.id && pane.tabs.length <= 1) {
      clearDragPayload()
      clearHints()
      return
    }

    event.preventDefault()
    const dropEdge = getPaneEdge(event) ?? contentDropEdge

    if (dropEdge) {
      const newPaneId = crypto.randomUUID()
      const { direction, placement } = edgeToSplit(dropEdge)

      if (payload.columnId === column.id && payload.paneId === pane.id) {
        onSplitPane(pane.id, direction, placement, payload.tabId, newPaneId)
      } else if (payload.columnId === column.id) {
        onSplitMoveTab(payload.paneId, pane.id, payload.tabId, direction, placement, newPaneId)
      } else {
        onSplitPane(pane.id, direction, placement, undefined, newPaneId)
        onMoveTab(payload.columnId, payload.paneId, payload.tabId, column.id, newPaneId)
      }
    } else {
      moveIntoPane(payload.columnId, payload.paneId, payload.tabId)
    }

    clearDragPayload()
    clearHints()
  }

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (event: globalThis.MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null)
      }
    }
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu])

  const handleTabContextMenu = (tabId: string) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ tabId, x: event.clientX, y: event.clientY })
  }

  const contextMenuActions = contextMenu
    ? (() => {
        const tabIndex = pane.tabs.indexOf(contextMenu.tabId)
        const tabsAfter = pane.tabs.slice(tabIndex + 1)
        const otherTabs = pane.tabs.filter((id) => id !== contextMenu.tabId)
        return {
          close: () => {
            onCloseTab(pane.id, contextMenu.tabId)
            setContextMenu(null)
          },
          closeOthers: otherTabs.length > 0
            ? () => {
                for (const id of otherTabs) onCloseTab(pane.id, id)
                setContextMenu(null)
              }
            : null,
          closeRight: tabsAfter.length > 0
            ? () => {
                for (const id of tabsAfter) onCloseTab(pane.id, id)
                setContextMenu(null)
              }
            : null,
          splitRight: () => {
            onSplitPane(pane.id, 'horizontal', 'after', contextMenu.tabId)
            setContextMenu(null)
          },
          splitDown: () => {
            onSplitPane(pane.id, 'vertical', 'after', contextMenu.tabId)
            setContextMenu(null)
          },
        }
      })()
    : null

  return (
    <section
      className="pane-view"
      onMouseDownCapture={() => onActivatePane(pane.id)}
      onFocusCapture={() => onActivatePane(pane.id)}
    >
      <div
        className="pane-tab-bar"
        onDoubleClick={handleTabBarDoubleClick}
        onDragOver={(event) => {
          const payload = readDragPayload(event)
          if (payload?.type !== 'tab') {
            return
          }

          event.preventDefault()
          setContentDropEdge(null)
        }}
        onDrop={(event) => {
          const payload = readDragPayload(event)
          if (payload?.type !== 'tab') {
            return
          }

          event.preventDefault()
          moveIntoPane(payload.columnId, payload.paneId, payload.tabId)
          clearDragPayload()
          clearHints()
        }}
      >
        <div
          ref={tabStripRefCallback}
          className="pane-tab-strip"
          onDragOver={(event) => {
            const payload = readDragPayload(event)
            if (payload?.type !== 'tab') {
              return
            }

            event.preventDefault()
            event.stopPropagation()
            setContentDropEdge(null)
          }}
          onDrop={(event) => {
            const payload = readDragPayload(event)
            if (payload?.type !== 'tab') {
              return
            }

            event.preventDefault()
            event.stopPropagation()
            moveIntoPane(payload.columnId, payload.paneId, payload.tabId)
            clearDragPayload()
            clearHints()
          }}
        >
          {pane.tabs.map((tabId, index) => {
            const card = column.cards[tabId]
            if (!card) {
              return null
            }

            const tabTitle = getPaneTabTitle(card, text.newChat)

            const isActive = tabId === pane.activeTabId
            const isStreaming = card.status === 'streaming'
            const isBeforeActive = pane.tabs[index + 1] === pane.activeTabId
            const tabClassName = [
              'pane-tab',
              isActive ? 'is-active' : '',
              isStreaming ? 'is-streaming' : '',
              isBeforeActive ? 'is-before-active' : '',
              tabDropHint?.tabId === tabId ? `drop-${tabDropHint.placement}` : '',
            ].filter(Boolean).join(' ')

            return (
              <button
                key={tabId}
                type="button"
                className={tabClassName}
                title={tabTitle}
                data-pane-tab-id={tabId}
                draggable
                onClick={handleTabClick(tabId)}
                onPointerDown={handleTabPointerDown(tabId)}
                onPointerMove={handleTabPointerMove}
                onPointerUp={handleTabPointerUp(tabId)}
                onPointerCancel={handleTabPointerCancel}
                onMouseDown={handleTabMouseDown()}
                onAuxClick={handleTabAuxClick(tabId)}
                onContextMenu={handleTabContextMenu(tabId)}
                onDragStart={handleTabDragStart(tabId)}
                onDragEnd={() => {
                  suppressNextTabClickRef.current = null
                  clearDragPayload()
                  clearHints()
                }}
                onDragOver={(event) => {
                  const payload = readDragPayload(event)
                  if (payload?.type !== 'tab') {
                    return
                  }

                  if (payload.columnId === column.id && payload.paneId === pane.id && payload.tabId === tabId) {
                    return
                  }

                  event.preventDefault()
                  event.stopPropagation()
                  setContentDropEdge(null)
                  setTabDropHint({ tabId, placement: getHorizontalPlacement(event) })
                  scheduleDragHintExpiry()
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget
                  if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                    return
                  }
                  setTabDropHint((current) => (current?.tabId === tabId ? null : current))
                }}
                onDrop={handleTabDrop(tabId)}
              >
                {getPaneTabIcon(card)}
                <span className="pane-tab-label">{tabTitle}</span>
                {card.unread && !isActive ? <span className="pane-tab-status is-unread" /> : null}
                <span
                  className="pane-tab-close"
                  role="button"
                  tabIndex={0}
                  onMouseDown={(event) => {
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    // Destructive close must ignore phantom-routed clicks whose
                    // coordinates sit outside this control; keyboard-synthesized
                    // clicks (detail 0) pass — Enter/Space use onKeyDown anyway.
                    if (
                      event.detail > 0 &&
                      !isPointerWithinRect(
                        { x: event.clientX, y: event.clientY },
                        event.currentTarget.getBoundingClientRect(),
                      )
                    ) {
                      return
                    }
                    onCloseTab(pane.id, tabId)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      onCloseTab(pane.id, tabId)
                    }
                  }}
                >
                  <CloseIcon />
                </span>
              </button>
            )
          })}
        </div>

        <div className="pane-tab-actions">
          <button
            type="button"
            className="pane-add-tab"
            aria-label={text.addChat}
            title={text.addChat}
            onClick={handleAddTab}
          >
            <PlusIcon />
          </button>
        </div>
        </div>

        <div
          ref={paneContentRef}
          className={`pane-content${contentDropEdge ? ` is-drop-${contentDropEdge}` : ''}`}
          onDragOver={(event) => {
            const payload = readDragPayload(event)
          if (payload?.type !== 'tab') {
            return
          }

          if (payload.columnId === column.id && payload.paneId === pane.id && pane.tabs.length <= 1) {
            return
          }

          event.preventDefault()
          setTabDropHint(null)
          setContentDropEdge(getPaneEdge(event))
          scheduleDragHintExpiry()
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return
          }
          setContentDropEdge(null)
        }}
        onDrop={handleContentDrop}
      >
        {pane.tabs.map((tabId) => {
          const card = column.cards[tabId]
          if (!card) return null
          const isActive = tabId === pane.activeTabId
          const keepInactiveRuntime = !isActive && cardKeepsPaneRuntimeWhenInactive(card)
          return (
            <div
              key={tabId}
              className={`pane-tab-panel${isActive ? ' is-active' : ''}`}
              hidden={!isActive}
            >
              <PaneTabPanelUnmountProbe tabId={tabId} paneId={pane.id} isActive={isActive} />
              {isActive || keepInactiveRuntime ? (
                <ChatCard
                  card={card}
                  providerReady={providers[card.provider]?.available ?? false}
                  workspacePath={column.workspacePath}
                  language={language}
                  systemPrompt={systemPrompt}
                  modelPromptRules={modelPromptRules}
                  codexChatSettings={codexChatSettings}
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
                  globalUrgeActive={globalUrgeActive}
                  globalUrgeProfileId={globalUrgeProfileId}
                  onSetAutoUrgeEnabled={onSetAutoUrgeEnabled}
                  onRemove={() => onCloseTab(pane.id, card.id)}
                  queuedSendSummary={queuedSendSummaries?.get(card.id)}
                  onSend={(prompt, attachments, options) => onSendMessage(card.id, prompt, attachments, options)}
                  onStop={() => onStopMessage(card.id)}
                  onCancelQueuedSends={
                    onCancelQueuedSends
                      ? () => onCancelQueuedSends(card.id)
                      : undefined
                  }
                  onSendNextQueuedNow={
                    onSendNextQueuedNow
                      ? () => onSendNextQueuedNow(card.id)
                      : undefined
                  }
                  onManualRecoverStream={
                    onManualRecoverStream
                      ? () => onManualRecoverStream(card.id)
                      : undefined
                  }
                  onForkConversation={
                    onForkConversation
                      ? (messageId) => onForkConversation(card.id, messageId)
                      : undefined
                  }
                  onDraftChange={(draft) => onChangeCardDraft(card.id, draft)}
                  onStickyNoteChange={(content) => onChangeCardStickyNote(card.id, content)}
                  stickyNoteArchivedContent={stickyNoteArchivedContent}
                  onDiscardStickyNoteArchive={onDiscardStickyNoteArchive}
                  onPatchCard={(patch) => onPatchCard(card.id, patch)}
                  onChangeTitle={(title) => onChangeCardTitle(card.id, title)}
                  onChangeModel={(provider, model) => onChangeCardModel(card.id, provider, model)}
                  onChangeReasoningEffort={(reasoningEffort) =>
                    onChangeCardReasoningEffort(card.id, reasoningEffort)
                  }
                  onTogglePlanMode={() => onToggleCardPlanMode(card.id)}
                  onToggleThinking={() => onToggleCardThinking(card.id)}
                  onToggleCollapsed={() => onToggleCardCollapsed(card.id)}
                  onMarkRead={() => onMarkCardRead(card.id)}
                  onOpenFile={(relativePath) => onOpenFile?.(pane.id, relativePath)}
                  isRestored={false}
                  chromeMode="pane"
                  isActive={isActive}
                  composerFocusRequest={composerFocusRequest}
                  recoveryStatus={cardRecoveryStatuses?.get(card.id)}
                />
              ) : null}
            </div>
          )
        })}
        {!activeCard && <div className="empty-pane" />}
      </div>

      {contextMenu && contextMenuActions ? (
        <div
          ref={contextMenuRef}
          className="pane-tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button type="button" onClick={contextMenuActions.close}>
            {language === 'zh-CN' ? '\u5173\u95ed' : 'Close'}
          </button>
          <button
            type="button"
            disabled={!contextMenuActions.closeOthers}
            onClick={contextMenuActions.closeOthers ?? undefined}
          >
            {language === 'zh-CN' ? '\u5173\u95ed\u5176\u4ed6' : 'Close Others'}
          </button>
          <button
            type="button"
            disabled={!contextMenuActions.closeRight}
            onClick={contextMenuActions.closeRight ?? undefined}
          >
            {language === 'zh-CN' ? '\u5173\u95ed\u53f3\u4fa7' : 'Close to the Right'}
          </button>
          <hr className="pane-tab-context-divider" />
          <button type="button" onClick={contextMenuActions.splitRight}>
            {language === 'zh-CN' ? '\u62c6\u5206\u5230\u53f3\u4fa7' : 'Split Right'}
          </button>
          <button type="button" onClick={contextMenuActions.splitDown}>
            {language === 'zh-CN' ? '\u62c6\u5206\u5230\u4e0b\u65b9' : 'Split Down'}
          </button>
        </div>
      ) : null}
      {/*
      {contextMenu && contextMenuActions ? (
        <div
          ref={contextMenuRef}
          className="pane-tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button type="button" onClick={contextMenuActions.close}>
            {language === 'zh-CN' ? '关闭' : 'Close'}
          </button>
          <button
            type="button"
            disabled={!contextMenuActions.closeOthers}
            onClick={contextMenuActions.closeOthers ?? undefined}
          >
            {language === 'zh-CN' ? '关闭其他' : 'Close Others'}
          </button>
          <button
            type="button"
            disabled={!contextMenuActions.closeRight}
            onClick={contextMenuActions.closeRight ?? undefined}
          >
            {language === 'zh-CN' ? '关闭右侧' : 'Close to the Right'}
          </button>
          <hr className="pane-tab-context-divider" />
          <button type="button" onClick={contextMenuActions.splitRight}>
            {language === 'zh-CN' ? '拆分到右侧' : 'Split Right'}
          </button>
          <button type="button" onClick={contextMenuActions.splitDown}>
            {language === 'zh-CN' ? '拆分到下方' : 'Split Down'}
          </button>
        </div>
      ) : null}
      */}
    </section>
  )
}

export const PaneView = memo(PaneViewView, arePaneViewPropsEqual)
PaneView.displayName = 'PaneView'
