import {
  archiveCardToHistory,
  createCard,
  createId,
  createColumn,
  createDefaultPmState,
  createPane,
  createSplit,
  defaultProviderByIndex,
  getConfiguredModel,
  getFirstPane,
  getPreferredReasoningEffort,
  maxRecentWorkspaces,
  normalizeAppSettings,
  normalizeColumnWidth,
  normalizeLayoutNode,
  normalizeSplitRatios,
  rememberModelReasoningEffort,
  resetCardSessions,
  touchState,
} from '../shared/default-state'
import { createDefaultBrainstormState } from '../shared/brainstorm'
import { getDuplicateColumnTitle, getForkConversationTitle, getWorkspaceTitle } from '../shared/i18n'
import {
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  normalizeStoredModel,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
} from '../shared/models'
import type {
  AppSettings,
  AppState,
  BoardColumn,
  ChatCard,
  ChatMessage,
  LayoutNode,
  PaneNode,
  Provider,
  ProviderProfile,
  RequestModelSettings,
  SessionHistoryEntry,
  SplitNode,
} from '../shared/schema'
import { defaultAutoUrgeProfileId } from '../shared/schema'

type Placement = 'before' | 'after'

const toolCardModels = new Set([
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
])

const isUntouchedEmptyChatCard = (card: ChatCard) =>
  card.status === 'idle' &&
  card.messages.length === 0 &&
  !card.draft.trim() &&
  !card.sessionId &&
  !card.streamId

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
          | 'activeTopTab'
          | 'uiScale'
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
          | 'pmCardEnabled'
          | 'brainstormCardEnabled'
          | 'experimentalMusicEnabled'
          | 'experimentalWhiteNoiseEnabled'
          | 'experimentalWeatherEnabled'
          | 'agentDoneSoundEnabled'
          | 'agentDoneSoundVolume'
          | 'autoUrgeEnabled'
          | 'autoUrgeProfiles'
          | 'autoUrgeActiveProfileId'
          | 'autoUrgeMessage'
          | 'autoUrgeSuccessKeyword'
          | 'weatherCity'
          | 'systemPrompt'
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
  | { type: 'removeColumn'; columnId: string }
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
  | { type: 'appendMessages'; columnId: string; cardId: string; messages: ChatMessage[] }
  | { type: 'upsertMessages'; columnId: string; cardId: string; messages: ChatMessage[] }
  | { type: 'resetCardConversation'; columnId: string; cardId: string; title?: string }
  | { type: 'forkConversation'; columnId: string; cardId: string; messageId: string }
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
          | 'providerSessions'
          | 'streamId'
          | 'provider'
          | 'model'
          | 'reasoningEffort'
          | 'thinkingEnabled'
          | 'planMode'
          | 'autoUrgeActive'
          | 'autoUrgeProfileId'
          | 'collapsed'
          | 'unread'
          | 'stickyNote'
          | 'messages'
          | 'brainstorm'
        >
      >
    }
  | {
      type: 'appendAssistantDelta'
      columnId: string
      cardId: string
      messageId: string
      delta: string
    }
  | { type: 'recordRecentWorkspace'; path: string }
  | { type: 'removeRecentWorkspaces'; paths: string[] }
  | { type: 'restoreSession'; columnId: string; entryId: string; paneId?: string }
  | { type: 'restoreSessionEntries'; entryIds: string[] }
  | { type: 'removeSessionHistory'; entryIds: string[] }
  | { type: 'importExternalSession'; columnId: string; paneId?: string; entry: SessionHistoryEntry }

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

const duplicateChatMessage = (message: ChatMessage): ChatMessage => ({
  ...message,
  meta: message.meta ? { ...message.meta } : undefined,
})

