import assert from 'node:assert/strict'
import test from 'node:test'

import { createCard, createColumn, createDefaultState, createPane, createSplit } from '../shared/default-state.ts'
import { GIT_TOOL_MODEL } from '../shared/models.ts'
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
    gitAgentModel: 'gpt-5.5',
    brainstormRequestModel: 'gpt-5.5',
    availableQuickToolModels: [],
    autoUrgeEnabled: false,
    globalUrgeActive: false,
    globalUrgeProfileId: 'auto-urge-default',
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
  const leftCard = createCard('Left Chat', 420, 'codex', 'gpt-5.5', 'medium', 'en')
  const backgroundCard = createCard('Background Chat', 420, 'codex', 'gpt-5.5', 'medium', 'en')
  const rightCard = createCard('Right Chat', 420, 'codex', 'gpt-5.5', 'medium', 'en')
  const leftPane = createPane([leftCard.id, backgroundCard.id], leftCard.id, 'pane-left')
  const rightPane = createPane([rightCard.id], rightCard.id, 'pane-right')
  const column = createColumn(
    {
      title: 'Memo Test',
      provider: 'codex',
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      cards: {
        [leftCard.id]: leftCard,
        [backgroundCard.id]: backgroundCard,
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
    gitAgentModel: 'gpt-5.5',
    brainstormRequestModel: 'gpt-5.5',
    availableQuickToolModels: [],
    autoUrgeEnabled: false,
    globalUrgeActive: false,
    globalUrgeProfileId: 'auto-urge-default',
    autoUrgeProfiles: [],
    autoUrgeMessage: '',
    autoUrgeSuccessKeyword: '',
    workspaceCards: Object.values(column.cards),
    sessionHistory: [],
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
    model: 'gpt-5.5',
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
  const otherTabId = Object.keys(previous.column.cards).find(
    (cardId) => !previous.pane.tabs.includes(cardId),
  )!
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

test('pane memoization keeps full message updates for the active chat tab', () => {
  const previous = createPaneComparatorProps()
  const activeTabId = previous.pane.activeTabId!
  const activeCard = previous.column.cards[activeTabId]!
  const next = {
    ...previous,
    column: {
      ...previous.column,
      cards: {
        ...previous.column.cards,
        [activeTabId]: {
          ...activeCard,
          messages: [
            ...activeCard.messages,
            {
              id: 'active-stream-delta',
              role: 'assistant' as const,
              content: 'new visible output',
              createdAt: '2026-07-23T00:00:00.000Z',
            },
          ],
        },
      },
    },
  }

  assert.equal(arePaneViewPropsEqual(previous, next), false)
})

test('pane memoization ignores message-only updates from an inactive background chat tab', () => {
  const previous = createPaneComparatorProps()
  const backgroundTabId = previous.pane.tabs[1]!
  const backgroundCard = previous.column.cards[backgroundTabId]!
  const next = {
    ...previous,
    column: {
      ...previous.column,
      cards: {
        ...previous.column.cards,
        [backgroundTabId]: {
          ...backgroundCard,
          messages: [
            ...backgroundCard.messages,
            {
              id: 'background-stream-delta',
              role: 'assistant' as const,
              content: 'new background output',
              createdAt: '2026-07-23T00:00:00.000Z',
            },
          ],
        },
      },
    },
  }

  assert.equal(arePaneViewPropsEqual(previous, next), true)
})

test('pane memoization rerenders when inactive tab chrome changes', () => {
  const previous = createPaneComparatorProps()
  const backgroundTabId = previous.pane.tabs[1]!
  const backgroundCard = previous.column.cards[backgroundTabId]!
  const chromeChanges = [
    { title: 'Renamed Background Chat' },
    { provider: 'claude' as const },
    { model: '__weather_tool__' },
    { status: 'streaming' as const },
    { unread: true },
  ]

  for (const patch of chromeChanges) {
    const next = {
      ...previous,
      column: {
        ...previous.column,
        cards: {
          ...previous.column.cards,
          [backgroundTabId]: {
            ...backgroundCard,
            ...patch,
          },
        },
      },
    }

    assert.equal(
      arePaneViewPropsEqual(previous, next),
      false,
      `inactive tab chrome patch should rerender: ${JSON.stringify(patch)}`,
    )
  }
})

test('pane memoization keeps full updates for an inactive Git runtime tab', () => {
  const base = createPaneComparatorProps()
  const backgroundTabId = base.pane.tabs[1]!
  const gitCard = {
    ...base.column.cards[backgroundTabId]!,
    model: GIT_TOOL_MODEL,
  }
  const previous = {
    ...base,
    column: {
      ...base.column,
      cards: {
        ...base.column.cards,
        [backgroundTabId]: gitCard,
      },
    },
  }
  const next = {
    ...previous,
    column: {
      ...previous.column,
      cards: {
        ...previous.column.cards,
        [backgroundTabId]: {
          ...gitCard,
          stickyNote: 'runtime state changed',
        },
      },
    },
  }

  assert.equal(arePaneViewPropsEqual(previous, next), false)
})

test('pane memoization rerenders an inactive tab when its wake-timer queue changes the tab label', () => {
  const previous = createPaneComparatorProps()
  const backgroundTabId = previous.pane.tabs[1]!
  const backgroundCard = previous.column.cards[backgroundTabId]!
  const next = {
    ...previous,
    column: {
      ...previous.column,
      cards: {
        ...previous.column.cards,
        [backgroundTabId]: {
          ...backgroundCard,
          wakeTimerQueuedSends: [
            {
              id: 'queued-wake-1',
              prompt: 'continue later',
              attachments: [],
            },
          ],
        },
      },
    },
  }

  assert.equal(arePaneViewPropsEqual(previous, next), false)
})
