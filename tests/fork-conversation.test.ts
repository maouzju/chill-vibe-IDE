import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import { createDefaultSettings } from '../shared/default-state.ts'
import { getForkConversationTitle } from '../shared/i18n.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type {
  AppState,
  BoardColumn,
  ChatCard,
  ChatMessage,
  PaneNode,
} from '../shared/schema.ts'
import { ideReducer } from '../src/state.ts'

const timestamp = '2026-04-04T12:00:00.000Z'

const msg = (id: string, role: ChatMessage['role'], content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: timestamp,
})

const createCard = (overrides: Partial<ChatCard> = {}): ChatCard => ({
  id: overrides.id ?? 'card-1',
  title: overrides.title ?? 'Chat 1',
  sessionId: overrides.sessionId ?? 'session-abc',
  providerSessions: overrides.providerSessions ?? {},
  streamId: overrides.streamId,
  status: overrides.status ?? 'idle',
  provider: overrides.provider ?? 'codex',
  model: overrides.model ?? DEFAULT_CODEX_MODEL,
  reasoningEffort: overrides.reasoningEffort ?? 'medium',
  thinkingEnabled: overrides.thinkingEnabled ?? true,
  planMode: overrides.planMode ?? false,
  autoUrgeActive: overrides.autoUrgeActive ?? false,
  autoUrgeProfileId: overrides.autoUrgeProfileId ?? 'auto-urge-default',
  collapsed: overrides.collapsed ?? false,
  unread: overrides.unread ?? false,
  draft: overrides.draft ?? '',
  stickyNote: overrides.stickyNote ?? '',
  brainstorm: overrides.brainstorm ?? createDefaultBrainstormState(),
  messages: overrides.messages ?? [],
})

const createPane = (id: string, tabs: string[], activeTabId = tabs[0] ?? ''): PaneNode => ({
  type: 'pane',
  id,
  tabs,
  activeTabId,
})

const createColumn = (overrides: Partial<BoardColumn> = {}): BoardColumn => {
  const cards = overrides.cards ?? {}
  return {
    id: overrides.id ?? 'column-1',
    title: overrides.title ?? 'Workspace 1',
    provider: overrides.provider ?? 'codex',
    workspacePath: overrides.workspacePath ?? 'D:/repo/one',
    model: overrides.model ?? DEFAULT_CODEX_MODEL,
    width: overrides.width,
    layout: overrides.layout ?? createPane('pane-1', Object.keys(cards), Object.keys(cards)[0] ?? ''),
    cards,
  }
}

const buildState = (columns: BoardColumn[]): AppState => ({
  version: 1,
  columns,
  settings: createDefaultSettings(),
  sessionHistory: [],
  updatedAt: timestamp,
})

describe('forkConversation', () => {
  const messages: ChatMessage[] = [
    msg('m1', 'user', 'Hello'),
    msg('m2', 'assistant', 'Hi there'),
    msg('m3', 'user', 'How are you?'),
    msg('m4', 'assistant', 'I am fine'),
  ]

  const card = createCard({ id: 'card-1', title: 'Chat 1', messages })
  const column = createColumn({
    id: 'col-1',
    cards: { 'card-1': card },
    layout: createPane('pane-1', ['card-1'], 'card-1'),
  })
  const state = buildState([column])

  it('forks from middle message — new card has messages up to fork point', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm3',
    })

    const nextColumn = next.columns.find((c) => c.id === 'col-1')!
    const cardIds = Object.keys(nextColumn.cards)
    assert.equal(cardIds.length, 2, 'should have 2 cards')

    const forkedCardId = cardIds.find((id) => id !== 'card-1')!
    const forkedCard = nextColumn.cards[forkedCardId]!
    assert.equal(forkedCard.messages.length, 3)
    assert.equal(forkedCard.messages[0]!.id, 'm1')
    assert.equal(forkedCard.messages[1]!.id, 'm2')
    assert.equal(forkedCard.messages[2]!.id, 'm3')
  })

  it('assistant selections fall back to the preceding user prompt', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm4',
    })

    const nextColumn = next.columns.find((c) => c.id === 'col-1')!
    const forkedCardId = Object.keys(nextColumn.cards).find((id) => id !== 'card-1')!
    const forkedCard = nextColumn.cards[forkedCardId]!
    assert.equal(forkedCard.messages.length, 3)
    assert.equal(forkedCard.messages[2]!.id, 'm3')
  })

  it('original card is unchanged after fork', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm2',
    })

    const originalCard = next.columns.find((c) => c.id === 'col-1')!.cards['card-1']!
    assert.equal(originalCard.messages.length, 4)
    assert.equal(originalCard.sessionId, 'session-abc')
  })

  it('forked card has no sessionId', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm2',
    })

    const nextColumn = next.columns.find((c) => c.id === 'col-1')!
    const forkedCardId = Object.keys(nextColumn.cards).find((id) => id !== 'card-1')!
    const forkedCard = nextColumn.cards[forkedCardId]!
    assert.equal(forkedCard.sessionId, undefined)
  })

  it('forked card appears in same pane and is active', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm2',
    })

    const nextColumn = next.columns.find((c) => c.id === 'col-1')!
    const pane = nextColumn.layout as PaneNode
    assert.equal(pane.tabs.length, 2)

    const forkedCardId = pane.tabs.find((id) => id !== 'card-1')!
    assert.equal(pane.activeTabId, forkedCardId)
  })

  it('fork with invalid columnId is a no-op', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'nonexistent',
      cardId: 'card-1',
      messageId: 'm2',
    })
    assert.equal(next, state)
  })

  it('fork with invalid cardId is a no-op', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'nonexistent',
      messageId: 'm2',
    })
    assert.equal(next, state)
  })

  it('fork with invalid messageId is a no-op', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'nonexistent',
    })
    assert.equal(next, state)
  })

  it('fork from the last assistant message stops at the previous user prompt', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm4',
    })

    const nextColumn = next.columns.find((c) => c.id === 'col-1')!
    const forkedCardId = Object.keys(nextColumn.cards).find((id) => id !== 'card-1')!
    const forkedCard = nextColumn.cards[forkedCardId]!
    assert.equal(forkedCard.messages.length, 3)
  })

  it('fork title includes fork suffix', () => {
    const next = ideReducer(state, {
      type: 'forkConversation',
      columnId: 'col-1',
      cardId: 'card-1',
      messageId: 'm2',
    })

    const nextColumn = next.columns.find((c) => c.id === 'col-1')!
    const forkedCardId = Object.keys(nextColumn.cards).find((id) => id !== 'card-1')!
    const forkedCard = nextColumn.cards[forkedCardId]!
    // Default settings language is 'zh-CN'
    assert.equal(forkedCard.title, getForkConversationTitle('zh-CN', 'Chat 1'))
  })
})