const duplicateCardForColumn = (card: ChatCard): ChatCard => ({
  ...card,
  id: createId(),
  sessionId: undefined,
  providerSessions: {},
  streamId: undefined,
  status: 'idle',
  pm: card.pm ? { ...card.pm } : createDefaultPmState(),
  pmTaskCardId: '',
  pmOwnerCardId: '',
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

const getPaneAxisSpan = (
  layout: LayoutNode,
  paneId: string,
  direction: SplitNode['direction'],
) => {
  const bounds = collectPaneBounds(layout).find(({ pane }) => pane.id === paneId)
  if (!bounds) {
    return null
  }

  return direction === 'horizontal' ? bounds.width : bounds.height
}

const getInheritedSplitRatios = (
  sourceLayout: LayoutNode,
  sourcePaneId: string,
  targetLayout: LayoutNode,
  targetPaneId: string,
  direction: SplitNode['direction'],
  placement: Placement | undefined,
) => {
  const sourceSpan = getPaneAxisSpan(sourceLayout, sourcePaneId, direction)
  const targetSpan = getPaneAxisSpan(targetLayout, targetPaneId, direction)

  if (sourceSpan === null || targetSpan === null || sourceSpan <= 0 || targetSpan <= 0) {
    return [0.5, 0.5]
  }

  const safeTargetSpan = Math.max(targetSpan, Number.EPSILON * 2)
  const newPaneSpan = Math.min(Math.max(sourceSpan, Number.EPSILON), safeTargetSpan - Number.EPSILON)
  const currentPaneSpan = Math.max(safeTargetSpan - newPaneSpan, Number.EPSILON)

  return placement === 'before'
    ? normalizeSplitRatios([newPaneSpan, currentPaneSpan], 2)
    : normalizeSplitRatios([currentPaneSpan, newPaneSpan], 2)
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

  return {
    ...next,
    columns: next.columns.map((column) => {
      const providerWasUpdated = updatedProviders.includes(column.provider)
      const previousConfiguredModel = state.settings.requestModels[column.provider]
      const nextConfiguredModel = next.settings.requestModels[column.provider]
      const shouldUpdateColumnModel =
        providerWasUpdated && (column.model.trim().length === 0 || column.model === previousConfiguredModel)

      return {
        ...column,
        model: shouldUpdateColumnModel ? nextConfiguredModel : column.model,
        cards: Object.fromEntries(
          Object.entries(column.cards).map(([cardId, card]) => {
            if (toolCardModels.has(card.model) || !updatedProviders.includes(card.provider)) {
              return [cardId, card]
            }

            const previousCardConfiguredModel = state.settings.requestModels[card.provider]
            const nextCardConfiguredModel = next.settings.requestModels[card.provider]
            const shouldUpdateCardModel =
              card.model === previousCardConfiguredModel && isUntouchedEmptyChatCard(card)

            if (shouldUpdateCardModel) {
              return [
                cardId,
                {
                  ...card,
                  model: nextCardConfiguredModel,
                  reasoningEffort: getPreferredReasoningEffort(next.settings, card.provider, nextCardConfiguredModel),
                },
              ]
            }

            if (card.model.trim().length > 0) {
              return [cardId, card]
            }

            return [
              cardId,
              {
                ...card,
                reasoningEffort: getPreferredReasoningEffort(next.settings, card.provider, card.model),
              },
            ]
          }),
        ),
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

  let sessionPatch: Pick<Partial<ChatCard>, 'sessionId' | 'providerSessions'> = {}
  if (providerChanged) {
    const savedSessions = { ...card.providerSessions }
    if (card.sessionId) {
      savedSessions[card.provider] = card.sessionId
    }
    const restoredSessionId = savedSessions[provider]
    delete savedSessions[provider]
    sessionPatch = {
      sessionId: restoredSessionId,
      providerSessions: savedSessions,
    }
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
          pmTaskCardId: '',
          pmOwnerCardId: '',
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
  collapsed: false,
  unread: false,
  draft: '',
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

export const ideReducer = (state: AppState, action: IdeAction): AppState => {
  switch (action.type) {
    case 'replace':
      return action.state
    case 'addColumn': {
      const lastColumn = state.columns.at(-1)
      const provider = lastColumn?.provider ?? defaultProviderByIndex(state.columns.length)
      const language = state.settings.language
      const remembered = state.settings.lastModel?.provider === provider ? state.settings.lastModel : undefined
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
    case 'updateSettings':
      return touchState(mergeSettings(state, action.patch))
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
    case 'upsertProviderProfile':
      return touchState(
        updateProviderProfileCollection(state, action.provider, (collection) => {
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
        }),
      )
    case 'removeProviderProfile':
      return touchState(
        updateProviderProfileCollection(state, action.provider, (collection) => {
          const profiles = collection.profiles.filter((profile) => profile.id !== action.profileId)
          return {
            activeProfileId:
              collection.activeProfileId === action.profileId ? (profiles[0]?.id ?? '') : collection.activeProfileId,
            profiles,
          }
        }),
      )
    case 'setActiveProviderProfile':
      return touchState(
        updateProviderProfileCollection(state, action.provider, (collection) => ({
          activeProfileId:
            action.profileId && collection.profiles.some((profile) => profile.id === action.profileId)
              ? action.profileId
              : '',
          profiles: collection.profiles,
        })),
      )
    case 'applyConfiguredModels':
      return touchState(applyConfiguredModels(state))
    case 'updateColumn': {
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

      return touchState(next)
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
    case 'removeColumn':
      return touchState({
        ...state,
        columns: redistributeWidthsAfterColumnRemoval(state.columns, action.columnId),
      })
    case 'addTab': {
      const next = updateColumn(state, action.columnId, (column) => {
        const pane = findPaneInLayout(column.layout, action.paneId)
        if (!pane) {
          return column
        }

        const activeCardId = pane.activeTabId || pane.tabs[0] || ''
        const activeCard = column.cards[activeCardId]
        const activeChatProvider =
          activeCard && !toolCardModels.has(activeCard.model) ? activeCard.provider : undefined
        const hasExplicitProvider = action.provider !== undefined
        const hasExplicitModel = action.model !== undefined
        const provider = toolCardModels.has(action.model ?? '')
          ? 'codex'
          : (action.provider ?? activeChatProvider ?? column.provider)
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
          activeCard &&
          !toolCardModels.has(activeCard.model) &&
          activeCard.provider === provider
            ? normalizeStoredModel(provider, activeCard.model) || undefined
            : undefined
        const rememberedGlobalModel =
          !hasExplicitProvider && !hasExplicitModel && state.settings.lastModel?.provider === provider
            ? state.settings.lastModel.model
            : undefined
        const model =
          action.model ??
          rememberedColumnModel ??
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

        const inheritedRatios = getInheritedSplitRatios(
          column.layout,
          action.sourcePaneId,
          layout,
          action.targetPaneId,
          action.direction,
          action.placement,
        )
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
          inheritedRatios,
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
      if (!column || !card) {
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

      let nextState = state

      nextState = updateColumn(nextState, action.sourceColumnId, (column) => {
        if (!findPaneInLayout(column.layout, action.sourcePaneId) || !column.cards[action.tabId]) {
          return column
        }

        const cards = action.sourceColumnId === action.targetColumnId ? column.cards : { ...column.cards }
        if (action.sourceColumnId !== action.targetColumnId) {
          delete cards[action.tabId]
        }

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

        const cards =
          action.sourceColumnId === action.targetColumnId
            ? column.cards
            : {
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

      const detachedState =
        action.sourceColumnId !== action.targetColumnId
          ? detachPmLinksForCardId(nextState, action.tabId)
          : nextState

      return touchState(detachedState)
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
    case 'appendMessages':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          messages: [...card.messages, ...action.messages],
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
        providerSessions: {},
        streamId: undefined,
        autoUrgeActive: false,
        unread: false,
        draft: '',
        messages: [],
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

      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => ({
          ...card,
          ...action.patch,
        })),
      )
    }
    case 'appendAssistantDelta':
      return touchState(
        updateCard(state, action.columnId, action.cardId, (card) => {
          const last = card.messages[card.messages.length - 1]
          if (last && last.id === action.messageId) {
            return {
              ...card,
              messages: [
                ...card.messages.slice(0, -1),
                { ...last, content: `${last.content}${action.delta}` },
              ],
            }
          }

          return {
            ...card,
            messages: card.messages.map((message) =>
              message.id === action.messageId
                ? { ...message, content: `${message.content}${action.delta}` }
                : message,
            ),
          }
        }),
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
        collapsed: false,
        unread: false,
        draft: '',
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

      const selectedMessageIndex = sourceCard.messages.findIndex((message) => message.id === action.messageId)
      if (selectedMessageIndex < 0) return state

      const messageIndex =
        sourceCard.messages[selectedMessageIndex]?.role === 'user'
          ? selectedMessageIndex
          : sourceCard.messages
              .slice(0, selectedMessageIndex)
              .map((message, index) => ({ message, index }))
              .reverse()
              .find(({ message }) => message.role === 'user')?.index ?? -1
      if (messageIndex < 0) return state

      const forkedMessages = sourceCard.messages.slice(0, messageIndex + 1)
      const language = state.settings.language

      const forkedCard: ChatCard = {
        id: createId(),
        title: getForkConversationTitle(language, sourceCard.title),
        sessionId: undefined,
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
        collapsed: false,
        unread: false,
        draft: '',
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
    default:
      return state
  }
}
