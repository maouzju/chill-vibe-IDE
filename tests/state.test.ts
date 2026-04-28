import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import { createDefaultSettings } from '../shared/default-state.ts'
import { getDuplicateColumnTitle } from '../shared/i18n.ts'
import { BRAINSTORM_TOOL_MODEL, DEFAULT_CODEX_MODEL, WEATHER_TOOL_MODEL } from '../shared/models.ts'
import { defaultAutoUrgeProfileId } from '../shared/schema.ts'
import type {
  AppState,
  BoardColumn,
  ChatCard,
  ChatMessage,
  PaneNode,
  SplitNode,
} from '../shared/schema.ts'
import { findNearestLargerPane, findPaneInLayout, ideReducer } from '../src/state.ts'

const timestamp = '2026-04-04T12:00:00.000Z'

const assistantMessage: ChatMessage = {
  id: 'msg-assistant',
  role: 'assistant',
  content: 'Hello',
  createdAt: timestamp,
}

const createCard = (overrides: Partial<ChatCard> = {}): ChatCard => ({
  id: overrides.id ?? 'card-1',
  title: overrides.title ?? 'Chat 1',
  sessionId: overrides.sessionId,
  providerSessions: overrides.providerSessions ?? {},
  streamId: overrides.streamId,
  status: overrides.status ?? 'idle',
  provider: overrides.provider ?? 'codex',
  model: overrides.model ?? DEFAULT_CODEX_MODEL,
  reasoningEffort: overrides.reasoningEffort ?? 'medium',
  thinkingEnabled: overrides.thinkingEnabled ?? true,
  planMode: overrides.planMode ?? false,
  autoUrgeActive: overrides.autoUrgeActive ?? false,
  autoUrgeProfileId: overrides.autoUrgeProfileId ?? defaultAutoUrgeProfileId,
  collapsed: overrides.collapsed ?? false,
  unread: overrides.unread ?? false,
  draft: overrides.draft ?? '',
  stickyNote: overrides.stickyNote ?? '',
  draftAttachments: overrides.draftAttachments ?? [],
  brainstorm: overrides.brainstorm ?? {
    prompt: '',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    answerCount: 6,
    answers: [],
    failedAnswers: [],
  },
  messages: overrides.messages ?? [assistantMessage],
})

const createPane = (id: string, tabs: string[], activeTabId = tabs[0] ?? ''): PaneNode => ({
  type: 'pane',
  id,
  tabs,
  activeTabId,
})

const createSplit = (
  id: string,
  direction: SplitNode['direction'],
  children: Array<PaneNode | SplitNode>,
  ratios = children.map(() => 1 / children.length),
): SplitNode => ({
  type: 'split',
  id,
  direction,
  children,
  ratios,
})

const createColumn = (overrides: Partial<BoardColumn> = {}): BoardColumn => {
  const cards = overrides.cards ?? {
    'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL }),
    'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL }),
  }

  return {
    id: overrides.id ?? 'column-1',
    title: overrides.title ?? 'Workspace 1',
    provider: overrides.provider ?? 'codex',
    workspacePath: overrides.workspacePath ?? 'D:/repo/one',
    model: overrides.model ?? DEFAULT_CODEX_MODEL,
    width: overrides.width,
    layout: overrides.layout ?? createPane('pane-1', Object.keys(cards), 'card-1'),
    cards,
  }
}

const createState = (): AppState => ({
  version: 1,
  updatedAt: timestamp,
  settings: {
    ...createDefaultSettings(),
    requestModels: {
      codex: DEFAULT_CODEX_MODEL,
      claude: 'claude-sonnet-4-6',
    },
  },
  columns: [
    createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createPane('pane-1', ['card-1', 'card-2'], 'card-1'),
      cards: {
        'card-1': createCard({
          id: 'card-1',
          provider: 'codex',
          model: DEFAULT_CODEX_MODEL,
          sessionId: 'session-1',
          streamId: 'stream-1',
          status: 'streaming',
          draft: 'Keep this note',
        }),
        'card-2': createCard({
          id: 'card-2',
          title: 'Chat 2',
          provider: 'codex',
          model: DEFAULT_CODEX_MODEL,
          messages: [],
        }),
      },
    }),
    createColumn({
      id: 'column-2',
      title: 'Workspace 2',
      provider: 'claude',
      workspacePath: 'D:/repo/two',
      model: 'claude-opus-4-7',
      layout: createPane('pane-2', ['card-3'], 'card-3'),
      cards: {
        'card-3': createCard({
          id: 'card-3',
          title: 'Claude Chat',
          provider: 'claude',
          model: 'claude-opus-4-7',
          messages: [],
        }),
      },
    }),
  ],
  sessionHistory: [],
})

