import {
  archiveCardToHistory,
  createAutomationBoardItemCard,
  createAutomationBoardSupervisorCard,
  createCard,
  createId,
  createColumn,
  createDefaultAutomationBoardWorkspaceState,
  createDefaultPmState,
  createPane,
  createSplit,
  defaultProviderByIndex,
  getEffectiveCardModel,
  getConfiguredModel,
  getFirstPane,
  getOrderedColumnCards,
  getPreferredReasoningEffort,
  maxRecentWorkspaces,
  normalizeAppSettings,
  normalizeColumnWidth,
  normalizeLayoutNode,
  normalizeSplitRatios,
  rememberModelReasoningEffort,
  resetCardSessions,
  touchState,
  upsertStickyNoteArchiveEntry,
  updateStickyNoteArchiveViewState,
} from '../shared/default-state'
import { createDefaultBrainstormState } from '../shared/brainstorm'
import { getChatMessageAttachments } from '../shared/chat-attachments'
import { getDuplicateColumnTitle, getForkConversationTitle, getWorkspaceTitle } from '../shared/i18n'
import {
  AUTOMATIONBOARD_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  getDefaultModel,
  normalizeStoredModel,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
} from '../shared/models'
import type {
  AppSettings,
  AppState,
  AutomationBoard,
  AutomationBoardAutoTrigger,
  AutomationBoardItem,
  AutomationBoardLane,
  AutomationBoardTemplate,
  AutomationBoardWorkspaceState,
  BoardColumn,
  ChatCard,
  ChatMessage,
  ClosedWorkspaceSnapshot,
  LayoutNode,
  PaneNode,
  Provider,
  ProviderProfile,
  RequestModelSettings,
  SessionHistoryEntry,
  SplitNode,
  WakeTimerMode,
} from '../shared/schema'
import { automationBoardRequirementMaxChars, defaultAutoUrgeProfileId } from '../shared/schema'

type Placement = 'before' | 'after'

const toolCardModels = new Set([
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
])

export const isUntouchedWorkspacePlaceholderColumn = (column: BoardColumn | undefined) => {
  if (!column) {
    return false
  }

  const cards = Object.values(column.cards)
  if (cards.length !== 1) {
    return false
  }

  const [card] = cards
  return Boolean(
    card &&
    !toolCardModels.has(card.model) &&
    card.status === 'idle' &&
    card.messages.length === 0 &&
    !card.draft.trim() &&
    (card.draftAttachments?.length ?? 0) === 0 &&
    (card.queuedSends?.length ?? 0) === 0 &&
    !card.sessionId &&
    !card.streamId &&
    !card.stickyNote?.trim(),
  )
}

const cardHasHistoricalImageAttachments = (card: Pick<ChatCard, 'messages'>) =>
  card.messages.some((message) => getChatMessageAttachments(message).length > 0)

const providerRoutingSignature = (settings: AppSettings, provider: Provider) => {
  const collection = settings.providerProfiles[provider]
  const activeProfile = collection.profiles.find((profile) => profile.id === collection.activeProfileId)

  return [
    collection.activeProfileId.trim(),
    activeProfile?.baseUrl.trim() ?? '',
    activeProfile?.apiKey.trim() ?? '',
  ].join('\0')
}

const clearProviderNativeSessions = (state: AppState, provider: Provider): AppState => ({
  ...state,
  columns: state.columns.map((column) => ({
    ...column,
    cards: Object.fromEntries(
      Object.entries(column.cards).map(([cardId, card]) => {
        const providerSessions = { ...card.providerSessions }
        delete providerSessions[provider]

        const sessionId = card.provider === provider ? undefined : card.sessionId
        const sessionModel = card.provider === provider ? undefined : card.sessionModel
        const contextTransfer =
          card.contextTransfer?.sourceProvider === provider ? undefined : card.contextTransfer
        if (
          sessionId === card.sessionId &&
          sessionModel === card.sessionModel &&
          contextTransfer === card.contextTransfer &&
          Object.keys(providerSessions).length === Object.keys(card.providerSessions).length
        ) {
          return [cardId, card]
        }

        return [
          cardId,
          {
            ...card,
            sessionId,
            sessionModel,
            providerSessions,
            contextTransfer,
          },
        ]
      }),
    ),
  })),
  sessionHistory: state.sessionHistory.map((entry) =>
    (entry.provider === provider && entry.sessionId) || entry.contextTransfer?.sourceProvider === provider
      ? {
          ...entry,
          ...(entry.provider === provider
            ? { sessionId: undefined, sessionModel: undefined }
            : {}),
          ...(entry.contextTransfer?.sourceProvider === provider
            ? { contextTransfer: undefined }
            : {}),
        }
      : entry,
  ),
})

const clearSessionsForRoutingChanges = (
  previous: AppState,
  next: AppState,
  providers: Provider[] = ['codex', 'claude'],
) =>
  providers.reduce(
    (current, provider) =>
      providerRoutingSignature(previous.settings, provider) !== providerRoutingSignature(next.settings, provider)
        ? clearProviderNativeSessions(current, provider)
        : current,
    next,
  )

export type IdeAction =
  | { type: 'replace'; state: AppState }
  | { type: 'addColumn'; column?: BoardColumn }
  | { type: 'duplicateColumn'; columnId: string }
  | {
      type: 'updateSettings'
      patch: Partial<
        Pick<
          AppSettings,
          | 'language'
          | 'theme'
          | 'customThemeBase'
          | 'customBaseColor'
          | 'accentColor'
          | 'activeTopTab'
          | 'editor'
          | 'uiScale'
          | 'fontFamily'
          | 'fontScale'
          | 'lineHeightScale'
          | 'resilientProxyEnabled'
          | 'cliRoutingEnabled'
          | 'resilientProxyStallTimeoutSec'
          | 'resilientProxyFirstByteTimeoutSec'
          | 'resilientProxyMaxRetries'
          | 'musicAlbumCoverEnabled'
          | 'gitCardEnabled'
          | 'fileTreeCardEnabled'
          | 'stickyNoteCardEnabled'
          | 'automationBoardCardEnabled'
          | 'pmCardEnabled'
          | 'brainstormCardEnabled'
          | 'experimentalMusicEnabled'
          | 'experimentalWhiteNoiseEnabled'
          | 'experimentalWeatherEnabled'
          | 'agentDoneSoundEnabled'
          | 'agentDoneSoundVolume'
          | 'allAgentsDoneSoundEnabled'
          | 'allAgentsDoneSoundVolume'
          | 'crossProviderSkillReuseEnabled'
          | 'accessibilitySupportEnabled'
          | 'minimizeToTaskbarOnCloseEnabled'
          | 'autoUrgeEnabled'
          | 'autoUrgeProfiles'
          | 'autoUrgeActiveProfileId'
          | 'autoUrgeMessage'
          | 'autoUrgeSuccessKeyword'
          | 'autoUrgeGlobalControlEnabled'
          | 'autoUrgeGlobalActive'
          | 'autoUrgeGlobalProfileId'
          | 'repeatLoopEnabled'
          | 'wakeTimerEnabled'
          | 'weatherCity'
          | 'systemPrompt'
          | 'modelPromptRules'
          | 'codexPersonality'
          | 'codexFastMode'
          | 'agentOutsideWorkspaceWriteEnabled'
          | 'codexDestructiveCommandProtectionEnabled'
          | 'codexIsolatedHomeEnabled'
          | 'gitAgentModel'
          | 'providerProfiles'
        >
      >
    }
  | {
      type: 'updateRequestModels'
      patch: Partial<RequestModelSettings>
    }
  | {
      type: 'rememberModelReasoningEffort'
      provider: Provider
      model: string
      reasoningEffort?: string
    }
  | {
      type: 'upsertProviderProfile'
      provider: Provider
      profile: ProviderProfile
    }
  | {
      type: 'removeProviderProfile'
      provider: Provider
      profileId: string
    }
  | {
      type: 'setActiveProviderProfile'
      provider: Provider
      profileId: string
    }
  | { type: 'applyConfiguredModels' }
  | {
      type: 'updateColumn'
      columnId: string
      patch: Partial<Pick<BoardColumn, 'title' | 'provider' | 'workspacePath' | 'model'>>
    }
  | { type: 'setColumnWidth'; columnId: string; width: number }
  | { type: 'setColumnWidths'; widths: Array<{ columnId: string; width: number }> }
  | {
      type: 'reorderColumn'
      sourceColumnId: string
      targetColumnId: string
      placement: Placement
    }
  | { type: 'removeColumn'; columnId: string; workspaceCloseId?: string }
  | {
      type: 'restoreClosedWorkspace'
      columnId: string
      snapshot: ClosedWorkspaceSnapshot
    }
  | {
      type: 'restoreLegacyClosedWorkspace'
      columnId: string
      workspacePath: string
      entries: SessionHistoryEntry[]
    }
  | {
      type: 'addTab'
      columnId: string
      paneId: string
      cardId?: string
      title?: string
      provider?: Provider
      model?: string
      reasoningEffort?: string
      stickyNote?: string
    }
  | {
      type: 'spawnRepeatLoopTab'
      columnId: string
      sourceCardId: string
      cardId: string
    }
  | {
      type: 'splitPane'
      columnId: string
      paneId: string
      direction: SplitNode['direction']
      placement?: Placement
      tabId?: string
      newPaneId?: string
      splitId?: string
    }
  | {
      type: 'splitMoveTab'
      columnId: string
      sourcePaneId: string
      targetPaneId: string
      tabId: string
      direction: SplitNode['direction']
      placement?: Placement
      newPaneId: string
      splitId?: string
    }
  | { type: 'closeTab'; columnId: string; paneId: string; tabId: string }
  | {
      type: 'moveTab'
      sourceColumnId: string
      sourcePaneId: string
      tabId: string
      targetColumnId: string
      targetPaneId: string
      index?: number
    }
  | { type: 'reorderTab'; columnId: string; paneId: string; tabId: string; index: number }
  | { type: 'setActiveTab'; columnId: string; paneId: string; tabId: string }
  | { type: 'resizePane'; columnId: string; splitId: string; ratios: number[] }
  | { type: 'setCardDraft'; columnId: string; cardId: string; draft: string }
  | { type: 'clearStickyNoteArchive'; workspacePath: string }
  | {
      type: 'updateStickyNoteViewState'
      workspacePath: string
      viewState: { scrollTop: number; selectionStart: number; selectionEnd: number }
    }
  | { type: 'appendMessages'; columnId: string; cardId: string; messages: ChatMessage[] }
  | { type: 'upsertMessages'; columnId: string; cardId: string; messages: ChatMessage[] }
  | { type: 'resetCardConversation'; columnId: string; cardId: string; title?: string }
  | {
      type: 'forkConversation'
      columnId: string
      cardId: string
      messageId: string
      // Native provider session copied for this fork (lossless path); absent
      // when the fork falls back to the seeded-transcript replay.
      forkedSessionId?: string
    }
  | {
      type: 'selectCardModel'
      columnId: string
      cardId: string
      provider: Provider
      model: string
    }
  | {
      type: 'updateCard'
      columnId: string
      cardId: string
      patch: Partial<
        Pick<
          ChatCard,
          | 'title'
          | 'status'
          | 'sessionId'
          | 'sessionModel'
          | 'providerSessions'
          | 'streamId'
          | 'provider'
          | 'model'
          | 'reasoningEffort'
          | 'thinkingEnabled'
          | 'planMode'
          | 'autoUrgeActive'
          | 'autoUrgeProfileId'
          | 'repeatLoopActive'
          | 'repeatLoopRemaining'
          | 'collapsed'
          | 'unread'
          | 'completionGlow'
          | 'backgroundWorkPending'
          | 'stickyNote'
          | 'stickyNoteId'
          | 'stickyNoteViewState'
          | 'messages'
          | 'brainstorm'
          | 'draftAttachments'
          | 'queuedSends'
          | 'wakeTimerActive'
          | 'wakeTimerMode'
          | 'wakeTimerDurationMinutes'
          | 'wakeTimerQueuedSends'
          | 'wakeTimerArmedAt'
          | 'wakeTimerWakeAt'
          | 'wakeTimerPendingTargetIds'
        >
      >
    }
  | {
      type: 'appendAssistantDelta'
      columnId: string
      cardId: string
      messageId: string
      delta: string
      model?: string
    }
  | {
      type: 'finishStoppedStream'
      columnId: string
      cardId: string
      stoppedMessage?: ChatMessage
      unread?: boolean
    }
  | { type: 'settleStreamActivities'; columnId: string; cardId: string }
  | { type: 'recordRecentWorkspace'; path: string }
  | { type: 'removeRecentWorkspaces'; paths: string[] }
  | { type: 'restoreSession'; columnId: string; entryId: string; paneId?: string }
  | { type: 'restoreSessionEntries'; entryIds: string[] }
  | { type: 'removeSessionHistory'; entryIds: string[] }
  | { type: 'importExternalSession'; columnId: string; paneId?: string; entry: SessionHistoryEntry }
  | {
      type: 'createAutomationBoardItem'
      columnId: string
      boardCardId: string
      lane: AutomationBoardLane
      requirement: string
      index?: number
      provider?: Provider
      model?: string
      reasoningEffort?: string
      thinkingEnabled?: boolean
      planMode?: boolean
      wakeTimerActive?: boolean
      wakeTimerMode?: WakeTimerMode
      wakeTimerDurationMinutes?: number
      repeatLoopActive?: boolean
      repeatLoopRemaining?: number
      cardId?: string
    }
  | {
      type: 'setAutomationBoardItemLane'
      columnId: string
      boardCardId: string
      cardId: string
      lane: AutomationBoardLane
      index?: number
    }
  | {
      type: 'removeAutomationBoardItem'
      columnId: string
      boardCardId: string
      cardId: string
      deleteCard: boolean
    }
  | {
      type: 'stampAutomationBoardItem'
      columnId: string
      boardCardId: string
      cardId: string
      patch: { requirement?: string; startedAt?: string; completedAt?: string }
    }
  | {
      type: 'moveAutomationBoardItemToPane'
      columnId: string
      boardCardId: string
      cardId: string
      paneId: string
      index?: number
    }
  | {
      type: 'moveTabToAutomationBoard'
      columnId: string
      paneId: string
      tabId: string
      boardCardId: string
      lane: AutomationBoardLane
      index?: number
    }
  | {
      type: 'setAutomationBoardSupervisorExpanded'
      columnId: string
      boardCardId: string
      expanded: boolean
    }
  | {
      type: 'ensureAutomationBoardSupervisor'
      columnId: string
      boardCardId: string
      provider: Provider
      model: string
      reasoningEffort: string
      cardId?: string
    }
  | { type: 'saveAutomationBoardTemplate'; workspacePath: string; template: AutomationBoardTemplate }
  | { type: 'removeAutomationBoardTemplate'; workspacePath: string; templateId: string }
  | { type: 'renameAutomationBoardTemplate'; workspacePath: string; templateId: string; name: string }
  | {
      type: 'updateAutomationBoardAutoTrigger'
      workspacePath: string
      patch: Partial<AutomationBoardAutoTrigger>
    }

