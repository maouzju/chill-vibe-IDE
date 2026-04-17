import assert from 'node:assert/strict'
import test from 'node:test'

import { createCard, createColumn, createDefaultState, createPane, createSplit } from '../shared/default-state.ts'
import { arePaneViewPropsEqual, areWorkspaceColumnPropsEqual } from '../src/components/layout-memoization.ts'

const createWorkspaceColumnComparatorProps = () => {
  const state = createDefaultState('d:\\Git\\chill-vibe', 'en')
  const column = state.columns[0]!

  return {
    column,
    providers: {
      codex: { provider: 'codex' as const, available: true, command: 'codex' },
      claude: { provider: 'claude' as const, available: true, command: 'claude' },
    },
    language: 'en' as const,
    systemPrompt: '',
    crossProviderSkillReuseEnabled: true,
    musicAlbumCoverEnabled: true,
    weatherCity: '',
    gitAgentModel: 'gpt-5.4',
    brainstormRequestModel: 'gpt-5.4',
    availableQuickToolModels: [],
    autoUrgeEnabled: false,
    autoUrgeProfiles: [],
    autoUrgeMessage: '',
    autoUrgeSuccessKeyword: '',
    workspaceCards: Object.values(column.cards),
    onChangeColumn: () => undefined,
    onChangeCardModel: () => undefined,
    onChangeCardReasoningEffort: () => undefined,
    onToggleCardPlanMode: () => undefined,
    onToggleCardThinking: () => undefined,
    onToggleCardCollapsed: () => undefined,
    onMarkCardRead: () => undefined,
    onChangeCardDraft: () => undefined,
    onChangeCardStickyNote: () => undefined,
    onPatchCard: () => undefined,
    onChangeCardTitle: () => undefined,
    onReorderColumn: () => undefined,
    onRemoveColumn: () => undefined,
    onResizeColumn: () => undefined,
    onAddTab: () => undefined,
    onSplitPane: () => undefined,
    onSplitMoveTab: () => undefined,
    onCloseTab: () => undefined,
    onMoveTab: () => undefined,
    onReorderTab: () => undefined,
    onSetActiveTab: () => undefined,
    onResizePane: () => undefined,
    onActivatePane: () => undefined,
    onSendMessage: async () => undefined,
    onStopMessage: async () => undefined,
    recentWorkspaces: [],
    onRecordRecentWorkspace: () => undefined,
    onRemoveRecentWorkspaces: () => undefined,
    sessionHistory: [],
    onRestoreSession: () => undefined,
    onImportExternalSession: () => undefined,
  }
}

const createPaneComparatorProps = () => {
  const leftCard = createCard('Left Chat', 420, 'codex', 'gpt-5.4', 'medium', 'en')
  const rightCard = createCard('Right Chat', 420, 'codex', 'gpt-5.4', 'medium', 'en')
  const leftPane = createPane([leftCard.id], leftCard.id, 'pane-left')
  const rightPane = createPane([rightCard.id], rightCard.id, 'pane-right')
  const column = createColumn(
    {
      title: 'Memo Test',
      provider: 'codex',
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      cards: {
        [leftCard.id]: leftCard,
        [rightCard.id]: rightCard,
      },
      layout: createSplit('horizontal', [leftPane, rightPane], [0.5, 0.5], 'split-root'),
    },
    'en',
  )

  return {
    column,
    pane: leftPane,
    providers: {
      codex: { provider: 'codex' as const, available: true, command: 'codex' },
      claude: { provider: 'claude' as const, available: true, command: 'claude' },
    },
    language: 'en' as const,
    systemPrompt: '',
    crossProviderSkillReuseEnabled: true,
    musicAlbumCoverEnabled: true,
    weatherCity: '',
    gitAgentModel: 'gpt-5.4',
    brainstormRequestModel: 'gpt-5.4',
    availableQuickToolModels: [],
    autoUrgeEnabled: false,
    autoUrgeProfiles: [],
    autoUrgeMessage: '',
    autoUrgeSuccessKeyword: '',
    workspaceCards: Object.values(column.cards),
    sessionHistory: [],
    flashCardIds: new Set<string>(),
    onRestoredAnimationEnd: () => undefined,
    onAddTab: () => undefined,
    onSplitPane: () => undefined,
    onSplitMoveTab: () => undefined,
    onCloseTab: () => undefined,
    onMoveTab: () => undefined,
    onReorderTab: () => undefined,
    onSetActiveTab: () => undefined,
    onActivatePane: () => undefined,
    onChangeCardModel: () => undefined,
    onChangeCardReasoningEffort: () => undefined,
    onToggleCardPlanMode: () => undefined,
    onToggleCardThinking: () => undefined,
    onToggleCardCollapsed: () => undefined,
    onMarkCardRead: () => undefined,
    onChangeCardDraft: () => undefined,
    onChangeCardStickyNote: () => undefined,
    onPatchCard: () => undefined,
    onChangeCardTitle: () => undefined,
    onSendMessage: async () => undefined,
    onStopMessage: async () => undefined,
  }
}

test('workspace column memoization ignores callback identity churn when column data is unchanged', () => {
  const previous = createWorkspaceColumnComparatorProps()
  const next = {
    ...previous,
    onChangeColumn: () => undefined,
    onChangeCardDraft: () => undefined,
    onSendMessage: async () => undefined,
  }

  assert.equal(areWorkspaceColumnPropsEqual(previous, next), true)
})

test('workspace column memoization rerenders when the column payload changes', () => {
  const previous = createWorkspaceColumnComparatorProps()
  const next = {
    ...previous,
    column: {
      ...previous.column,
      title: 'Changed title',
    },
  }

  assert.equal(areWorkspaceColumnPropsEqual(previous, next), false)
})

test('workspace column memoization ignores session history identity churn when entries are unchanged', () => {
  const entry = {
    id: 'history-1',
    title: 'Archived Chat',
    sessionId: 'session-1',
    provider: 'codex' as const,
    model: 'gpt-5.4',
    workspacePath: 'd:\\Git\\chill-vibe',
    archivedAt: '2026-04-11T00:00:00.000Z',
    messages: [],
  }
  const previous = {
    ...createWorkspaceColumnComparatorProps(),
    sessionHistory: [entry],
  }
  const next = {
    ...previous,
    sessionHistory: [{ ...entry }],
  }

  assert.equal(areWorkspaceColumnPropsEqual(previous, next), true)
})

test('pane memoization ignores card updates that only affect a different pane', () => {
  const previous = createPaneComparatorProps()
  const leftTabId = previous.pane.tabs[0]!
  const otherTabId = Object.keys(previous.column.cards).find((cardId) => cardId !== leftTabId)!
  const next = {
    ...previous,
    column: {
      ...previous.column,
      cards: {
        ...previous.column.cards,
        [otherTabId]: {
          ...previous.column.cards[otherTabId]!,
          title: 'Updated elsewhere',
        },
      },
    },
  }

  assert.equal(arePaneViewPropsEqual(previous, next), true)
})

test('pane memoization rerenders when one of the pane tabs changes', () => {
  const previous = createPaneComparatorProps()
  const leftTabId = previous.pane.tabs[0]!
  const next = {
    ...previous,
    column: {
      ...previous.column,
      cards: {
        ...previous.column.cards,
        [leftTabId]: {
          ...previous.column.cards[leftTabId]!,
          title: 'Updated active pane',
        },
      },
    },
  }

  assert.equal(arePaneViewPropsEqual(previous, next), false)
})