describe('ideReducer pane layout', () => {
  it('finds the nearest larger pane for auxiliary tabs like plan previews', () => {
    const layout = createSplit(
      'split-root',
      'horizontal',
      [
        createPane('pane-large', ['card-1'], 'card-1'),
        createSplit(
          'split-right',
          'vertical',
          [
            createPane('pane-small-top', ['card-2'], 'card-2'),
            createPane('pane-small-bottom', ['card-3'], 'card-3'),
          ],
          [0.4, 0.6],
        ),
      ],
      [0.68, 0.32],
    )

    assert.equal(findNearestLargerPane(layout, 'pane-small-top')?.id, 'pane-small-bottom')
    assert.equal(findNearestLargerPane(layout, 'pane-small-bottom')?.id, 'pane-large')
    assert.equal(findNearestLargerPane(layout, 'pane-large'), null)
  })

  it('resets chat sessions when the column provider changes', () => {
    const next = ideReducer(createState(), {
      type: 'updateColumn',
      columnId: 'column-1',
      patch: { provider: 'claude' },
    })

    const updated = next.columns[0]
    assert.equal(updated.provider, 'claude')
    assert.equal(updated.model, 'claude-sonnet-4-6')
    assert.equal(updated.cards['card-1']?.sessionId, undefined)
    assert.equal(updated.cards['card-1']?.streamId, undefined)
    assert.equal(updated.cards['card-1']?.status, 'idle')
    assert.equal(updated.cards['card-1']?.draft, 'Keep this note')
  })

  it('restores crash-archived sessions back into the matching workspace with one action', () => {
    const state = createState()
    state.sessionHistory = [
      {
        id: 'session-history-1',
        title: 'Recovered build thread',
        sessionId: 'session-history-1',
        provider: 'codex',
        model: DEFAULT_CODEX_MODEL,
        workspacePath: 'D:/repo/one',
        messages: [
          {
            id: 'msg-recovered',
            role: 'assistant',
            content: 'Recovered from crash archive',
            createdAt: timestamp,
          },
        ],
        archivedAt: '2026-04-11T05:30:00.000Z',
      },
    ]

    const next = ideReducer(state, {
      type: 'restoreSessionEntries',
      entryIds: ['session-history-1'],
    })

    assert.equal(next.sessionHistory.length, 0, 'restored entries should leave session history')

    const restoredColumn = next.columns[0]
    const restoredPane = restoredColumn.layout as PaneNode
    const restoredCardId = restoredPane.activeTabId
    const restoredCard = restoredColumn.cards[restoredCardId]

    assert.ok(restoredCard, 'expected the restored chat to be reopened in the matching workspace')
    assert.equal(restoredCard?.title, 'Recovered build thread')
    assert.equal(restoredCard?.messages[0]?.content, 'Recovered from crash archive')
  })

  it('skips no-op card patches so identical auto-urge updates do not churn the whole board', () => {
    const state = createState()

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: {
        autoUrgeProfileId: state.columns[0]!.cards['card-1']!.autoUrgeProfileId,
      },
    })

    assert.equal(next, state)
    assert.equal(next.updatedAt, state.updatedAt)
  })

  it('restores a history session with its archived provider, model, and session id', () => {
    const state = createState()
    state.sessionHistory = [
      {
        id: 'session-history-claude',
        title: 'Claude archived thread',
        sessionId: 'claude-session-1',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        workspacePath: 'D:/repo/one',
        messages: [assistantMessage],
        archivedAt: '2026-04-11T05:45:00.000Z',
      },
    ]

    const next = ideReducer(state, {
      type: 'restoreSession',
      columnId: 'column-1',
      entryId: 'session-history-claude',
    })

    const restoredColumn = next.columns[0]
    const restoredPane = restoredColumn.layout as PaneNode
    const restoredCard = restoredColumn.cards[restoredPane.activeTabId]

    assert.ok(restoredCard, 'expected the archived chat to reopen')
    assert.equal(restoredCard?.provider, 'claude')
    assert.equal(restoredCard?.model, 'claude-sonnet-4-6')
    assert.equal(restoredCard?.sessionId, 'claude-session-1')
  })

  it('imports an external session with its archived provider, model, and session id', () => {
    const state = createState()

    const next = ideReducer(state, {
      type: 'importExternalSession',
      columnId: 'column-1',
      entry: {
        id: 'external-session-1',
        title: 'Imported Claude thread',
        sessionId: 'external-claude-session-1',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
        workspacePath: 'D:/repo/three',
        messages: [assistantMessage],
        archivedAt: '2026-04-11T06:00:00.000Z',
      },
    })

    const restoredColumn = next.columns[0]
    const restoredPane = restoredColumn.layout as PaneNode
    const restoredCard = restoredColumn.cards[restoredPane.activeTabId]

    assert.ok(restoredCard, 'expected the imported chat to open in the target column')
    assert.equal(restoredCard?.provider, 'claude')
    assert.equal(restoredCard?.model, 'claude-haiku-4-5-20251001')
    assert.equal(restoredCard?.sessionId, 'external-claude-session-1')
  })

  it('restores a history session into the requested pane instead of always hijacking the first pane', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createSplit(
        'split-root',
        'horizontal',
        [createPane('pane-left', ['card-1'], 'card-1'), createPane('pane-right', ['card-2'], 'card-2')],
      ),
      cards: {
        'card-1': createCard({
          id: 'card-1',
          title: 'Left Chat',
          provider: 'codex',
          model: DEFAULT_CODEX_MODEL,
        }),
        'card-2': createCard({
          id: 'card-2',
          title: 'Right Chat',
          provider: 'codex',
          model: DEFAULT_CODEX_MODEL,
        }),
      },
    })

    const next = ideReducer(state, {
      type: 'importExternalSession',
      columnId: 'column-1',
      paneId: 'pane-right',
      entry: {
        id: 'external-session-target-pane',
        title: 'Restore Me Here',
        sessionId: 'target-pane-session',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        workspacePath: 'D:/repo/one',
        messages: [assistantMessage],
        archivedAt: '2026-04-11T06:10:00.000Z',
      },
    })

    const restoredColumn = next.columns[0]
    const leftPane = findPaneInLayout(restoredColumn.layout, 'pane-left')
    const rightPane = findPaneInLayout(restoredColumn.layout, 'pane-right')
    const newCardId = Object.keys(restoredColumn.cards).find((cardId) => !state.columns[0]?.cards[cardId])
    const restoredCard = newCardId ? restoredColumn.cards[newCardId] : undefined

    assert.ok(newCardId, 'expected a restored card to be inserted')
    assert.ok(leftPane, 'expected the left pane to remain in the layout')
    assert.ok(rightPane, 'expected the right pane to remain in the layout')
    assert.equal(leftPane?.activeTabId, 'card-1', 'the left pane should keep its active tab')
    assert.equal(
      rightPane?.activeTabId,
      newCardId,
      'the restored history session should open in the requested pane',
    )
    assert.equal(restoredCard?.title, 'Restore Me Here')
    assert.equal(restoredCard?.provider, 'claude')
    assert.equal(restoredCard?.sessionId, 'target-pane-session')
  })

  it('duplicates a column by cloning its cards and pane layout', () => {
    const next = ideReducer(createState(), {
      type: 'duplicateColumn',
      columnId: 'column-1',
    })

    const duplicated = next.columns[2]
    assert.ok(duplicated)
    assert.equal(duplicated?.title, getDuplicateColumnTitle(next.settings.language, 'Workspace 1'))
    assert.equal(duplicated?.provider, 'codex')
    assert.equal(duplicated?.workspacePath, 'D:/repo/one')
    assert.equal(duplicated?.model, DEFAULT_CODEX_MODEL)
    assert.notEqual(duplicated?.id, 'column-1')

    const duplicatedCardIds = Object.keys(duplicated?.cards ?? {})
    assert.equal(duplicatedCardIds.length, 2)
    assert.ok(!duplicatedCardIds.includes('card-1'))
    assert.ok(!duplicatedCardIds.includes('card-2'))

    const duplicatedCards = Object.values(duplicated?.cards ?? {})
    assert.deepEqual(
      duplicatedCards.map((card) => card.title),
      ['Chat 1', 'Chat 2'],
    )
    assert.equal(duplicatedCards[0]?.sessionId, undefined)
    assert.equal(duplicatedCards[0]?.streamId, undefined)
    assert.equal(duplicatedCards[0]?.status, 'idle')
    assert.equal(duplicatedCards[0]?.draft, 'Keep this note')
    assert.equal(duplicatedCards[0]?.messages.length, 1)

    const duplicatedLayout = duplicated?.layout as PaneNode
    assert.equal(duplicatedLayout.type, 'pane')
    assert.equal(duplicatedLayout.tabs.length, 2)
    assert.ok(duplicatedLayout.tabs.every((tabId) => duplicatedCardIds.includes(tabId)))
    assert.ok(duplicatedCardIds.includes(duplicatedLayout.activeTabId))
  })

  it('adds a new tab to the target pane and activates it', () => {
    const next = ideReducer(createState(), {
      type: 'addTab',
      columnId: 'column-1',
      paneId: 'pane-1',
    })

    const pane = next.columns[0].layout as PaneNode
    assert.equal(pane.type, 'pane')
    assert.equal(pane.tabs.length, 3)
    assert.ok(pane.activeTabId in next.columns[0].cards)
    assert.ok(!['card-1', 'card-2'].includes(pane.activeTabId))
    assert.equal(next.columns[0].cards[pane.activeTabId]?.provider, 'codex')
    assert.equal(next.columns[0].cards[pane.activeTabId]?.model, DEFAULT_CODEX_MODEL)
  })

  it('keeps auto urge manual for new chats even when the feature is enabled globally', () => {
    const state = createState()
    state.settings.autoUrgeEnabled = true

    const next = ideReducer(state, {
      type: 'addTab',
      columnId: 'column-1',
      paneId: 'pane-1',
    })

    const pane = next.columns[0].layout as PaneNode
    const newCard = next.columns[0].cards[pane.activeTabId] as ChatCard & {
      autoUrgeActive?: boolean
      autoUrgeProfileId?: string
    }

    assert.equal(newCard.autoUrgeActive, false)
    assert.equal(newCard.autoUrgeProfileId, defaultAutoUrgeProfileId)
  })

  it('remembers the last selected chat model for future tabs in the same provider column', () => {
    const selected = ideReducer(createState(), {
      type: 'selectCardModel',
      columnId: 'column-2',
      cardId: 'card-3',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })

    assert.equal(selected.settings.requestModels.claude, 'claude-sonnet-4-6')
    assert.equal(selected.columns[1]?.model, 'claude-sonnet-4-6')

    const next = ideReducer(selected, {
      type: 'addTab',
      columnId: 'column-2',
      paneId: 'pane-2',
    })

    const pane = next.columns[1]?.layout as PaneNode
    const newCard = next.columns[1]?.cards[pane.activeTabId]

    assert.equal(newCard?.provider, 'claude')
    assert.equal(newCard?.model, 'claude-sonnet-4-6')
  })

  it('prefers the column remembered model over a global lastModel from the same provider', () => {
    const state = createState()
    state.columns[1] = {
      ...state.columns[1]!,
      model: 'claude-sonnet-4-6',
      cards: {
        'card-3': createCard({
          id: 'card-3',
          title: 'Claude Sonnet Chat',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          messages: [],
        }),
      },
      layout: createPane('pane-2', ['card-3'], 'card-3'),
    }
    state.settings.requestModels.claude = 'claude-opus-4-7'
    state.settings.lastModel = { provider: 'claude', model: 'claude-opus-4-7' }

    const next = ideReducer(state, {
      type: 'addTab',
      columnId: 'column-2',
      paneId: 'pane-2',
    })

    const pane = next.columns[1]?.layout as PaneNode
    const newCard = next.columns[1]?.cards[pane.activeTabId]

    assert.equal(newCard?.provider, 'claude')
    assert.equal(newCard?.model, 'claude-sonnet-4-6')
  })

  it('inherits the active pane chat provider before a stale global lastModel from another provider', () => {
    const state = createState()
    state.settings.lastModel = { provider: 'claude', model: 'claude-haiku-4-5-20251001' }
    state.columns[1] = {
      ...state.columns[1]!,
      provider: 'claude',
      model: 'claude-opus-4-7',
      cards: {
        'card-3': createCard({
          id: 'card-3',
          title: 'Codex Chat in Claude Column',
          provider: 'codex',
          model: DEFAULT_CODEX_MODEL,
          messages: [],
        }),
      },
      layout: createPane('pane-2', ['card-3'], 'card-3'),
    }

    const next = ideReducer(state, {
      type: 'addTab',
      columnId: 'column-2',
      paneId: 'pane-2',
    })

    const pane = next.columns[1]?.layout as PaneNode
    const newCard = next.columns[1]?.cards[pane.activeTabId]

    assert.equal(newCard?.provider, 'codex')
    assert.equal(newCard?.model, DEFAULT_CODEX_MODEL)
  })

  it('uses the updated provider default for future chats after settings change', () => {
    const state = createState()
    state.columns[1] = {
      ...state.columns[1]!,
      model: '',
      cards: {
        'card-3': createCard({
          id: 'card-3',
          title: 'Claude Chat',
          provider: 'claude',
          model: '',
          messages: [],
        }),
      },
      layout: createPane('pane-2', ['card-3'], 'card-3'),
    }

    const updated = ideReducer(state, {
      type: 'updateRequestModels',
      patch: { claude: 'claude-haiku-4-5-20251001' },
    })

    assert.equal(updated.settings.requestModels.claude, 'claude-haiku-4-5-20251001')

    const afterAddTab = ideReducer(updated, {
      type: 'addTab',
      columnId: 'column-2',
      paneId: 'pane-2',
    })

    const pane = afterAddTab.columns[1]?.layout as PaneNode
    const newCard = afterAddTab.columns[1]?.cards[pane.activeTabId]

    assert.equal(newCard?.provider, 'claude')
    assert.equal(newCard?.model, 'claude-haiku-4-5-20251001')

    const afterAddColumn = ideReducer(updated, { type: 'addColumn' })
    const addedColumn = afterAddColumn.columns.at(-1)

    assert.equal(addedColumn?.provider, 'claude')
    assert.equal(addedColumn?.model, 'claude-haiku-4-5-20251001')
  })

  it('updates untouched empty chats that still point at the previous provider default', () => {
    const state = createState()
    state.settings.requestModels.claude = 'claude-opus-4-7'
    const claudeColumn = state.columns[1]!
    claudeColumn.cards['card-4'] = createCard({
      id: 'card-4',
      title: '',
      provider: 'claude',
      model: 'claude-opus-4-7',
      messages: [],
    })
    claudeColumn.cards['card-5'] = createCard({
      id: 'card-5',
      title: 'Pinned Opus Chat',
      provider: 'claude',
      model: 'claude-opus-4-7',
    })
    claudeColumn.layout = createPane('pane-2', ['card-3', 'card-4', 'card-5'], 'card-3')

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-2',
      cardId: 'card-3',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })

    assert.equal(next.settings.requestModels.claude, 'claude-sonnet-4-6')
    assert.equal(next.columns[1]?.cards['card-3']?.model, 'claude-sonnet-4-6')
    assert.equal(next.columns[1]?.cards['card-4']?.model, 'claude-sonnet-4-6')
    assert.equal(next.columns[1]?.cards['card-5']?.model, 'claude-opus-4-7')
  })

  it('does not replace future chat defaults when switching the current card to a tool model', () => {
    const selected = ideReducer(createState(), {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'card-1',
      provider: 'codex',
      model: WEATHER_TOOL_MODEL,
    })

    assert.equal(selected.settings.requestModels.codex, DEFAULT_CODEX_MODEL)
    assert.equal(selected.columns[0]?.model, DEFAULT_CODEX_MODEL)

    const next = ideReducer(selected, {
      type: 'addTab',
      columnId: 'column-1',
      paneId: 'pane-1',
    })

    const pane = next.columns[0]?.layout as PaneNode
    const newCard = next.columns[0]?.cards[pane.activeTabId]

    assert.equal(newCard?.provider, 'codex')
    assert.equal(newCard?.model, DEFAULT_CODEX_MODEL)
  })

  it('drops stale provider sessions when switching an image-bearing chat to another provider', () => {
    const state = createState()
    state.columns[0]!.cards['card-1'] = createCard({
      id: 'card-1',
      title: 'Image review',
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL,
      sessionId: 'codex-session-active',
      providerSessions: {
        claude: 'claude-session-stale',
      },
      status: 'idle',
      streamId: undefined,
      messages: [
        {
          id: 'msg-user-image',
          role: 'user',
          content: 'Please compare this screenshot before we switch providers.',
          createdAt: timestamp,
          meta: attachImagesToMessageMeta([
            {
              id: 'image-1',
              fileName: 'board.png',
              mimeType: 'image/png',
              sizeBytes: 2048,
            },
          ]),
        },
      ],
    })

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'card-1',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })

    const updated = next.columns[0]!.cards['card-1']
    assert.equal(updated?.provider, 'claude')
    assert.equal(updated?.model, 'claude-sonnet-4-6')
    assert.equal(
      updated?.sessionId,
      undefined,
      'switching providers with historical images must force a fresh seeded session',
    )
    assert.deepEqual(
      updated?.providerSessions,
      {},
      'stale provider-specific sessions must not survive after an image-bearing provider switch',
    )
  })

  it('drops the active session when switching models inside an image-bearing chat', () => {
    const state = createState()
    state.columns[1]!.cards['card-3'] = createCard({
      id: 'card-3',
      title: 'Claude image review',
      provider: 'claude',
      model: 'claude-opus-4-7',
      sessionId: 'claude-session-active',
      providerSessions: {
        codex: 'codex-session-stale',
      },
      status: 'idle',
      streamId: undefined,
      messages: [
        {
          id: 'msg-user-image',
          role: 'user',
          content: 'Inspect this screenshot and keep it available after the model switch.',
          createdAt: timestamp,
          meta: attachImagesToMessageMeta([
            {
              id: 'image-2',
              fileName: 'screenshot.png',
              mimeType: 'image/png',
              sizeBytes: 4096,
            },
          ]),
        },
      ],
    })

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-2',
      cardId: 'card-3',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })

    const updated = next.columns[1]!.cards['card-3']
    assert.equal(updated?.provider, 'claude')
    assert.equal(updated?.model, 'claude-sonnet-4-6')
    assert.equal(
      updated?.sessionId,
      undefined,
      'switching models with historical images must replay the transcript into a fresh session',
    )
    assert.deepEqual(
      updated?.providerSessions,
      {},
      'saved sessions from other providers also become stale once the image-bearing history changes model',
    )
  })

  it('drops the active session when switching models inside a text-only chat', () => {
    const state = createState()
    state.columns[1]!.cards['card-3'] = createCard({
      id: 'card-3',
      title: 'Claude architecture review',
      provider: 'claude',
      model: 'claude-opus-4-7',
      sessionId: 'claude-session-active',
      providerSessions: {
        codex: 'codex-session-stale',
      },
      status: 'idle',
      streamId: undefined,
      messages: [
        {
          id: 'msg-user-text',
          role: 'user',
          content: 'Keep reviewing this reducer, but switch me to Sonnet first.',
          createdAt: timestamp,
        },
      ],
    })

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-2',
      cardId: 'card-3',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })

    const updated = next.columns[1]!.cards['card-3']
    assert.equal(updated?.provider, 'claude')
    assert.equal(updated?.model, 'claude-sonnet-4-6')
    assert.equal(
      updated?.sessionId,
      undefined,
      'switching text chats to another model must not keep resuming the old-model session',
    )
    assert.deepEqual(
      updated?.providerSessions,
      {},
      'saved sessions from other providers also become stale once the active chat switches model',
    )
  })

  it('keeps the session when an image-bearing chat switches from an explicit model to the same configured default', () => {
    const state = createState()
    state.settings.requestModels.claude = 'claude-sonnet-4-6'
    state.columns[1]!.cards['card-3'] = createCard({
      id: 'card-3',
      title: 'Pinned sonnet chat',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      sessionId: 'claude-session-active',
      providerSessions: {
        codex: 'codex-session-stale',
      },
      status: 'idle',
      streamId: undefined,
      messages: [
        {
          id: 'msg-user-image',
          role: 'user',
          content: 'Keep this screenshot context while unpinning back to the default model.',
          createdAt: timestamp,
          meta: attachImagesToMessageMeta([
            {
              id: 'image-3',
              fileName: 'default-model.png',
              mimeType: 'image/png',
              sizeBytes: 1024,
            },
          ]),
        },
      ],
    })

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-2',
      cardId: 'card-3',
      provider: 'claude',
      model: '',
    })

    const updated = next.columns[1]!.cards['card-3']
    assert.equal(updated?.provider, 'claude')
    assert.equal(updated?.model, '')
    assert.equal(
      updated?.sessionId,
      'claude-session-active',
      'switching to the same effective configured default should not force a fresh session',
    )
    assert.deepEqual(
      updated?.providerSessions,
      { codex: 'codex-session-stale' },
      'equivalent model selections should preserve saved provider sessions',
    )
  })

  it('adds a preconfigured tool tab with the requested title and model', () => {
    const next = ideReducer(createState(), {
      type: 'addTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      title: 'Weather',
      model: WEATHER_TOOL_MODEL,
    })

    const pane = next.columns[0].layout as PaneNode
    const toolCard = next.columns[0].cards[pane.activeTabId]

    assert.ok(toolCard)
    assert.equal(toolCard?.title, 'Weather')
    assert.equal(toolCard?.model, WEATHER_TOOL_MODEL)
    assert.equal(toolCard?.provider, 'codex')
  })


  it('adds a brainstorm tool tab with default target count and empty failure history', () => {
    const next = ideReducer(createState(), {
      type: 'addTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      title: 'Brainstorm',
      model: BRAINSTORM_TOOL_MODEL,
    })

    const pane = next.columns[0].layout as PaneNode
    const toolCard = next.columns[0].cards[pane.activeTabId]

    assert.ok(toolCard)
    assert.equal(toolCard?.title, 'Brainstorm')
    assert.equal(toolCard?.model, BRAINSTORM_TOOL_MODEL)
    assert.equal(toolCard?.provider, 'codex')
    assert.deepEqual(toolCard?.brainstorm, {
      prompt: '',
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL,
      answerCount: 6,
      answers: [],
      failedAnswers: [],
    })
  })

  it('splits a pane and moves the requested tab into the new sibling pane', () => {
    const next = ideReducer(createState(), {
      type: 'splitPane',
      columnId: 'column-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      tabId: 'card-2',
    })

    const root = next.columns[0].layout as SplitNode
    assert.equal(root.type, 'split')
    assert.equal(root.direction, 'horizontal')
    assert.deepEqual(root.ratios, [0.5, 0.5])

    const firstPane = root.children[0] as PaneNode
    const secondPane = root.children[1] as PaneNode
    assert.deepEqual(firstPane.tabs, ['card-1'])
    assert.equal(firstPane.activeTabId, 'card-1')
    assert.deepEqual(secondPane.tabs, ['card-2'])
    assert.equal(secondPane.activeTabId, 'card-2')
  })

  it('cross-pane drag-to-split creates an empty new pane without stealing a tab', () => {
    // Simulates the cross-pane drag-to-split flow from PaneView:
    // 1. splitPane with no tabId → should create an empty new pane
    // 2. moveTab moves the dragged tab into the new pane
    const newPaneId = 'new-pane'
    let next = ideReducer(createState(), {
      type: 'splitPane',
      columnId: 'column-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      tabId: undefined,
      newPaneId,
    })

    // The new pane must exist (not collapsed) and the original pane must keep all its tabs
    const root = next.columns[0].layout as SplitNode
    assert.equal(root.type, 'split', 'layout should be a split after splitPane with no tabId')

    const originalPane = root.children.find(
      (child) => child.type === 'pane' && child.id === 'pane-1',
    ) as PaneNode | undefined
    const newPane = root.children.find(
      (child) => child.type === 'pane' && child.id === newPaneId,
    ) as PaneNode | undefined

    assert.ok(originalPane, 'original pane must still exist')
    assert.ok(newPane, 'new empty pane must exist (not collapsed)')
    assert.deepEqual(originalPane.tabs, ['card-1', 'card-2'], 'original pane must keep all tabs')
    assert.deepEqual(newPane.tabs, [], 'new pane should start empty')

    // Step 2: move the dragged tab into the new pane
    next = ideReducer(next, {
      type: 'moveTab',
      sourceColumnId: 'column-2',
      sourcePaneId: 'pane-2',
      tabId: 'card-3',
      targetColumnId: 'column-1',
      targetPaneId: newPaneId,
    })

    const rootAfter = next.columns[0].layout as SplitNode
    const pane1After = rootAfter.children.find(
      (child) => child.type === 'pane' && child.id === 'pane-1',
    ) as PaneNode | undefined
    const newPaneAfter = rootAfter.children.find(
      (child) => child.type === 'pane' && child.id === newPaneId,
    ) as PaneNode | undefined

    assert.ok(pane1After)
    assert.ok(newPaneAfter)
    assert.deepEqual(pane1After.tabs, ['card-1', 'card-2'], 'original pane still has both tabs')
    assert.deepEqual(newPaneAfter.tabs, ['card-3'], 'new pane has only the moved tab')
  })

  it('atomically splits the target pane and moves a same-column tab into the new sibling pane', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createSplit(
        'split-root',
        'horizontal',
        [
          createPane('pane-left', ['card-1'], 'card-1'),
          createPane('pane-right', ['card-2'], 'card-2'),
        ],
        [0.5, 0.5],
      ),
      cards: {
        'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
      },
    })

    const next = ideReducer(state, {
      type: 'splitMoveTab',
      columnId: 'column-1',
      sourcePaneId: 'pane-left',
      targetPaneId: 'pane-right',
      tabId: 'card-1',
      direction: 'vertical',
      placement: 'after',
      newPaneId: 'pane-bottom',
    })

    const root = next.columns[0].layout as SplitNode
    assert.equal(root.type, 'split')
    assert.equal(root.direction, 'vertical')
    assert.deepEqual(root.ratios, [0.5, 0.5])

    const topPane = root.children[0] as PaneNode
    const bottomPane = root.children[1] as PaneNode
    assert.deepEqual(topPane.tabs, ['card-2'])
    assert.deepEqual(bottomPane.tabs, ['card-1'])
    assert.equal(bottomPane.activeTabId, 'card-1')
    assert.ok(next.columns[0].cards['card-1'], 'moved tab should stay in the same-column card map')
  })

  it('rebalances to an even split when a pane is turned into a vertical split elsewhere', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createSplit(
        'split-root',
        'vertical',
        [
          createPane('pane-top', ['card-1'], 'card-1'),
          createPane('pane-bottom', ['card-2'], 'card-2'),
        ],
        [0.25, 0.75],
      ),
      cards: {
        'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
      },
    })

    const next = ideReducer(state, {
      type: 'splitMoveTab',
      columnId: 'column-1',
      sourcePaneId: 'pane-top',
      targetPaneId: 'pane-bottom',
      tabId: 'card-1',
      direction: 'vertical',
      placement: 'after',
      newPaneId: 'pane-moved',
    })

    const root = next.columns[0].layout as SplitNode
    assert.equal(root.type, 'split')
    assert.equal(root.direction, 'vertical')
    assert.deepEqual(root.ratios, [0.5, 0.5])
  })

  it('splits the tiny target pane evenly instead of inheriting the dragged pane height', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createSplit(
        'split-root',
        'horizontal',
        [
          createPane('pane-left', ['card-1'], 'card-1'),
          createSplit(
            'split-right',
            'vertical',
            [
              createPane('pane-right-top', ['card-2'], 'card-2'),
              createPane('pane-right-bottom', ['card-3'], 'card-3'),
            ],
            [0.1, 0.9],
          ),
        ],
        [0.5, 0.5],
      ),
      cards: {
        'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-3': createCard({ id: 'card-3', title: 'Chat 3', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
      },
    })

    const next = ideReducer(state, {
      type: 'splitMoveTab',
      columnId: 'column-1',
      sourcePaneId: 'pane-left',
      targetPaneId: 'pane-right-top',
      tabId: 'card-1',
      direction: 'vertical',
      placement: 'after',
      newPaneId: 'pane-moved',
    })

    const root = next.columns[0].layout as SplitNode
    assert.equal(root.type, 'split')
    assert.equal(root.id, 'split-right')
    assert.equal(root.direction, 'vertical')

    const upperBranch = root.children[0] as SplitNode
    assert.equal(upperBranch.type, 'split')
    assert.equal(upperBranch.direction, 'vertical')
    assert.deepEqual(upperBranch.ratios, [0.5, 0.5])
  })

  it('splits the tiny target pane evenly instead of inheriting the dragged pane width', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createSplit(
        'split-root',
        'vertical',
        [
          createPane('pane-top', ['card-1'], 'card-1'),
          createSplit(
            'split-bottom',
            'horizontal',
            [
              createPane('pane-bottom-left', ['card-2'], 'card-2'),
              createPane('pane-bottom-right', ['card-3'], 'card-3'),
            ],
            [0.1, 0.9],
          ),
        ],
        [0.5, 0.5],
      ),
      cards: {
        'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-3': createCard({ id: 'card-3', title: 'Chat 3', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
      },
    })

    const next = ideReducer(state, {
      type: 'splitMoveTab',
      columnId: 'column-1',
      sourcePaneId: 'pane-top',
      targetPaneId: 'pane-bottom-left',
      tabId: 'card-1',
      direction: 'horizontal',
      placement: 'after',
      newPaneId: 'pane-moved',
    })

    const root = next.columns[0].layout as SplitNode
    assert.equal(root.type, 'split')
    assert.equal(root.id, 'split-bottom')
    assert.equal(root.direction, 'horizontal')
    assert.deepEqual(root.ratios, [0.1, 0.9])

    const leftBranch = root.children[0] as SplitNode
    assert.equal(leftBranch.type, 'split')
    assert.equal(leftBranch.direction, 'horizontal')
    assert.deepEqual(leftBranch.ratios, [0.5, 0.5])
  })

  it('reorders tabs within a pane without touching the card map', () => {
    const next = ideReducer(createState(), {
      type: 'reorderTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-2',
      index: 0,
    })

    const pane = next.columns[0].layout as PaneNode
    assert.deepEqual(pane.tabs, ['card-2', 'card-1'])
    assert.equal(next.columns[0].cards['card-1']?.title, 'Chat 1')
    assert.equal(next.columns[0].cards['card-2']?.title, 'Chat 2')
  })

  it('moves a tab across workspaces and rebinds it to the target provider defaults', () => {
    const next = ideReducer(createState(), {
      type: 'moveTab',
      sourceColumnId: 'column-1',
      sourcePaneId: 'pane-1',
      tabId: 'card-1',
      targetColumnId: 'column-2',
      targetPaneId: 'pane-2',
      index: 0,
    })

    const sourcePane = next.columns[0].layout as PaneNode
    const targetPane = next.columns[1].layout as PaneNode

    assert.deepEqual(sourcePane.tabs, ['card-2'])
    assert.deepEqual(targetPane.tabs, ['card-1', 'card-3'])
    assert.equal(next.columns[0].cards['card-1'], undefined)
    assert.equal(next.columns[1].cards['card-1']?.provider, 'claude')
    assert.equal(next.columns[1].cards['card-1']?.model, 'claude-sonnet-4-6')
    assert.equal(next.columns[1].cards['card-1']?.sessionId, undefined)
    assert.equal(next.columns[1].cards['card-1']?.streamId, undefined)
    assert.equal(next.columns[1].cards['card-1']?.status, 'idle')
  })

  it('promotes the most recently active remaining tab when the active tab moves away', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createPane('pane-1', ['card-1', 'card-2', 'card-4'], 'card-1'),
      cards: {
        'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-4': createCard({ id: 'card-4', title: 'Chat 4', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
      },
    })

    const afterSelectingSecond = ideReducer(state, {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-2',
    })

    const selected = ideReducer(afterSelectingSecond, {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-4',
    })

    const next = ideReducer(selected, {
      type: 'moveTab',
      sourceColumnId: 'column-1',
      sourcePaneId: 'pane-1',
      tabId: 'card-4',
      targetColumnId: 'column-2',
      targetPaneId: 'pane-2',
      index: 0,
    })

    const sourcePane = next.columns[0].layout as PaneNode
    assert.deepEqual(sourcePane.tabs, ['card-1', 'card-2'])
    assert.equal(sourcePane.activeTabId, 'card-2')
  })

  it('closes the final tab in a pane, archives it, and collapses the parent split', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      layout: createSplit('split-root', 'horizontal', [
        createPane('pane-a', ['card-1'], 'card-1'),
        createPane('pane-b', ['card-2'], 'card-2'),
      ]),
      cards: {
        'card-1': createCard({ id: 'card-1', title: 'Archived Chat', messages: [assistantMessage] }),
        'card-2': createCard({ id: 'card-2', title: 'Remaining Chat', messages: [] }),
      },
    })

    const next = ideReducer(state, {
      type: 'closeTab',
      columnId: 'column-1',
      paneId: 'pane-a',
      tabId: 'card-1',
    })

    const layout = next.columns[0].layout as PaneNode
    assert.equal(layout.type, 'pane')
    assert.equal(layout.id, 'pane-b')
    assert.deepEqual(layout.tabs, ['card-2'])
    assert.equal(next.columns[0].cards['card-1'], undefined)
    assert.equal(next.sessionHistory.length, 1)
    assert.equal(next.sessionHistory[0]?.title, 'Archived Chat')
  })

  it('promotes the most recently active remaining tab when the active tab closes', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      layout: createPane('pane-1', ['card-1', 'card-2', 'card-4'], 'card-1'),
      cards: {
        'card-1': createCard({ id: 'card-1', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [] }),
        'card-4': createCard({ id: 'card-4', title: 'Chat 4', provider: 'codex', model: DEFAULT_CODEX_MODEL, messages: [assistantMessage] }),
      },
    })

    const afterSelectingSecond = ideReducer(state, {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-2',
    })

    const selected = ideReducer(afterSelectingSecond, {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-4',
    })

    const next = ideReducer(selected, {
      type: 'closeTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-4',
    })

    const pane = next.columns[0].layout as PaneNode
    assert.deepEqual(pane.tabs, ['card-1', 'card-2'])
    assert.equal(pane.activeTabId, 'card-2')
  })

  it('updates split ratios when a pane group is resized', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      layout: createSplit('split-root', 'vertical', [
        createPane('pane-a', ['card-1'], 'card-1'),
        createPane('pane-b', ['card-2'], 'card-2'),
      ]),
      cards: {
        'card-1': createCard({ id: 'card-1' }),
        'card-2': createCard({ id: 'card-2', title: 'Chat 2', messages: [] }),
      },
    })

    const next = ideReducer(state, {
      type: 'resizePane',
      columnId: 'column-1',
      splitId: 'split-root',
      ratios: [0.25, 0.75],
    })

    const layout = next.columns[0].layout as SplitNode
    assert.deepEqual(layout.ratios, [0.25, 0.75])
  })

  it('persists a coordinated column resize across multiple columns', () => {
    const state = createState()
    const next = ideReducer(state, {
      type: 'setColumnWidths',
      widths: [
        { columnId: 'column-1', width: 420 },
        { columnId: 'column-2', width: 560 },
      ],
    })

    assert.equal(next.columns[0]?.width, 420)
    assert.equal(next.columns[1]?.width, 560)
  })

  it('redistributes freed width across the remaining columns when one column is removed', () => {
    const state = createState()
    state.columns = [
      createColumn({
        id: 'column-1',
        width: 480,
      }),
      createColumn({
        id: 'column-2',
        width: 720,
      }),
      createColumn({
        id: 'column-3',
        width: 600,
      }),
    ]

    const next = ideReducer(state, {
      type: 'removeColumn',
      columnId: 'column-2',
    })

    assert.deepEqual(
      next.columns.map((column) => column.id),
      ['column-1', 'column-3'],
    )
    assert.equal(next.columns[0]?.width, 800)
    assert.equal(next.columns[1]?.width, 1000)
  })

  it('switches the active tab inside a pane', () => {
    const next = ideReducer(createState(), {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-2',
    })

    const pane = next.columns[0].layout as PaneNode
    assert.equal(pane.activeTabId, 'card-2')
  })

  it('turns a stopped streaming card idle without replacing streamed assistant text', () => {
    const state = createState()
    state.columns[0] = createColumn({
      id: 'column-1',
      layout: createPane('pane-1', ['card-1'], 'card-1'),
      cards: {
        'card-1': createCard({
          id: 'card-1',
          status: 'streaming',
          streamId: 'stream-1',
          messages: [
            {
              id: 'live-assistant-1',
              role: 'assistant',
              content: 'Partially generated answer that must survive interrupt.',
              createdAt: timestamp,
            },
          ],
        }),
      },
    })

    const next = ideReducer(state, {
      type: 'finishStoppedStream',
      columnId: 'column-1',
      cardId: 'card-1',
      stoppedMessage: {
        id: 'stopped-1',
        role: 'system',
        content: 'User interrupted',
        createdAt: timestamp,
        meta: {
          kind: 'run-stopped',
          stopReason: 'user-interrupt',
        },
      },
    })

    const card = next.columns[0]?.cards['card-1']
    assert.equal(card?.status, 'idle')
    assert.equal(card?.streamId, undefined)
    assert.equal(card?.messages[0]?.id, 'live-assistant-1')
    assert.equal(card?.messages[0]?.content, 'Partially generated answer that must survive interrupt.')
    assert.equal(card?.messages[1]?.meta?.kind, 'run-stopped')
  })

});
describe('addColumn follows last-used provider/model when available', () => {
  it('uses the last-used provider and model even when the last column uses another provider', () => {
    const baseState = createState()
    const state: AppState = {
      ...baseState,
      columns: [baseState.columns[1]!],
      settings: {
        ...createDefaultSettings(),
        requestModels: { codex: DEFAULT_CODEX_MODEL, claude: 'claude-opus-4-7' },
        lastModel: { provider: 'codex', model: DEFAULT_CODEX_MODEL },
      },
    }

    const next = ideReducer(state, { type: 'addColumn' })
    const added = next.columns.at(-1)!

    assert.equal(added.provider, 'codex')
    assert.equal(added.model, DEFAULT_CODEX_MODEL)
  })

  it('selectCardModel updates global lastModel', () => {
    const state = createState()
    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'card-1',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    })

    assert.deepEqual(next.settings.lastModel, { provider: 'claude', model: 'claude-sonnet-4-6' })
  })

  it('reuses the remembered model when it matches the new column provider', () => {
    const baseState = createState()
    const state: AppState = {
      ...baseState,
      columns: [baseState.columns[1]!],
      settings: {
        ...createDefaultSettings(),
        requestModels: { codex: DEFAULT_CODEX_MODEL, claude: 'claude-opus-4-7' },
        lastModel: { provider: 'claude', model: 'claude-sonnet-4-6' },
      },
    }

    const afterAdd = ideReducer(state, { type: 'addColumn' })
    const added = afterAdd.columns.at(-1)!
    assert.equal(added.provider, 'claude')
    assert.equal(added.model, 'claude-sonnet-4-6')
  })

  it('falls back to the configured provider default when no lastModel is set', () => {
    const state = createState()
    // No lastModel in settings, so new columns should use the current provider default.
    assert.equal(state.settings.lastModel, undefined)

    const next = ideReducer(state, { type: 'addColumn' })
    const added = next.columns.at(-1)!

    assert.equal(added.provider, 'claude')
    assert.equal(added.model, 'claude-sonnet-4-6')
  })
});

describe('setActiveTab no-op short-circuit', () => {
  it('returns the same state reference when the tab is already active', () => {
    const state = createState()
    const pane = state.columns[0]!.layout as PaneNode
    assert.equal(pane.activeTabId, 'card-1', 'precondition: card-1 is already active')

    const next = ideReducer(state, {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-1',
    })

    assert.equal(state, next, 'state reference must be identical when tab is already active')
    assert.equal(state.updatedAt, next.updatedAt, 'updatedAt must not change')
  })

  it('returns a new state when switching to a different tab', () => {
    const state = createState()

    const next = ideReducer(state, {
      type: 'setActiveTab',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'card-2',
    })

    assert.notEqual(state, next, 'state reference must change for a real tab switch')
    const nextPane = next.columns[0]!.layout as PaneNode
    assert.equal(nextPane.activeTabId, 'card-2')
  })

  it('returns the same state for a non-existent column', () => {
    const state = createState()

    const next = ideReducer(state, {
      type: 'setActiveTab',
      columnId: 'no-such-column',
      paneId: 'pane-1',
      tabId: 'card-2',
    })

    assert.equal(state, next)
  })
});