const clampInsertIndex = (index: number | undefined, length: number) => {
  if (typeof index !== 'number' || Number.isNaN(index)) {
    return length
  }

  return Math.max(0, Math.min(length, Math.trunc(index)))
}

const insertAt = (tabs: string[], tabId: string, index?: number) => {
  const nextTabs = tabs.filter((currentTabId) => currentTabId !== tabId)
  nextTabs.splice(clampInsertIndex(index, nextTabs.length), 0, tabId)
  return nextTabs
}

const getAutomationBoardCard = (column: BoardColumn | undefined, boardCardId: string) => {
  const card = column?.cards[boardCardId]
  return card?.model === AUTOMATIONBOARD_TOOL_MODEL && card.automationBoard ? card : undefined
}

/**
 * 把一个项放到目标泳道的指定位置。
 *
 * items 是**一个**扁平数组，泳道顺序 = 按 lane 过滤后的相对顺序。所以插入
 * 位置要先算出目标泳道内的绝对下标，再插进扁平数组，否则跨道拖拽的落点会
 * 相对错位。
 */
const placeAutomationBoardItem = (
  items: readonly AutomationBoardItem[],
  entry: AutomationBoardItem,
  index?: number,
): AutomationBoardItem[] => {
  const rest = items.filter((item) => item.cardId !== entry.cardId)
  const laneOffsets = rest.flatMap((item, position) => (item.lane === entry.lane ? [position] : []))
  const laneIndex = clampInsertIndex(index, laneOffsets.length)
  const insertPosition =
    laneIndex < laneOffsets.length
      ? laneOffsets[laneIndex]!
      : laneOffsets.length > 0
        ? laneOffsets[laneOffsets.length - 1]! + 1
        : rest.length

  const next = [...rest]
  next.splice(insertPosition, 0, entry)
  return next
}

const updateAutomationBoard = (
  state: AppState,
  columnId: string,
  boardCardId: string,
  patch: (board: AutomationBoard, column: BoardColumn) => AutomationBoard | null,
): AppState => {
  const column = state.columns.find((entry) => entry.id === columnId)
  const boardCard = getAutomationBoardCard(column, boardCardId)

  if (!column || !boardCard) {
    return state
  }

  const nextBoard = patch(boardCard.automationBoard!, column)
  if (!nextBoard) {
    return state
  }

  return touchState(
    updateColumn(state, columnId, (current) => ({
      ...current,
      cards: {
        ...current.cards,
        [boardCardId]: { ...current.cards[boardCardId]!, automationBoard: nextBoard },
      },
    })),
  )
}

const getAutomationBoardWorkspaceState = (
  state: AppState,
  workspacePath: string,
): AutomationBoardWorkspaceState =>
  state.automationBoards[workspacePath] ?? createDefaultAutomationBoardWorkspaceState()

const withAutomationBoardWorkspaceState = (
  state: AppState,
  workspacePath: string,
  patch: (current: AutomationBoardWorkspaceState) => AutomationBoardWorkspaceState,
): AppState => {
  if (!workspacePath.trim()) {
    return state
  }

  return touchState({
    ...state,
    automationBoards: {
      ...state.automationBoards,
      [workspacePath]: patch(getAutomationBoardWorkspaceState(state, workspacePath)),
    },
  })
}

/**
 * 一张卡被看板吸收时的"原始需求"。首条用户消息优先于草稿：跑过的会话里
 * 草稿可能是后来随手写的半句话，而监工要拿它跟交付情况比对。
 */
export const resolveAutomationBoardRequirementFromCard = (card: ChatCard): string => {
  const firstUserMessage = card.messages.find(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  )

  return (firstUserMessage?.content ?? card.draft ?? '').slice(0, automationBoardRequirementMaxChars)
}

const duplicateChatMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  meta: message.meta ? { ...message.meta } : undefined,
})

const duplicateCardForColumn = (card: ChatCard): ChatCard => ({
  ...card,
  id: createId(),
  sessionId: undefined,
  sessionModel: undefined,
  providerSessions: {},
  streamId: undefined,
  status: 'idle',
  pm: card.pm ? { ...card.pm } : createDefaultPmState(),
  pmTaskCardId: '',
  pmOwnerCardId: '',
  repeatLoopActive: false,
  repeatLoopRemaining: undefined,
  wakeTimerActive: false,
  wakeTimerQueuedSends: [],
  wakeTimerArmedAt: undefined,
  wakeTimerWakeAt: undefined,
  wakeTimerPendingTargetIds: [],
  messages: card.messages.map(duplicateChatMessage),
})

const duplicateLayoutForColumn = (
  layout: LayoutNode,
  duplicatedCardIds: ReadonlyMap<string, string>,
): LayoutNode => {
  if (layout.type === 'pane') {
    const tabs = layout.tabs.flatMap((tabId) => {
      const duplicatedTabId = duplicatedCardIds.get(tabId)
      return duplicatedTabId ? [duplicatedTabId] : []
    })

    const tabHistory = (layout.tabHistory ?? []).flatMap((tabId) => {
      const duplicatedTabId = duplicatedCardIds.get(tabId)
      return duplicatedTabId ? [duplicatedTabId] : []
    })

    return createPane(tabs, duplicatedCardIds.get(layout.activeTabId) ?? '', createId(), tabHistory)
  }

  return createSplit(
    layout.direction,
    layout.children.map((child) => duplicateLayoutForColumn(child, duplicatedCardIds)),
    layout.ratios,
    createId(),
  )
}

const duplicateColumnState = (
  column: BoardColumn,
  language: AppState['settings']['language'],
): BoardColumn => {
  const duplicatedCardIds = new Map<string, string>()
  const duplicatedCards = Object.fromEntries(
    Object.entries(column.cards).map(([cardId, card]) => {
      const duplicatedCard = duplicateCardForColumn(card)
      duplicatedCardIds.set(cardId, duplicatedCard.id)
      return [duplicatedCard.id, duplicatedCard]
    }),
  )

  return createColumn(
    {
      title: getDuplicateColumnTitle(language, column.title),
      provider: column.provider,
      workspacePath: column.workspacePath,
      model: column.model,
      width: column.width,
      layout: duplicateLayoutForColumn(column.layout, duplicatedCardIds),
      cards: duplicatedCards,
    },
    language,
  )
}

const ensurePane = (pane: PaneNode): PaneNode =>
  createPane(pane.tabs, pane.activeTabId, pane.id, pane.tabHistory)

export const findPaneInLayout = (layout: LayoutNode, paneId: string): PaneNode | null => {
  if (layout.type === 'pane') {
    return layout.id === paneId ? layout : null
  }

  for (const child of layout.children) {
    const pane = findPaneInLayout(child, paneId)
    if (pane) {
      return pane
    }
  }

  return null
}

export const findPaneForTab = (layout: LayoutNode, tabId: string): PaneNode | null => {
  if (layout.type === 'pane') {
    return layout.tabs.includes(tabId) ? layout : null
  }

  for (const child of layout.children) {
    const pane = findPaneForTab(child, tabId)
    if (pane) {
      return pane
    }
  }

  return null
}

export const findNodeParent = (
  layout: LayoutNode,
  nodeId: string,
): { parent: SplitNode; index: number } | null => {
  if (layout.type === 'pane') {
    return null
  }

  const directIndex = layout.children.findIndex((child) => child.id === nodeId)
  if (directIndex >= 0) {
    return { parent: layout, index: directIndex }
  }

  for (const child of layout.children) {
    const result = findNodeParent(child, nodeId)
    if (result) {
      return result
    }
  }

  return null
}

const firstPaneIn = (node: LayoutNode): PaneNode | null => {
  if (node.type === 'pane') return node
  for (const child of node.children) {
    const found = firstPaneIn(child)
    if (found) return found
  }
  return null
}

export const findAdjacentPane = (layout: LayoutNode, paneId: string): PaneNode | null => {
  const parentInfo = findNodeParent(layout, paneId)
  if (!parentInfo) return null
  const { parent, index } = parentInfo
  const siblingIndex = index + 1 < parent.children.length ? index + 1 : index - 1
  if (siblingIndex < 0 || siblingIndex >= parent.children.length) return null
  return firstPaneIn(parent.children[siblingIndex])
}

type PaneBounds = {
  pane: PaneNode
  left: number
  top: number
  width: number
  height: number
  area: number
}

const collectPaneBounds = (
  node: LayoutNode,
  left = 0,
  top = 0,
  width = 1,
  height = 1,
): PaneBounds[] => {
  if (node.type === 'pane') {
    return [
      {
        pane: node,
        left,
        top,
        width,
        height,
        area: width * height,
      },
    ]
  }

  const ratios = normalizeSplitRatios(node.ratios, node.children.length)
  let offset = 0

  return node.children.flatMap((child, index) => {
    const ratio = ratios[index] ?? 0

    if (node.direction === 'horizontal') {
      const childLeft = left + width * offset
      offset += ratio
      return collectPaneBounds(child, childLeft, top, width * ratio, height)
    }

    const childTop = top + height * offset
    offset += ratio
    return collectPaneBounds(child, left, childTop, width, height * ratio)
  })
}

const getPaneGapDistance = (source: PaneBounds, target: PaneBounds) => {
  const horizontalGap = Math.max(
    0,
    Math.max(source.left - (target.left + target.width), target.left - (source.left + source.width)),
  )
  const verticalGap = Math.max(
    0,
    Math.max(source.top - (target.top + target.height), target.top - (source.top + source.height)),
  )

  return Math.hypot(horizontalGap, verticalGap)
}

const getPaneCenterDistance = (source: PaneBounds, target: PaneBounds) => {
  const sourceCenterX = source.left + source.width / 2
  const sourceCenterY = source.top + source.height / 2
  const targetCenterX = target.left + target.width / 2
  const targetCenterY = target.top + target.height / 2

  return Math.hypot(sourceCenterX - targetCenterX, sourceCenterY - targetCenterY)
}

export const findNearestLargerPane = (layout: LayoutNode, paneId: string): PaneNode | null => {
  const panes = collectPaneBounds(layout)
  const source = panes.find(({ pane }) => pane.id === paneId)

  if (!source) {
    return null
  }

  const sourceArea = source.area
  const largerPanes = panes.filter(
    ({ pane, area }) => pane.id !== paneId && area > sourceArea + Number.EPSILON,
  )

  if (largerPanes.length === 0) {
    return null
  }

  let best = largerPanes[0]!
  let bestGapDistance = getPaneGapDistance(source, best)
  let bestCenterDistance = getPaneCenterDistance(source, best)

  for (let index = 1; index < largerPanes.length; index += 1) {
    const candidate = largerPanes[index]!
    const candidateGapDistance = getPaneGapDistance(source, candidate)
    const candidateCenterDistance = getPaneCenterDistance(source, candidate)

    const isBetter =
      candidateGapDistance < bestGapDistance - Number.EPSILON ||
      (Math.abs(candidateGapDistance - bestGapDistance) <= Number.EPSILON &&
        (candidateCenterDistance < bestCenterDistance - Number.EPSILON ||
          (Math.abs(candidateCenterDistance - bestCenterDistance) <= Number.EPSILON &&
            candidate.area > best.area + Number.EPSILON)))

    if (isBetter) {
      best = candidate
      bestGapDistance = candidateGapDistance
      bestCenterDistance = candidateCenterDistance
    }
  }

  return best.pane
}

const updateLayoutNode = (
  layout: LayoutNode,
  nodeId: string,
  updater: (node: LayoutNode) => LayoutNode,
): LayoutNode => {
  if (layout.id === nodeId) {
    return updater(layout)
  }

  if (layout.type === 'pane') {
    return layout
  }

  return {
    ...layout,
    children: layout.children.map((child) => updateLayoutNode(child, nodeId, updater)),
  }
}

const updatePaneNode = (
  layout: LayoutNode,
  paneId: string,
  updater: (pane: PaneNode) => PaneNode,
): LayoutNode =>
  updateLayoutNode(layout, paneId, (node) => (node.type === 'pane' ? updater(node) : node))

const updateSplitNode = (
  layout: LayoutNode,
  splitId: string,
  updater: (split: SplitNode) => SplitNode,
): LayoutNode =>
  updateLayoutNode(layout, splitId, (node) => (node.type === 'split' ? updater(node) : node))

const collapseLayout = (layout: LayoutNode, isRoot = true): LayoutNode => {
  if (layout.type === 'pane') {
    return ensurePane(layout)
  }

  const children = layout.children
    .map((child) => collapseLayout(child, false))
    .filter((child) => child.type !== 'pane' || child.tabs.length > 0)

  if (children.length === 0) {
    return isRoot ? createPane([], '', getFirstPane(layout).id) : createPane([])
  }

  if (children.length === 1) {
    return children[0]!
  }

  return createSplit(layout.direction, children, layout.ratios, layout.id)
}

export const removePaneFromLayout = (layout: LayoutNode, paneId: string): LayoutNode | null => {
  if (layout.type === 'pane') {
    return layout.id === paneId ? null : layout
  }

  const children = layout.children
    .map((child) => removePaneFromLayout(child, paneId))
    .filter((child): child is LayoutNode => child !== null)

  if (children.length === 0) {
    return null
  }

  if (children.length === 1) {
    return children[0]!
  }

  return createSplit(layout.direction, children, layout.ratios, layout.id)
}

export const insertPaneInSplit = (
  layout: LayoutNode,
  splitId: string,
  pane: PaneNode,
  index?: number,
): LayoutNode =>
  updateSplitNode(layout, splitId, (split) => {
    const children = [...split.children]
    children.splice(clampInsertIndex(index, children.length), 0, pane)
    return createSplit(split.direction, children, split.ratios, split.id)
  })

const upsertCardMessages = (messages: ChatMessage[], updates: ChatMessage[]) => {
  if (updates.length === 0) {
    return messages
  }

  const nextMessages = [...messages]

  for (const update of updates) {
    const existingIndex = nextMessages.findIndex((message) => message.id === update.id)

    if (existingIndex < 0) {
      nextMessages.push(update)
      continue
    }

    nextMessages[existingIndex] = {
      ...update,
      createdAt: nextMessages[existingIndex]?.createdAt ?? update.createdAt,
    }
  }

  return nextMessages
}

const appendUniqueCardMessages = (messages: ChatMessage[], additions: ChatMessage[]) => {
  if (additions.length === 0) {
    return messages
  }

  const seenIds = new Set(messages.map((message) => message.id))
  const uniqueAdditions: ChatMessage[] = []

  for (const addition of additions) {
    if (seenIds.has(addition.id)) {
      continue
    }

    seenIds.add(addition.id)
    uniqueAdditions.push(addition)
  }

  return uniqueAdditions.length > 0 ? [...messages, ...uniqueAdditions] : messages
}

const settleStoppedStreamMessages = (messages: ChatMessage[]) => {
  let didChange = false

  const nextMessages = messages.map((message) => {
    if (typeof message.meta?.structuredData !== 'string') {
      return message
    }

    try {
      const payload = JSON.parse(message.meta.structuredData) as Record<string, unknown>
      let nextPayload: Record<string, unknown> | null = null
      if (message.meta.kind === 'command' && payload.status === 'in_progress') {
        nextPayload = {
          ...payload,
          status: 'declined',
        }
      } else if (
        message.meta.kind === 'agents' &&
        payload.view === 'status' &&
        Array.isArray(payload.agents) &&
        payload.agents.length > 0
      ) {
        nextPayload = {
          ...payload,
          agents: [],
        }
      }

      if (!nextPayload) return message
      didChange = true
      return {
        ...message,
        meta: {
          ...message.meta,
          structuredData: JSON.stringify(nextPayload),
        },
      }
    } catch {
      return message
    }
  })

  return didChange ? nextMessages : messages
}

const getAverageColumnWidth = (columns: BoardColumn[]) => {
  const widths = columns
    .map((column) => normalizeColumnWidth(column.width))
    .filter((width): width is number => width !== undefined)

  if (widths.length === 0) {
    return undefined
  }

  return normalizeColumnWidth(widths.reduce((sum, width) => sum + width, 0) / widths.length)
}

const sumColumnWidths = (widths: number[]) => widths.reduce((sum, width) => sum + width, 0)

const roundColumnWidthsToTotal = (widths: number[], targetTotal: number) => {
  const floors = widths.map((width) => Math.floor(width))
  const rounded = [...floors]
  const remainder = targetTotal - sumColumnWidths(floors)

  if (remainder <= 0) {
    return rounded
  }

  const byFraction = widths
    .map((width, index) => ({ index, fraction: width - floors[index]! }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)

  for (let index = 0; index < remainder; index += 1) {
    rounded[byFraction[index]?.index ?? 0] += 1
  }

  return rounded
}

const scaleColumnWidthsToTotal = (widths: number[], targetTotal: number) => {
  if (widths.length === 0) {
    return []
  }

  const currentTotal = sumColumnWidths(widths)
  if (currentTotal <= 0 || currentTotal === targetTotal) {
    return widths
  }

  return roundColumnWidthsToTotal(
    widths.map((width) => width * targetTotal / currentTotal),
    targetTotal,
  ).map((width) => normalizeColumnWidth(width) ?? width)
}

const redistributeWidthsAfterColumnRemoval = (columns: BoardColumn[], removedColumnId: string) => {
  const removedColumn = columns.find((column) => column.id === removedColumnId)
  if (!removedColumn) {
    return columns
  }

  const remainingColumns = columns.filter((column) => column.id !== removedColumnId)
  if (remainingColumns.length === 0) {
    return remainingColumns
  }

  const removedWidth = normalizeColumnWidth(removedColumn.width)
  const remainingWidths = remainingColumns.map((column) => normalizeColumnWidth(column.width))
  const canPreserveExplicitWidths =
    removedWidth !== undefined && remainingWidths.every((width): width is number => width !== undefined)

  if (!canPreserveExplicitWidths) {
    return remainingColumns.map((column) =>
      column.width === undefined
        ? column
        : {
            ...column,
            width: undefined,
          },
    )
  }

  const scaledWidths = scaleColumnWidthsToTotal(
    remainingWidths,
    sumColumnWidths(remainingWidths) + removedWidth,
  )

  return remainingColumns.map((column, index) => {
    const nextWidth = scaledWidths[index]
    if (column.width === nextWidth) {
      return column
    }

    return {
      ...column,
      width: nextWidth,
    }
  })
}

const archiveColumnChatsToHistory = (
  history: SessionHistoryEntry[] | undefined,
  column: BoardColumn | undefined,
  workspaceCloseId?: string,
) => {
  if (!column) {
    return history ?? []
  }

  return getOrderedColumnCards(column).reduce(
    (nextHistory, card) => archiveCardToHistory(nextHistory, card, column.workspacePath, workspaceCloseId),
    history ?? [],
  )
}

const updateColumn = (
  state: AppState,
  columnId: string,
  updater: (column: BoardColumn) => BoardColumn,
) => ({
  ...state,
  columns: state.columns.map((column) => (column.id === columnId ? updater(column) : column)),
})

const updateCard = (
  state: AppState,
  columnId: string,
  cardId: string,
  updater: (card: ChatCard) => ChatCard,
) =>
  updateColumn(state, columnId, (column) => {
    const current = column.cards[cardId]
    if (!current) {
      return column
    }

    return {
      ...column,
      cards: {
        ...column.cards,
        [cardId]: updater(current),
      },
    }
  })

const clearPmLinksForCardId = (state: AppState, removedCardId: string) => ({
  ...state,
  columns: state.columns.map((column) => ({
    ...column,
    cards: Object.fromEntries(
      Object.entries(column.cards).map(([cardId, card]) => {
        let nextCard = card

        if ((card.pmTaskCardId ?? '') === removedCardId) {
          nextCard = {
            ...nextCard,
            pmTaskCardId: '',
          }
        }

        if ((card.pmOwnerCardId ?? '') === removedCardId) {
          nextCard = {
            ...nextCard,
            pmOwnerCardId: '',
          }
        }

        return [cardId, nextCard]
      }),
    ),
  })),
})

const detachPmLinksForCardId = (state: AppState, cardId: string) => {
  const nextState = clearPmLinksForCardId(state, cardId)

  return {
    ...nextState,
    columns: nextState.columns.map((column) => {
      const card = column.cards[cardId]
      if (!card) {
        return column
      }

      if ((card.pmTaskCardId ?? '') === '' && (card.pmOwnerCardId ?? '') === '') {
        return column
      }

      return {
        ...column,
        cards: {
          ...column.cards,
          [cardId]: {
            ...card,
            pmTaskCardId: '',
            pmOwnerCardId: '',
          },
        },
      }
    }),
  }
}

const mergeSettings = (state: AppState, patch: Partial<AppSettings>) => ({
  ...state,
  settings: normalizeAppSettings({
    ...state.settings,
    ...patch,
    requestModels: patch.requestModels ?? state.settings.requestModels,
    modelPromptRules: patch.modelPromptRules ?? state.settings.modelPromptRules,
    modelReasoningEfforts: patch.modelReasoningEfforts ?? state.settings.modelReasoningEfforts,
    providerProfiles: patch.providerProfiles ?? state.settings.providerProfiles,
  }),
})

const applyRequestModelPatch = (state: AppState, patch: Partial<RequestModelSettings>) => {
  if (Object.keys(patch).length === 0) {
    return state
  }

  const nextRequestModels = {
    ...state.settings.requestModels,
    ...patch,
  }
  const updatedProviders = Object.keys(patch) as Provider[]
  const nextLastModel =
    state.settings.lastModel && updatedProviders.includes(state.settings.lastModel.provider)
      ? {
          provider: state.settings.lastModel.provider,
          model: nextRequestModels[state.settings.lastModel.provider],
        }
      : state.settings.lastModel
  const next = mergeSettings(state, {
    requestModels: nextRequestModels,
    lastModel: nextLastModel,
  })

  // Default-model changes only affect future chats: refresh the column's
  // remembered model (the seed for newly opened tabs) when it was just carrying
  // the previous default, but never touch already-open cards — their model and
  // session stay pinned to what the user sees.
  return {
    ...next,
    columns: next.columns.map((column) => {
      const providerWasUpdated = updatedProviders.includes(column.provider)
      const previousConfiguredModel = state.settings.requestModels[column.provider]
      const nextConfiguredModel = next.settings.requestModels[column.provider]
      const shouldUpdateColumnModel =
        providerWasUpdated && (column.model.trim().length === 0 || column.model === previousConfiguredModel)

      if (!shouldUpdateColumnModel) {
        return column
      }

      return {
        ...column,
        model: nextConfiguredModel,
      }
    }),
  }
}

const selectCardModel = (
  state: AppState,
  columnId: string,
  cardId: string,
  provider: Provider,
  model: string,
) => {
  const column = state.columns.find((entry) => entry.id === columnId)
  const card = column?.cards[cardId]

  if (!column || !card) {
    return state
  }

  const normalizedModel = normalizeStoredModel(provider, model)
  const shouldRememberRequestModel = normalizedModel.length > 0 && !toolCardModels.has(normalizedModel)
  let nextState =
    shouldRememberRequestModel && state.settings.requestModels[provider] !== normalizedModel
      ? applyRequestModelPatch(state, { [provider]: normalizedModel })
      : state
  if (shouldRememberRequestModel) {
    nextState = mergeSettings(nextState, { lastModel: { provider, model: normalizedModel } })
  }
  const providerChanged = card.provider !== provider
  const previousEffectiveModel = getEffectiveCardModel(nextState.settings, card.provider, card.model)
  const nextEffectiveModel = getEffectiveCardModel(nextState.settings, provider, normalizedModel)
  const modelChanged = providerChanged || previousEffectiveModel !== nextEffectiveModel
  const hasTransferableContext = card.messages.some(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      (message.content.trim().length > 0 ||
        Boolean(message.meta?.structuredData?.trim()) ||
        getChatMessageAttachments(message).length > 0),
  )
  const existingTransfer = card.contextTransfer
  const returnsToTransferSource = Boolean(
    existingTransfer &&
      provider === existingTransfer.sourceProvider &&
      nextEffectiveModel === normalizeStoredModel(existingTransfer.sourceProvider, existingTransfer.sourceModel),
  )
  const shouldInvalidateSessionsForImageReplay =
    modelChanged && cardHasHistoricalImageAttachments(card)

  let sessionPatch: Pick<
    Partial<ChatCard>,
    'sessionId' | 'sessionModel' | 'providerSessions' | 'contextTransfer'
  > = {}
  if (modelChanged && returnsToTransferSource && existingTransfer) {
    const savedSessions = { ...card.providerSessions }
    delete savedSessions[provider]
    const currentSessionId =
      card.sessionModel?.trim() === previousEffectiveModel
        ? card.sessionId?.trim() || undefined
        : undefined
    sessionPatch = {
      sessionId: existingTransfer.sourceSessionId,
      sessionModel: existingTransfer.sourceSessionId
        ? normalizeStoredModel(existingTransfer.sourceProvider, existingTransfer.sourceModel)
        : undefined,
      providerSessions: savedSessions,
      contextTransfer: currentSessionId
        ? {
            sourceProvider: card.provider,
            sourceModel: card.sessionModel?.trim() || previousEffectiveModel,
            sourceSessionId: currentSessionId,
          }
        : undefined,
    }
  } else if (shouldInvalidateSessionsForImageReplay) {
    sessionPatch = {
      sessionId: undefined,
      sessionModel: undefined,
      providerSessions: {},
    }
  } else if (providerChanged) {
    const savedSessions = { ...card.providerSessions }
    if (card.sessionId) {
      savedSessions[card.provider] = card.sessionId
    }
    const restoredSessionId = savedSessions[provider]
    delete savedSessions[provider]
    sessionPatch = {
      sessionId: restoredSessionId,
      sessionModel: undefined,
      providerSessions: savedSessions,
    }
  } else if (modelChanged) {
    sessionPatch = {
      sessionId: undefined,
      sessionModel: undefined,
      providerSessions: {},
    }
  }

  if (
    modelChanged &&
    !returnsToTransferSource &&
    hasTransferableContext &&
    !toolCardModels.has(normalizedModel) &&
    !toolCardModels.has(card.model)
  ) {
    const currentSessionId =
      card.sessionModel?.trim() === previousEffectiveModel
        ? card.sessionId?.trim() || undefined
        : undefined
    sessionPatch.contextTransfer =
      currentSessionId || !existingTransfer
        ? {
            sourceProvider: card.provider,
            sourceModel: card.sessionModel?.trim() || previousEffectiveModel,
            ...(currentSessionId ? { sourceSessionId: currentSessionId } : {}),
          }
        : existingTransfer
  }

  const updatedState = updateColumn(nextState, columnId, (currentColumn) => {
    const currentCard = currentColumn.cards[cardId]
    if (!currentCard) {
      return currentColumn
    }

    const shouldRememberColumnModel =
      provider === currentColumn.provider && !toolCardModels.has(normalizedModel)

    return {
      ...currentColumn,
      model: shouldRememberColumnModel ? normalizedModel : currentColumn.model,
      cards: {
        ...currentColumn.cards,
        [cardId]: {
          ...currentCard,
          provider,
          model: normalizedModel,
          stickyNoteId:
            normalizedModel === STICKYNOTE_TOOL_MODEL
              ? currentCard.stickyNoteId?.trim() || currentCard.id
              : currentCard.stickyNoteId,
          pmTaskCardId: '',
          pmOwnerCardId: '',
          backgroundWorkPending: false,
          reasoningEffort: getPreferredReasoningEffort(nextState.settings, provider, normalizedModel),
          ...sessionPatch,
        },
      },
    }
  })

  return updatedState
}

const buildRestoredCard = (state: AppState, entry: SessionHistoryEntry): ChatCard => ({
  id: createId(),
  title: entry.title,
  sessionId: entry.sessionId,
  sessionModel: entry.sessionModel,
  contextTransfer: entry.contextTransfer,
  providerSessions: {},
  streamId: undefined,
  status: 'idle',
  provider: entry.provider,
  model: entry.model,
  reasoningEffort: getPreferredReasoningEffort(state.settings, entry.provider, entry.model),
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: defaultAutoUrgeProfileId,
  repeatLoopActive: false,
  repeatLoopRemaining: undefined,
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments: [],
  queuedSends: [],
  wakeTimerActive: false,
  wakeTimerMode: 'workspace-agents',
  wakeTimerDurationMinutes: 30,
  wakeTimerQueuedSends: [],
  wakeTimerPendingTargetIds: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  pm: createDefaultPmState(),
  pmTaskCardId: '',
  pmOwnerCardId: '',
  messages: entry.messages,
})

const restoreSessionEntryToColumn = (
  state: AppState,
  columnId: string,
  entry: SessionHistoryEntry,
  paneId?: string,
) => {
  const restoredCard = buildRestoredCard(state, entry)

  return insertCardIntoColumn(state, columnId, restoredCard, paneId)
}

const restoreClosedWorkspaceSnapshotToColumn = (
  state: AppState,
  columnId: string,
  snapshot: ClosedWorkspaceSnapshot,
) => {
  const next = updateColumn(state, columnId, (currentColumn) => {
    const cards = Object.fromEntries(
      Object.entries(snapshot.column.cards).map(([cardId, card]) => [
        cardId,
        {
          ...card,
          status: card.status === 'streaming' ? 'idle' : card.status,
          streamId: undefined,
        },
      ]),
    )

    return {
      ...snapshot.column,
      id: currentColumn.id,
      width: currentColumn.width,
      cards,
      layout: normalizeLayoutNode(snapshot.column.layout, cards),
    }
  })

  return {
    ...next,
    sessionHistory: next.sessionHistory.filter(
      (entry) => entry.workspaceCloseId !== snapshot.closeId,
    ),
  }
}

const restoreLegacyClosedWorkspaceToColumn = (
  state: AppState,
  columnId: string,
  workspacePath: string,
  entries: SessionHistoryEntry[],
) => {
  if (entries.length === 0) {
    return state
  }

  const restoredCards = entries
    .slice()
    .reverse()
    .map((entry) => buildRestoredCard(state, entry))
  const cards = Object.fromEntries(restoredCards.map((card) => [card.id, card]))
  const entryIds = new Set(entries.map((entry) => entry.id))
  const next = updateColumn(state, columnId, (currentColumn) => {
    const paneId = getFirstPane(currentColumn.layout).id
    const tabs = restoredCards.map((card) => card.id)

    return {
      ...currentColumn,
      workspacePath,
      cards,
      layout: createPane(tabs, tabs.at(-1) ?? '', paneId),
    }
  })

  return {
    ...next,
    sessionHistory: next.sessionHistory.filter((entry) => !entryIds.has(entry.id)),
  }
}

const normalizeWorkspacePathKey = (workspacePath: string) => workspacePath.trim().toLowerCase()

const rebaseSessionHistoryWorkspacePath = (
  history: SessionHistoryEntry[],
  fromWorkspacePath: string,
  toWorkspacePath: string,
) => {
  const fromKey = normalizeWorkspacePathKey(fromWorkspacePath)
  const toPath = toWorkspacePath.trim()

  if (!fromKey || !toPath || fromKey === normalizeWorkspacePathKey(toPath)) {
    return history
  }

  let changed = false
  const nextHistory = history.map((entry) => {
    if (normalizeWorkspacePathKey(entry.workspacePath) !== fromKey) {
      return entry
    }

    changed = true
    return {
      ...entry,
      workspacePath: toPath,
    }
  })

  return changed ? nextHistory : history
}

const insertCardIntoColumn = (
  state: AppState,
  columnId: string,
  card: ChatCard,
  paneId?: string,
) =>
  updateColumn(state, columnId, (column) => {
    const firstPane = getFirstPane(column.layout)
    if (!firstPane) {
      return column
    }

    const targetPaneId =
      paneId && findPaneInLayout(column.layout, paneId)
        ? paneId
        : firstPane.id

    return {
      ...column,
      cards: {
        ...column.cards,
        [card.id]: card,
      },
      layout: updatePaneNode(column.layout, targetPaneId, (pane) =>
        createPane(
          [card.id, ...pane.tabs.filter((existingTabId) => existingTabId !== card.id)],
          card.id,
          pane.id,
          pane.tabHistory,
        ),
      ),
    }
  })

const findBestRestoreColumnId = (state: AppState, entry: SessionHistoryEntry) =>
  state.columns.find((column) => column.workspacePath.toLowerCase() === entry.workspacePath.toLowerCase())?.id
  ?? state.columns[0]?.id

const rebindCardToColumn = (
  state: AppState,
  targetColumn: BoardColumn,
  card: ChatCard,
): ChatCard => {
  const provider = targetColumn.provider
  const nextModel = toolCardModels.has(card.model)
    ? card.model
    : getConfiguredModel(state.settings, provider)

  return {
    ...card,
    provider,
    model: nextModel,
    reasoningEffort: getPreferredReasoningEffort(state.settings, provider, nextModel),
    sessionId: undefined,
    sessionModel: undefined,
    providerSessions: {},
    streamId: undefined,
    status: 'idle',
    pmTaskCardId: '',
    pmOwnerCardId: '',
  }
}

const applyConfiguredModels = (state: AppState) => ({
  ...state,
  columns: state.columns.map((column) => ({
    ...column,
    model: getConfiguredModel(state.settings, column.provider),
    cards: Object.fromEntries(
      Object.entries(column.cards).map(([cardId, card]) => {
        if (toolCardModels.has(card.model)) {
          return [cardId, { ...card, provider: column.provider }]
        }

        const nextModel = getConfiguredModel(state.settings, column.provider)
        return [
          cardId,
          {
            ...card,
            provider: column.provider,
            model: nextModel,
            reasoningEffort: getPreferredReasoningEffort(state.settings, column.provider, nextModel),
          },
        ]
      }),
    ),
  })),
})

const updateProviderProfileCollection = (
  state: AppState,
  provider: Provider,
  updater: (collection: AppState['settings']['providerProfiles'][Provider]) => AppState['settings']['providerProfiles'][Provider],
) =>
  mergeSettings(state, {
    providerProfiles: {
      ...state.settings.providerProfiles,
      [provider]: updater(state.settings.providerProfiles[provider]),
    },
  })

const reorderColumn = (
  state: AppState,
  sourceColumnId: string,
  targetColumnId: string,
  placement: Placement,
) => {
  const sourceIndex = state.columns.findIndex((column) => column.id === sourceColumnId)
  const targetIndex = state.columns.findIndex((column) => column.id === targetColumnId)

  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return state
  }

  const nextColumns = [...state.columns]
  const [column] = nextColumns.splice(sourceIndex, 1)
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  const insertIndex = placement === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex

  nextColumns.splice(insertIndex, 0, column)

  if (nextColumns.every((item, index) => item.id === state.columns[index]?.id)) {
    return state
  }

  return {
    ...state,
    columns: nextColumns,
  }
}

// Shared by the fork reducer and the App fork handler: forking from an
// assistant message falls back to the preceding user prompt, and the fork
// context is everything strictly before that user message.
export const resolveForkPointMessage = (
  messages: ChatMessage[],
  messageId: string,
): { messageIndex: number; message: ChatMessage } | null => {
  const selectedMessageIndex = messages.findIndex((message) => message.id === messageId)
  if (selectedMessageIndex < 0) return null

  const messageIndex =
    messages[selectedMessageIndex]?.role === 'user'
      ? selectedMessageIndex
      : messages
          .slice(0, selectedMessageIndex)
          .map((message, index) => ({ message, index }))
          .reverse()
          .find(({ message }) => message.role === 'user')?.index ?? -1
  if (messageIndex < 0) return null

  return { messageIndex, message: messages[messageIndex]! }
}

export const ideReducer = (state: AppState, action: IdeAction): AppState => {
  switch (action.type) {
    case 'replace':
      return action.state
    case 'addColumn': {
      const lastColumn = state.columns.at(-1)
      const remembered = state.settings.lastModel
      const provider =
        remembered?.provider ?? lastColumn?.provider ?? defaultProviderByIndex(state.columns.length)
      const language = state.settings.language
      const model = remembered?.model || getConfiguredModel(state.settings, provider)
      const nextColumn =
        action.column ??
        createColumn(
          {
            title: getWorkspaceTitle(language, state.columns.length + 1),
            provider,
            workspacePath: state.columns.at(-1)?.workspacePath ?? '',
            model,
            width: getAverageColumnWidth(state.columns),
          },
          language,
        )

      return touchState({
        ...state,
        columns: [...state.columns, nextColumn],
      })
    }
    case 'duplicateColumn': {
      const source = state.columns.find((column) => column.id === action.columnId)
      if (!source) {
        return state
      }

      return touchState({
        ...state,
        columns: [
          ...state.columns,
          duplicateColumnState(source, state.settings.language),
        ],
      })
    }
    case 'updateSettings': {
      const next = mergeSettings(state, action.patch)
      return touchState(
        'providerProfiles' in action.patch
          ? clearSessionsForRoutingChanges(state, next)
          : next,
      )
    }
    case 'updateRequestModels': {
      return touchState(applyRequestModelPatch(state, action.patch))
    }
    case 'rememberModelReasoningEffort':
      return touchState(
        mergeSettings(state, {
          modelReasoningEfforts: rememberModelReasoningEffort(
            state.settings,
            action.provider,
            action.model,
            action.reasoningEffort,
          ),
        }),
      )
    case 'upsertProviderProfile': {
      const next = updateProviderProfileCollection(state, action.provider, (collection) => {
          const exists = collection.profiles.some((profile) => profile.id === action.profile.id)
          const profiles = exists
            ? collection.profiles.map((profile) =>
                profile.id === action.profile.id ? action.profile : profile,
              )
            : [...collection.profiles, action.profile]

          return {
            activeProfileId: collection.activeProfileId || action.profile.id,
            profiles,
          }
        })

      return touchState(clearSessionsForRoutingChanges(state, next, [action.provider]))
    }
    case 'removeProviderProfile': {
      const next = updateProviderProfileCollection(state, action.provider, (collection) => {
          const profiles = collection.profiles.filter((profile) => profile.id !== action.profileId)
          return {
            activeProfileId:
              collection.activeProfileId === action.profileId ? (profiles[0]?.id ?? '') : collection.activeProfileId,
            profiles,
          }
        })

      return touchState(clearSessionsForRoutingChanges(state, next, [action.provider]))
    }
    case 'setActiveProviderProfile': {
      const next = updateProviderProfileCollection(state, action.provider, (collection) => ({
          activeProfileId:
            action.profileId && collection.profiles.some((profile) => profile.id === action.profileId)
              ? action.profileId
              : '',
          profiles: collection.profiles,
        }))

      return touchState(clearSessionsForRoutingChanges(state, next, [action.provider]))
    }
    case 'applyConfiguredModels':
      return touchState(applyConfiguredModels(state))
    case 'updateColumn': {
      const currentColumn = state.columns.find((column) => column.id === action.columnId)
      const previousWorkspacePath = currentColumn?.workspacePath ?? ''
      const nextWorkspacePath =
        action.patch.workspacePath !== undefined ? action.patch.workspacePath : previousWorkspacePath
      const next = updateColumn(state, action.columnId, (column) => {
        const providerChanged = action.patch.provider && action.patch.provider !== column.provider
        const workspaceChanged =
          action.patch.workspacePath !== undefined && action.patch.workspacePath !== column.workspacePath
        const provider = action.patch.provider ?? column.provider
        const model =
          action.patch.model ?? (providerChanged ? getConfiguredModel(state.settings, provider) : column.model)
        const cards = providerChanged || workspaceChanged ? resetCardSessions(column.cards) : column.cards

        return {
          ...column,
          ...action.patch,
          provider,
          model,
          cards: providerChanged
            ? Object.fromEntries(
                Object.entries(cards).map(([cardId, card]) => {
                  const nextModel = toolCardModels.has(card.model) ? card.model : model
                  return [
                    cardId,
                    {
                      ...card,
                      provider,
                      model: nextModel,
                      reasoningEffort: getPreferredReasoningEffort(state.settings, provider, nextModel),
                    },
                  ]
                }),
              )
            : cards,
        }
      })

      const sessionHistory =
        action.patch.workspacePath !== undefined &&
        !state.columns.some(
          (column) =>
            column.id !== action.columnId &&
            normalizeWorkspacePathKey(column.workspacePath) === normalizeWorkspacePathKey(previousWorkspacePath),
        )
          ? rebaseSessionHistoryWorkspacePath(
              next.sessionHistory,
              previousWorkspacePath,
              nextWorkspacePath,
            )
          : next.sessionHistory

      return touchState(sessionHistory === next.sessionHistory ? next : { ...next, sessionHistory })
    }
    case 'setColumnWidth': {
      const width = normalizeColumnWidth(action.width)
      const current = state.columns.find((column) => column.id === action.columnId)

      if (!current || current.width === width) {
        return state
      }

      const next = updateColumn(state, action.columnId, (column) => ({
        ...column,
        width,
      }))

      return touchState(next)
    }
    case 'setColumnWidths': {
      const widthByColumnId = new Map(
        action.widths.map(({ columnId, width }) => [columnId, normalizeColumnWidth(width)]),
      )
      let changed = false

      const nextColumns = state.columns.map((column) => {
        if (!widthByColumnId.has(column.id)) {
          return column
        }

        const nextWidth = widthByColumnId.get(column.id)
        if (column.width === nextWidth) {
          return column
        }

        changed = true
        return {
          ...column,
          width: nextWidth,
        }
      })

      if (!changed) {
        return state
      }

      return touchState({
        ...state,
        columns: nextColumns,
      })
    }
    case 'reorderColumn': {
      const next = reorderColumn(state, action.sourceColumnId, action.targetColumnId, action.placement)
      return next === state ? state : touchState(next)
    }
    case 'removeColumn': {
      const column = state.columns.find((item) => item.id === action.columnId)
      const sessionHistory = archiveColumnChatsToHistory(
        state.sessionHistory,
        column,
        action.workspaceCloseId,
      )
      return touchState({
        ...state,
        sessionHistory,
        columns: redistributeWidthsAfterColumnRemoval(state.columns, action.columnId),
      })
    }
    case 'restoreClosedWorkspace':
      return touchState(restoreClosedWorkspaceSnapshotToColumn(state, action.columnId, action.snapshot))
    case 'restoreLegacyClosedWorkspace':
      return touchState(
        restoreLegacyClosedWorkspaceToColumn(
          state,
          action.columnId,
          action.workspacePath,
          action.entries,
        ),
      )
    case 'addTab': {
      const next = updateColumn(state, action.columnId, (column) => {
        const pane = findPaneInLayout(column.layout, action.paneId)
        if (!pane) {
          return column
        }

        const activeCardId = pane.activeTabId || pane.tabs[0] || ''
        const activeCard = column.cards[activeCardId]
        const recentChatCard = [
          ...(pane.tabHistory ?? []).slice().reverse(),
          ...pane.tabs.slice().reverse(),
        ]
          .map((tabId) => column.cards[tabId])
          .find((card) => card && !toolCardModels.has(card.model))
        const inheritedChatCard =
          activeCard && !toolCardModels.has(activeCard.model) ? activeCard : recentChatCard
        const activeChatProvider = inheritedChatCard?.provider
        const hasExplicitProvider = action.provider !== undefined
        const hasExplicitModel = action.model !== undefined
        const rememberedGlobal =
          !hasExplicitProvider && !hasExplicitModel ? state.settings.lastModel : undefined
        const provider = toolCardModels.has(action.model ?? '')
          ? 'codex'
          : (action.provider ?? activeChatProvider ?? rememberedGlobal?.provider ?? column.provider)
        const rememberedColumnModel =
          !hasExplicitProvider &&
          !hasExplicitModel &&
          provider === column.provider &&
          !toolCardModels.has(column.model)
            ? normalizeStoredModel(provider, column.model) || undefined
            : undefined
        const rememberedActiveModel =
          !hasExplicitProvider &&
          !hasExplicitModel &&
          inheritedChatCard &&
          inheritedChatCard.provider === provider
            ? normalizeStoredModel(provider, inheritedChatCard.model) || undefined
            : undefined
        const rememberedGlobalModel =
          rememberedGlobal?.provider === provider
            ? rememberedGlobal.model
            : undefined
        const staleFableColumnModel =
          provider === 'claude' &&
          rememberedColumnModel === 'claude-fable-5' &&
          ((rememberedActiveModel !== undefined && rememberedActiveModel !== rememberedColumnModel) ||
            (rememberedGlobalModel !== undefined && rememberedGlobalModel !== rememberedColumnModel))
        const model =
          action.model ??
          (staleFableColumnModel ? undefined : rememberedColumnModel) ??
          rememberedActiveModel ??
          rememberedGlobalModel ??
          getConfiguredModel(state.settings, provider)
        const newCard = {
          ...createCard(
            action.title,
            undefined,
            provider,
            model,
            action.reasoningEffort ?? getPreferredReasoningEffort(state.settings, provider, model),
            state.settings.language,
          ),
          id: action.cardId ?? createId(),
        }

        if (action.stickyNote) {
          newCard.stickyNote = action.stickyNote
        }

        return {
          ...column,
          cards: {
            ...column.cards,
            [newCard.id]: newCard,
          },
          layout: updatePaneNode(column.layout, action.paneId, (pane) =>
            createPane([...pane.tabs, newCard.id], newCard.id, pane.id, pane.tabHistory),
          ),
        }
      })

      return touchState(next)
    }
    case 'spawnRepeatLoopTab': {
      const targetColumn = state.columns.find((column) => column.id === action.columnId)
      const sourceCard = targetColumn?.cards[action.sourceCardId]
      const pane = targetColumn ? findPaneForTab(targetColumn.layout, action.sourceCardId) : null
      if (
        !targetColumn ||
        !sourceCard ||
        !pane ||
        targetColumn.cards[action.cardId] ||
        toolCardModels.has(sourceCard.model)
      ) {
        return state
      }

      const next = updateColumn(state, action.columnId, (column) => {
        const repeatedCard: ChatCard = {
          ...createCard(
            undefined,
            undefined,
            sourceCard.provider,
            sourceCard.model,
            sourceCard.reasoningEffort,
            state.settings.language,
          ),
          id: action.cardId,
          thinkingEnabled: sourceCard.thinkingEnabled,
          planMode: sourceCard.planMode,
          repeatLoopActive: true,
          repeatLoopRemaining:
            typeof sourceCard.repeatLoopRemaining === 'number'
              ? Math.max(0, sourceCard.repeatLoopRemaining - 1)
              : undefined,
        }

        return {
          ...column,
          cards: {
            ...column.cards,
            [repeatedCard.id]: repeatedCard,
          },
          layout: updatePaneNode(column.layout, pane.id, (currentPane) =>
            // 症状：后台任务完成并进入下一轮时，新 Tab 会抢走用户正在编辑的输入框。
            // 根因：2026-08-07 实测为循环 reducer 无条件改写 activeTabId；见 agent-repeat-loop SPEC。
            // 被否决：按“当前焦点是否在 textarea”临时判断有竞态；自动化 Tab 一律后台创建更可预测。
            createPane(
              [...currentPane.tabs, repeatedCard.id],
              currentPane.activeTabId,
              currentPane.id,
              currentPane.tabHistory,
            ),
          ),
        }
      })

      return touchState(next)
    }
    case 'splitPane': {
      const next = updateColumn(state, action.columnId, (column) => {
        const pane = findPaneInLayout(column.layout, action.paneId)
        if (!pane) {
          return column
        }

        const hasExplicitTab = action.tabId != null && pane.tabs.includes(action.tabId)
        const tabId = hasExplicitTab
          ? action.tabId
          : (pane.activeTabId || pane.tabs[0] || '')
        const currentPaneTabs = hasExplicitTab ? pane.tabs.filter((currentTabId) => currentTabId !== tabId) : pane.tabs
        const currentPane = createPane(
          currentPaneTabs,
          pane.activeTabId,
          pane.id,
          pane.tabHistory,
        )
        const newPane = createPane(hasExplicitTab ? [tabId!] : [], hasExplicitTab ? tabId! : '', action.newPaneId ?? createId())
        const children =
          action.placement === 'before' ? [newPane, currentPane] : [currentPane, newPane]
        const replacement = createSplit(action.direction, children, [0.5, 0.5], action.splitId ?? createId())

        const updatedLayout = updateLayoutNode(column.layout, action.paneId, () => replacement)
        return {
          ...column,
          layout: hasExplicitTab ? collapseLayout(updatedLayout) : updatedLayout,
        }
      })

      return touchState(next)
    }
    case 'splitMoveTab': {
      const next = updateColumn(state, action.columnId, (column) => {
        const sourcePane = findPaneInLayout(column.layout, action.sourcePaneId)
        const targetPane = findPaneInLayout(column.layout, action.targetPaneId)

        if (
          !sourcePane ||
          !targetPane ||
          sourcePane.id === targetPane.id ||
          !column.cards[action.tabId] ||
          !sourcePane.tabs.includes(action.tabId)
        ) {
          return column
        }

        let layout = collapseLayout(
          updatePaneNode(column.layout, action.sourcePaneId, (pane) =>
            createPane(
              pane.tabs.filter((tabId) => tabId !== action.tabId),
              pane.activeTabId === action.tabId ? '' : pane.activeTabId,
              pane.id,
              pane.tabHistory,
            ),
          ),
        )

        const updatedTargetPane = findPaneInLayout(layout, action.targetPaneId)
        if (!updatedTargetPane) {
          return {
            ...column,
            layout: normalizeLayoutNode(layout, column.cards),
          }
        }

        const currentTargetPane = createPane(
          updatedTargetPane.tabs,
          updatedTargetPane.activeTabId,
          updatedTargetPane.id,
          updatedTargetPane.tabHistory,
        )
        const newPane = createPane([action.tabId], action.tabId, action.newPaneId)
        const children =
          action.placement === 'before' ? [newPane, currentTargetPane] : [currentTargetPane, newPane]
        const replacement = createSplit(
          action.direction,
          children,
          [0.5, 0.5],
          action.splitId ?? createId(),
        )

        layout = updateLayoutNode(layout, action.targetPaneId, () => replacement)

        return {
          ...column,
          layout: normalizeLayoutNode(layout, column.cards),
        }
      })

      return touchState(next)
    }
    case 'closeTab': {
      const column = state.columns.find((entry) => entry.id === action.columnId)
      const card = column?.cards[action.tabId]
      // 症状：用一个已经被折叠掉的旧 paneId 关闭标签时，会话历史凭空多出一条归档、PM 链接被清空，
      //   但卡片还开着（重复点还会重复入档，prependSessionHistoryEntry 不按 cardId 去重）。
      // 根因：2026-08-02 审计——归档与 clearPmLinks 原本在 updateColumn 之外无条件执行，
      //   而真正删卡的 updateColumn 回调里另有 findPaneInLayout 守卫，守卫不满足时只跳过删除，副作用已经落地。
      // 为什么不是把归档挪进 updateColumn 回调：sessionHistory 是 state 级字段，回调只能返回 column；
      //   所以把 pane 校验提到副作用之前，让整个 case 要么全做要么原样返回。
      if (!column || !card || !findPaneInLayout(column.layout, action.paneId)) {
        return state
      }

      const sessionHistory =
        column.workspacePath.trim() !== ''
          ? archiveCardToHistory(state.sessionHistory, card, column.workspacePath)
          : state.sessionHistory

      const next = updateColumn({ ...state, sessionHistory }, action.columnId, (currentColumn) => {
        if (!findPaneInLayout(currentColumn.layout, action.paneId) || !currentColumn.cards[action.tabId]) {
          return currentColumn
        }

        const cards = { ...currentColumn.cards }
        delete cards[action.tabId]
        const layout = collapseLayout(
          updatePaneNode(currentColumn.layout, action.paneId, (pane) =>
            createPane(
              pane.tabs.filter((tabId) => tabId !== action.tabId),
              pane.activeTabId === action.tabId ? '' : pane.activeTabId,
              pane.id,
              pane.tabHistory,
            ),
          ),
        )

        return {
          ...currentColumn,
          cards,
          layout: normalizeLayoutNode(layout, cards),
        }
      })

      return touchState(clearPmLinksForCardId(next, action.tabId))
    }
    case 'moveTab': {
      const sourceColumn = state.columns.find((column) => column.id === action.sourceColumnId)
      const targetColumn = state.columns.find((column) => column.id === action.targetColumnId)
      const movingCard = sourceColumn?.cards[action.tabId]

      if (!sourceColumn || !targetColumn || !movingCard) {
        return state
      }

      // 症状：拖动标签后卡片整张消失（目标 paneId 过期）或同一张卡同时挂在两列（源 paneId 过期）。
      // 根因：2026-08-02 审计——搬运原本是两次独立的 updateColumn，各自带内部 findPaneInLayout 守卫；
      //   过期的一端只让其中一步静默跳过，另一步已经提交（删了没写 / 写了没删）。
      // 为什么不在第二步补救：删除已经发生，回滚要重建整列；照 splitMoveTab 的范式在动手前一次性校验两端更简单可靠。
      if (
        !findPaneInLayout(sourceColumn.layout, action.sourcePaneId) ||
        !findPaneInLayout(targetColumn.layout, action.targetPaneId)
      ) {
        return state
      }

      if (
        action.sourceColumnId === action.targetColumnId &&
        action.sourcePaneId === action.targetPaneId
      ) {
        const next = updateColumn(state, action.sourceColumnId, (column) => ({
          ...column,
          layout: updatePaneNode(column.layout, action.sourcePaneId, (pane) => {
            if (!pane.tabs.includes(action.tabId)) {
              return pane
            }

            const tabs = insertAt(pane.tabs, action.tabId, action.index)
            return createPane(
              tabs,
              pane.activeTabId === action.tabId ? action.tabId : pane.activeTabId,
              pane.id,
              pane.tabHistory,
            )
          }),
        }))

        return touchState(next)
      }

      if (action.sourceColumnId === action.targetColumnId) {
        // 症状：同列跨 pane 拖到刚 split 出来的空 pane，卡片变成不在任何 pane 里的孤儿（Known Pitfall 21）。
        // 根因：先删源再写目标的两步式里，第一步的 collapseLayout 会顺手删掉此刻仍为空的 targetPane，
        //   第二步的 findPaneInLayout 守卫必然落空，于是删除已提交、写入被跳过。
        // 为什么不是"折叠后二次确认再回滚"（splitMoveTab:1955 那种）：这里两个 pane 在同一棵 layout 里，
        //   先插入再统一折叠即可——目标 pane 此时已非空不会被折叠掉，正是 pitfall 21 要求的原子路径。
        const next = updateColumn(state, action.sourceColumnId, (column) => {
          const withTabInserted = updatePaneNode(column.layout, action.targetPaneId, (pane) =>
            createPane(insertAt(pane.tabs, action.tabId, action.index), action.tabId, pane.id, pane.tabHistory),
          )

          const layout = collapseLayout(
            updatePaneNode(withTabInserted, action.sourcePaneId, (pane) =>
              createPane(
                pane.tabs.filter((tabId) => tabId !== action.tabId),
                pane.activeTabId === action.tabId ? '' : pane.activeTabId,
                pane.id,
                pane.tabHistory,
              ),
            ),
          )

          return {
            ...column,
            layout: normalizeLayoutNode(layout, column.cards),
          }
        })

        return touchState(next)
      }

      let nextState = state

      nextState = updateColumn(nextState, action.sourceColumnId, (column) => {
        if (!column.cards[action.tabId]) {
          return column
        }

        const cards = { ...column.cards }
        delete cards[action.tabId]

        const layout = collapseLayout(
          updatePaneNode(column.layout, action.sourcePaneId, (pane) =>
            createPane(
              pane.tabs.filter((tabId) => tabId !== action.tabId),
              pane.activeTabId === action.tabId ? '' : pane.activeTabId,
              pane.id,
              pane.tabHistory,
            ),
          ),
        )

        return {
          ...column,
          cards,
          layout: normalizeLayoutNode(layout, cards),
        }
      })

      nextState = updateColumn(nextState, action.targetColumnId, (column) => {
        if (!findPaneInLayout(column.layout, action.targetPaneId)) {
          return column
        }

        const cards = {
          ...column.cards,
          [action.tabId]: rebindCardToColumn(state, column, movingCard),
        }

        return {
          ...column,
          cards,
          layout: updatePaneNode(column.layout, action.targetPaneId, (pane) =>
            createPane(insertAt(pane.tabs, action.tabId, action.index), action.tabId, pane.id, pane.tabHistory),
          ),
        }
      })

      return touchState(detachPmLinksForCardId(nextState, action.tabId))
    }
    case 'reorderTab': {
      const next = updateColumn(state, action.columnId, (column) => ({
        ...column,
        layout: updatePaneNode(column.layout, action.paneId, (pane) => {
          if (!pane.tabs.includes(action.tabId)) {
            return pane
          }

          const tabs = insertAt(pane.tabs, action.tabId, action.index)
          return createPane(
            tabs,
            pane.activeTabId === action.tabId ? action.tabId : pane.activeTabId,
            pane.id,
            pane.tabHistory,
          )
        }),
      }))

      return touchState(next)
    }
    case 'setActiveTab': {
      const targetColumn = state.columns.find((column) => column.id === action.columnId)
      if (!targetColumn) {
        return state
      }

      let alreadyActive = false
      updatePaneNode(targetColumn.layout, action.paneId, (pane) => {
        alreadyActive = pane.activeTabId === action.tabId || !pane.tabs.includes(action.tabId)
        return pane
      })

      if (alreadyActive) {
        return state
      }

      const next = updateColumn(state, action.columnId, (column) => ({
        ...column,
        layout: updatePaneNode(column.layout, action.paneId, (pane) =>
          createPane(pane.tabs, action.tabId, pane.id, pane.tabHistory),
        ),
      }))

      return touchState(next)
    }
    case 'resizePane': {
      const next = updateColumn(state, action.columnId, (column) => ({
        ...column,
        layout: updateSplitNode(column.layout, action.splitId, (split) =>
          createSplit(
            split.direction,
            split.children,
            normalizeSplitRatios(action.ratios, split.children.length),
            split.id,
          ),
        ),
      }))

      return touchState(next)
    }
    case 'setCardDraft': {
      const current = state.columns.find((column) => column.id === action.columnId)?.cards[action.cardId]
      if (!current || current.draft === action.draft) {
        return state
      }

      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          draft: action.draft,
        })),
      )
    }
    case 'clearStickyNoteArchive': {
      if (!(action.workspacePath in state.stickyNoteArchive)) {
        return state
      }

      const stickyNoteArchive = { ...state.stickyNoteArchive }
      delete stickyNoteArchive[action.workspacePath]
      return touchState({ ...state, stickyNoteArchive })
    }
    case 'updateStickyNoteViewState': {
      const stickyNoteArchive = updateStickyNoteArchiveViewState(
        state.stickyNoteArchive,
        action.workspacePath,
        action.viewState,
      )
      return stickyNoteArchive === state.stickyNoteArchive
        ? state
        : touchState({ ...state, stickyNoteArchive })
    }
    case 'appendMessages':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          messages: appendUniqueCardMessages(card.messages, action.messages),
        })),
      )
    case 'upsertMessages':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          messages: upsertCardMessages(card.messages, action.messages),
        })),
      )
    case 'resetCardConversation': {
      const resetColumn = state.columns.find((column) => column.id === action.columnId)
      const resetCard = resetColumn?.cards[action.cardId]
      const sessionHistory =
        resetCard && resetColumn?.workspacePath
          ? archiveCardToHistory(state.sessionHistory, resetCard, resetColumn.workspacePath)
          : state.sessionHistory

      const next = updateCard({ ...state, sessionHistory }, action.columnId, action.cardId, (card) => ({
        ...card,
        title: action.title ?? '',
        status: 'idle',
        sessionId: undefined,
        sessionModel: undefined,
        providerSessions: {},
        contextTransfer: undefined,
        streamId: undefined,
        backgroundWorkPending: false,
        autoUrgeActive: false,
        repeatLoopActive: false,
        repeatLoopRemaining: undefined,
        unread: false,
        draft: '',
        queuedSends: [],
        wakeTimerActive: false,
        wakeTimerQueuedSends: [],
        wakeTimerArmedAt: undefined,
        wakeTimerWakeAt: undefined,
        wakeTimerPendingTargetIds: [],
        messages: [],
        messageCount: 0,
      }))

      return touchState(next)
    }
    case 'selectCardModel':
      return touchState(selectCardModel(state, action.columnId, action.cardId, action.provider, action.model))
    case 'updateCard': {
      const current = state.columns.find((column) => column.id === action.columnId)?.cards[action.cardId]
      if (!current) {
        return state
      }

      const changed = Object.entries(action.patch).some(([key, value]) =>
        !Object.is(current[key as keyof ChatCard], value),
      )
      if (!changed) {
        return state
      }

      const next = touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          ...action.patch,
        })),
      )

      // Sticky note edits also refresh the per-workspace archive so the note
      // survives closing the card or the whole workspace column. Editor tool
      // cards reuse `stickyNote` as a file path and must not be archived.
      if (
        typeof action.patch.stickyNote === 'string' &&
        current.model === STICKYNOTE_TOOL_MODEL &&
        !current.stickyNoteId?.trim()
      ) {
        const workspacePath =
          state.columns.find((column) => column.id === action.columnId)?.workspacePath ?? ''
        const archive = upsertStickyNoteArchiveEntry(
          next.stickyNoteArchive,
          workspacePath,
          action.patch.stickyNote,
        )
        if (archive !== next.stickyNoteArchive) {
          return { ...next, stickyNoteArchive: archive }
        }
      }

      return next
    }
    case 'appendAssistantDelta':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => {
          const last = card.messages[card.messages.length - 1]
          if (last && last.id === action.messageId) {
            const nextMeta = action.model?.trim()
              ? { ...(last.meta ?? {}), model: action.model.trim() }
              : last.meta
            return {
              ...card,
              messages: [
                ...card.messages.slice(0, -1),
                { ...last, content: `${last.content}${action.delta}`, meta: nextMeta },
              ],
            }
          }

          return {
            ...card,
            messages: card.messages.map((message) =>
              message.id === action.messageId
                ? {
                    ...message,
                    content: `${message.content}${action.delta}`,
                    meta: action.model?.trim()
                      ? { ...(message.meta ?? {}), model: action.model.trim() }
                      : message.meta,
                  }
                : message,
            ),
          }
        }),
      )
    case 'finishStoppedStream':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => {
          const settledMessages = settleStoppedStreamMessages(card.messages)
          const stopReason = action.stoppedMessage?.meta?.kind === 'run-stopped'
            ? action.stoppedMessage.meta.stopReason
            : undefined
          const shouldCancelAutoUrge =
            stopReason === 'manual' || stopReason === 'user-interrupt'
          const shouldResetInterruptedSession = stopReason === 'user-interrupt'
          const nextProviderSessions = shouldResetInterruptedSession
            ? { ...card.providerSessions }
            : card.providerSessions

          if (shouldResetInterruptedSession) {
            delete nextProviderSessions[card.provider]
          }

          return {
            ...card,
            status: 'idle',
            streamId: undefined,
            sessionId: shouldResetInterruptedSession ? undefined : card.sessionId,
            sessionModel: shouldResetInterruptedSession ? undefined : card.sessionModel,
            providerSessions: nextProviderSessions,
            autoUrgeActive: shouldCancelAutoUrge ? false : card.autoUrgeActive,
            completionGlow: false,
            backgroundWorkPending: false,
            unread: action.unread ?? card.unread,
            messages: action.stoppedMessage
              ? [...settledMessages, action.stoppedMessage]
              : settledMessages,
          }
        }),
      )
    case 'settleStreamActivities':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          messages: settleStoppedStreamMessages(card.messages),
        })),
      )
    case 'recordRecentWorkspace': {
      const path = action.path.trim()
      if (!path) {
        return state
      }

      const now = new Date().toISOString()
      const existing = state.settings.recentWorkspaces.filter(
        (workspace) => workspace.path.toLowerCase() !== path.toLowerCase(),
      )
      const recentWorkspaces = [{ path, openedAt: now }, ...existing].slice(0, maxRecentWorkspaces)

      return touchState({
        ...state,
        settings: { ...state.settings, recentWorkspaces },
      })
    }
    case 'removeRecentWorkspaces': {
      const lower = new Set(action.paths.map((path) => path.toLowerCase()))
      const recentWorkspaces = state.settings.recentWorkspaces.filter(
        (workspace) => !lower.has(workspace.path.toLowerCase()),
      )

      return touchState({
        ...state,
        settings: { ...state.settings, recentWorkspaces },
      })
    }
    case 'restoreSession': {
      const entry = state.sessionHistory.find((item) => item.id === action.entryId)
      if (!entry) {
        return state
      }

      const next = restoreSessionEntryToColumn(state, action.columnId, entry, action.paneId)

      return touchState({
        ...next,
        sessionHistory: next.sessionHistory.filter((item) => item.id !== action.entryId),
      })
    }
    case 'restoreSessionEntries': {
      const entryIds = new Set(action.entryIds)
      const entriesToRestore = state.sessionHistory
        .filter((entry) => entryIds.has(entry.id))
        .slice()
        .reverse()

      if (entriesToRestore.length === 0) {
        return state
      }

      let nextState = state

      for (const entry of entriesToRestore) {
        const columnId = findBestRestoreColumnId(nextState, entry)
        if (!columnId) {
          continue
        }

        nextState = restoreSessionEntryToColumn(nextState, columnId, entry)
      }

      return touchState({
        ...nextState,
        sessionHistory: nextState.sessionHistory.filter((entry) => !entryIds.has(entry.id)),
      })
    }
    case 'removeSessionHistory': {
      const idsToRemove = new Set(action.entryIds)
      return touchState({
        ...state,
        sessionHistory: state.sessionHistory.filter((entry) => !idsToRemove.has(entry.id)),
      })
    }
    case 'importExternalSession': {
      const importedCard: ChatCard = {
        id: createId(),
        title: action.entry.title,
        sessionId: action.entry.sessionId,
        sessionModel: action.entry.sessionModel,
        providerSessions: {},
        streamId: undefined,
        status: 'idle',
        provider: action.entry.provider,
        model: action.entry.model,
        reasoningEffort: getPreferredReasoningEffort(
          state.settings,
          action.entry.provider,
          action.entry.model,
        ),
        thinkingEnabled: true,
        planMode: false,
        autoUrgeActive: false,
        autoUrgeProfileId: defaultAutoUrgeProfileId,
        repeatLoopActive: false,
        repeatLoopRemaining: undefined,
        collapsed: false,
        unread: false,
  draft: '',
  draftAttachments: [],
  queuedSends: [],
  wakeTimerActive: false,
  wakeTimerMode: 'workspace-agents',
  wakeTimerDurationMinutes: 30,
  wakeTimerQueuedSends: [],
  wakeTimerPendingTargetIds: [],
  stickyNote: '',
        brainstorm: createDefaultBrainstormState(),
        pm: createDefaultPmState(),
        pmTaskCardId: '',
        pmOwnerCardId: '',
        messages: action.entry.messages,
      }

      const next = insertCardIntoColumn(state, action.columnId, importedCard, action.paneId)

      return touchState({
        ...next,
        sessionHistory: [action.entry, ...next.sessionHistory],
      })
    }
    case 'forkConversation': {
      const column = state.columns.find((c) => c.id === action.columnId)
      if (!column) return state

      const sourceCard = column.cards[action.cardId]
      if (!sourceCard) return state

      const forkPoint = resolveForkPointMessage(sourceCard.messages, action.messageId)
      if (!forkPoint) return state

      const { messageIndex, message: forkPointMessage } = forkPoint
      // Messages BEFORE the fork point —the selected user prompt is restored into the composer instead.
      const forkedMessages = sourceCard.messages.slice(0, messageIndex)
      const forkedDraft = forkPointMessage.content
      const forkedDraftAttachments = getChatMessageAttachments(forkPointMessage)
      const language = state.settings.language

      const forkedSessionId = action.forkedSessionId?.trim() || undefined
      const forkedCard: ChatCard = {
        id: createId(),
        title: getForkConversationTitle(language, sourceCard.title),
        sessionId: forkedSessionId,
        // A natively forked session carries the source model's context, so the
        // resume guard (pitfall 47) must keep the same session model tag.
        sessionModel: forkedSessionId ? sourceCard.sessionModel : undefined,
        providerSessions: {},
        streamId: undefined,
        status: 'idle',
        provider: sourceCard.provider,
        model: sourceCard.model,
        reasoningEffort: sourceCard.reasoningEffort,
        thinkingEnabled: sourceCard.thinkingEnabled,
        planMode: false,
        autoUrgeActive: false,
        autoUrgeProfileId: sourceCard.autoUrgeProfileId,
        repeatLoopActive: false,
        collapsed: false,
        unread: false,
        draft: forkedDraft,
        draftAttachments: forkedDraftAttachments,
        queuedSends: [],
        wakeTimerActive: false,
        wakeTimerMode: sourceCard.wakeTimerMode ?? 'workspace-agents',
        wakeTimerDurationMinutes: sourceCard.wakeTimerDurationMinutes ?? 30,
        wakeTimerQueuedSends: [],
        wakeTimerPendingTargetIds: [],
        stickyNote: '',
        brainstorm: createDefaultBrainstormState(),
        pm: sourceCard.pm ? { ...sourceCard.pm } : createDefaultPmState(),
        pmTaskCardId: '',
        pmOwnerCardId: '',
        messages: forkedMessages,
      }

      const pane = findPaneForTab(column.layout, action.cardId)
      if (!pane) return state

      return touchState(
        updateColumn(state, action.columnId, (col) => ({
          ...col,
          cards: { ...col.cards, [forkedCard.id]: forkedCard },
          layout: updatePaneNode(col.layout, pane.id, (p) =>
            createPane([...p.tabs, forkedCard.id], forkedCard.id, p.id, p.tabHistory),
          ),
        })),
      )
    }
    case 'createAutomationBoardItem': {
      const column = state.columns.find((entry) => entry.id === action.columnId)
      const boardCard = getAutomationBoardCard(column, action.boardCardId)

      if (!column || !boardCard) {
        return state
      }

      const requirement = action.requirement.slice(0, automationBoardRequirementMaxChars)
      const provider = action.provider ?? column.provider
      const itemCard: ChatCard = {
        ...createAutomationBoardItemCard({
          requirement,
          provider,
          model: normalizeStoredModel(provider, action.model ?? column.model) || getDefaultModel(provider),
          reasoningEffort: action.reasoningEffort,
          thinkingEnabled: action.thinkingEnabled,
          planMode: action.planMode,
          language: state.settings.language,
        }),
        ...(action.cardId ? { id: action.cardId } : {}),
        ...(action.wakeTimerActive !== undefined ? { wakeTimerActive: action.wakeTimerActive } : {}),
        ...(action.wakeTimerMode ? { wakeTimerMode: action.wakeTimerMode } : {}),
        ...(typeof action.wakeTimerDurationMinutes === 'number'
          ? { wakeTimerDurationMinutes: action.wakeTimerDurationMinutes }
          : {}),
        ...(action.repeatLoopActive !== undefined ? { repeatLoopActive: action.repeatLoopActive } : {}),
        ...(typeof action.repeatLoopRemaining === 'number'
          ? { repeatLoopRemaining: action.repeatLoopRemaining }
          : {}),
      }

      // 卡片进 column.cards 但绝不进 pane.tabs —— 那正是"看板项"的定义。
      return touchState(
        updateColumn(state, action.columnId, (current) => ({
          ...current,
          cards: {
            ...current.cards,
            [itemCard.id]: itemCard,
            [action.boardCardId]: {
              ...current.cards[action.boardCardId]!,
              automationBoard: {
                ...boardCard.automationBoard!,
                items: placeAutomationBoardItem(
                  boardCard.automationBoard!.items,
                  {
                    cardId: itemCard.id,
                    lane: action.lane,
                    requirement,
                    createdAt: new Date().toISOString(),
                  },
                  action.index,
                ),
              },
            },
          },
        })),
      )
    }
    case 'setAutomationBoardItemLane': {
      return updateAutomationBoard(state, action.columnId, action.boardCardId, (board) => {
        const existing = board.items.find((item) => item.cardId === action.cardId)
        if (!existing) {
          return null
        }

        return {
          ...board,
          items: placeAutomationBoardItem(
            board.items,
            { ...existing, lane: action.lane },
            action.index,
          ),
        }
      })
    }
    case 'stampAutomationBoardItem': {
      return updateAutomationBoard(state, action.columnId, action.boardCardId, (board) => {
        if (!board.items.some((item) => item.cardId === action.cardId)) {
          return null
        }

        return {
          ...board,
          items: board.items.map((item) =>
            item.cardId === action.cardId
              ? {
                  ...item,
                  ...(action.patch.requirement !== undefined
                    ? { requirement: action.patch.requirement.slice(0, automationBoardRequirementMaxChars) }
                    : {}),
                  ...(action.patch.startedAt !== undefined ? { startedAt: action.patch.startedAt } : {}),
                  ...(action.patch.completedAt !== undefined
                    ? { completedAt: action.patch.completedAt }
                    : {}),
                }
              : item,
          ),
        }
      })
    }
    case 'setAutomationBoardSupervisorExpanded': {
      return updateAutomationBoard(state, action.columnId, action.boardCardId, (board) =>
        board.supervisorExpanded === action.expanded
          ? null
          : { ...board, supervisorExpanded: action.expanded },
      )
    }
    case 'removeAutomationBoardItem': {
      const column = state.columns.find((entry) => entry.id === action.columnId)
      const boardCard = getAutomationBoardCard(column, action.boardCardId)

      if (!column || !boardCard || !boardCard.automationBoard!.items.some((item) => item.cardId === action.cardId)) {
        return state
      }

      return touchState(
        updateColumn(state, action.columnId, (current) => {
          const cards = { ...current.cards }
          if (action.deleteCard) {
            delete cards[action.cardId]
          }

          cards[action.boardCardId] = {
            ...current.cards[action.boardCardId]!,
            automationBoard: {
              ...boardCard.automationBoard!,
              items: boardCard.automationBoard!.items.filter((item) => item.cardId !== action.cardId),
            },
          }

          return { ...current, cards }
        }),
      )
    }
    case 'moveAutomationBoardItemToPane': {
      const column = state.columns.find((entry) => entry.id === action.columnId)
      const boardCard = getAutomationBoardCard(column, action.boardCardId)
      const board = boardCard?.automationBoard

      // pitfall 237：多步搬运必须在动手前一次性校验两端，否则过期的一端会让
      // "摘除已提交 / 插入被跳过"落地，卡片变成不在任何容器里的孤儿。
      if (
        !column ||
        !board ||
        !column.cards[action.cardId] ||
        !board.items.some((item) => item.cardId === action.cardId) ||
        !findPaneInLayout(column.layout, action.paneId)
      ) {
        return state
      }

      // 刻意不归档进 sessionHistory：卡片没有被关闭，只是换了展现容器。
      return touchState(
        updateColumn(state, action.columnId, (current) => ({
          ...current,
          cards: {
            ...current.cards,
            [action.boardCardId]: {
              ...current.cards[action.boardCardId]!,
              automationBoard: {
                ...board,
                items: board.items.filter((item) => item.cardId !== action.cardId),
              },
            },
          },
          layout: updatePaneNode(current.layout, action.paneId, (pane) =>
            createPane(
              insertAt(pane.tabs, action.cardId, action.index),
              action.cardId,
              pane.id,
              pane.tabHistory,
            ),
          ),
        })),
      )
    }
    case 'moveTabToAutomationBoard': {
      const column = state.columns.find((entry) => entry.id === action.columnId)
      const boardCard = getAutomationBoardCard(column, action.boardCardId)
      const board = boardCard?.automationBoard
      const movingCard = column?.cards[action.tabId]
      const sourcePane = column ? findPaneInLayout(column.layout, action.paneId) : undefined

      if (
        !column ||
        !board ||
        !movingCard ||
        !sourcePane ||
        !sourcePane.tabs.includes(action.tabId) ||
        // 看板不能吞掉自己，也不能吞掉另一张看板卡（会造成拥有关系成环）。
        action.tabId === action.boardCardId ||
        movingCard.model === AUTOMATIONBOARD_TOOL_MODEL
      ) {
        return state
      }

      const requirement = resolveAutomationBoardRequirementFromCard(movingCard)

      return touchState(
        updateColumn(state, action.columnId, (current) => {
          const layout = collapseLayout(
            updatePaneNode(current.layout, action.paneId, (pane) =>
              createPane(
                pane.tabs.filter((tabId) => tabId !== action.tabId),
                pane.activeTabId === action.tabId ? '' : pane.activeTabId,
                pane.id,
                pane.tabHistory,
              ),
            ),
          )

          const cards = {
            ...current.cards,
            [action.boardCardId]: {
              ...current.cards[action.boardCardId]!,
              automationBoard: {
                ...board,
                items: placeAutomationBoardItem(
                  board.items,
                  {
                    cardId: action.tabId,
                    lane: action.lane,
                    requirement,
                    createdAt: new Date().toISOString(),
                  },
                  action.index,
                ),
              },
            },
          }

          return { ...current, cards, layout: normalizeLayoutNode(layout, cards) }
        }),
      )
    }
    case 'ensureAutomationBoardSupervisor': {
      const column = state.columns.find((entry) => entry.id === action.columnId)
      const boardCard = getAutomationBoardCard(column, action.boardCardId)
      const board = boardCard?.automationBoard

      if (!column || !board) {
        return state
      }

      const existing = board.supervisorCardId ? column.cards[board.supervisorCardId] : undefined
      const model = normalizeStoredModel(action.provider, action.model) || getDefaultModel(action.provider)

      if (existing) {
        // 监工已经存在：只把它重新指向当前配置的模型，绝不换卡（换卡就丢上下文）。
        if (existing.provider === action.provider && existing.model === model) {
          return state
        }

        return touchState(
          updateColumn(state, action.columnId, (current) => ({
            ...current,
            cards: {
              ...current.cards,
              [existing.id]: {
                ...current.cards[existing.id]!,
                provider: action.provider,
                model,
                reasoningEffort: action.reasoningEffort,
                // 换模型作废原生会话：与 selectCardModel 同一条规矩。
                sessionId: undefined,
                sessionModel: undefined,
              },
            },
          })),
        )
      }

      const supervisorCard: ChatCard = {
        ...createAutomationBoardSupervisorCard({
          provider: action.provider,
          model,
          reasoningEffort: action.reasoningEffort,
          language: state.settings.language,
        }),
        ...(action.cardId ? { id: action.cardId } : {}),
      }

      return touchState(
        updateColumn(state, action.columnId, (current) => ({
          ...current,
          cards: {
            ...current.cards,
            [supervisorCard.id]: supervisorCard,
            [action.boardCardId]: {
              ...current.cards[action.boardCardId]!,
              automationBoard: { ...board, supervisorCardId: supervisorCard.id },
            },
          },
        })),
      )
    }
    case 'saveAutomationBoardTemplate': {
      return withAutomationBoardWorkspaceState(state, action.workspacePath, (current) => {
        const rest = current.templates.filter((template) => template.id !== action.template.id)
        const existingIndex = current.templates.findIndex(
          (template) => template.id === action.template.id,
        )

        if (existingIndex < 0) {
          return { ...current, templates: [...rest, action.template] }
        }

        const templates = [...rest]
        templates.splice(existingIndex, 0, action.template)
        return { ...current, templates }
      })
    }
    case 'removeAutomationBoardTemplate': {
      return withAutomationBoardWorkspaceState(state, action.workspacePath, (current) => ({
        ...current,
        templates: current.templates.filter((template) => template.id !== action.templateId),
      }))
    }
    case 'renameAutomationBoardTemplate': {
      return withAutomationBoardWorkspaceState(state, action.workspacePath, (current) => ({
        ...current,
        templates: current.templates.map((template) =>
          template.id === action.templateId ? { ...template, name: action.name.trim() } : template,
        ),
      }))
    }
    case 'updateAutomationBoardAutoTrigger': {
      return withAutomationBoardWorkspaceState(state, action.workspacePath, (current) => ({
        ...current,
        autoTrigger: { ...current.autoTrigger, ...action.patch },
      }))
    }
    default:
      return state
  }
}
