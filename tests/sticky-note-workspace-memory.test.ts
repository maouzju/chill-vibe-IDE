import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultSettings } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL, STICKYNOTE_TOOL_MODEL } from '../shared/models.ts'
import { appStateSchema, defaultAutoUrgeProfileId } from '../shared/schema.ts'
import type { AppState, BoardColumn, ChatCard, PaneNode } from '../shared/schema.ts'
import { StickyNoteCard } from '../src/components/StickyNoteCard.tsx'
import { ideReducer } from '../src/state.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const timestamp = '2026-07-27T08:00:00.000Z'

const createCard = (overrides: Partial<ChatCard> = {}): ChatCard => ({
  id: overrides.id ?? 'card-1',
  title: overrides.title ?? '便签 A',
  providerSessions: {},
  status: 'idle',
  provider: 'codex',
  model: STICKYNOTE_TOOL_MODEL,
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: defaultAutoUrgeProfileId,
  collapsed: false,
  unread: false,
  draft: '',
  stickyNote: overrides.stickyNote ?? '',
  stickyNoteId: overrides.stickyNoteId ?? overrides.id ?? 'card-1',
  stickyNoteViewState: overrides.stickyNoteViewState,
  draftAttachments: [],
  queuedSends: [],
  brainstorm: {
    prompt: '',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    answerCount: 6,
    answers: [],
    failedAnswers: [],
  },
  messages: [],
  ...overrides,
})

const createPane = (tabs: string[]): PaneNode => ({
  type: 'pane',
  id: 'pane-1',
  tabs,
  activeTabId: tabs[0] ?? '',
})

const createColumn = (cards: Record<string, ChatCard>): BoardColumn => ({
  id: 'column-1',
  title: 'Workspace 1',
  provider: 'codex',
  workspacePath: 'D:/repo/one',
  model: DEFAULT_CODEX_MODEL,
  layout: createPane(Object.keys(cards)),
  cards,
})

const createState = (cards: Record<string, ChatCard>): AppState => ({
  version: 1,
  updatedAt: timestamp,
  settings: createDefaultSettings(),
  columns: [createColumn(cards)],
  sessionHistory: [],
  stickyNoteArchive: {
    'D:/repo/one': { content: '旧版单份存档', updatedAt: timestamp },
  },
})

describe('sticky note identity migration and isolation', () => {
  it('parses legacy cards without note identity or view state', () => {
    const card = createCard({ id: 'legacy-card' })
    const rawCard = structuredClone(card) as unknown as Record<string, unknown>
    delete rawCard.stickyNoteId
    delete rawCard.stickyNoteViewState
    const state = createState({ 'legacy-card': card })
    const raw = structuredClone(state) as unknown as Record<string, unknown>
    const columns = raw.columns as Array<Record<string, unknown>>
    columns[0]!.cards = { 'legacy-card': rawCard }

    const parsed = appStateSchema.parse(raw)
    assert.equal(parsed.columns[0]?.cards['legacy-card']?.stickyNoteId, undefined)
    assert.equal(parsed.columns[0]?.cards['legacy-card']?.stickyNoteViewState, undefined)
  })

  it('keeps identified note edits out of the legacy workspace-wide archive', () => {
    const card = createCard({ id: 'note-a', stickyNoteId: 'note-a', stickyNote: 'A0' })
    const state = createState({ 'note-a': card })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'note-a',
      patch: { stickyNote: 'A1' },
    })

    assert.equal(next.columns[0]?.cards['note-a']?.stickyNote, 'A1')
    assert.equal(next.stickyNoteArchive['D:/repo/one']?.content, '旧版单份存档')
  })

  it('assigns each card its own note identity when multiple cards switch to sticky notes', () => {
    const cardA = { ...createCard({ id: 'card-a', model: DEFAULT_CODEX_MODEL }), stickyNoteId: undefined }
    const cardB = { ...createCard({ id: 'card-b', model: DEFAULT_CODEX_MODEL }), stickyNoteId: undefined }
    const state = createState({ 'card-a': cardA, 'card-b': cardB })

    const first = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'card-a',
      provider: 'codex',
      model: STICKYNOTE_TOOL_MODEL,
    })
    const second = ideReducer(first, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'card-b',
      provider: 'codex',
      model: STICKYNOTE_TOOL_MODEL,
    })

    assert.equal(second.columns[0]?.cards['card-a']?.stickyNoteId, 'card-a')
    assert.equal(second.columns[0]?.cards['card-b']?.stickyNoteId, 'card-b')
  })

  it('stores content and reading position independently for multiple notes', () => {
    const noteA = createCard({ id: 'note-a', stickyNoteId: 'note-a', stickyNote: 'A' })
    const noteB = createCard({ id: 'note-b', stickyNoteId: 'note-b', stickyNote: 'B' })
    const state = createState({ 'note-a': noteA, 'note-b': noteB })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'note-a',
      patch: {
        stickyNote: 'A changed',
        stickyNoteViewState: { scrollTop: 120, selectionStart: 2, selectionEnd: 5 },
      },
    })

    assert.equal(next.columns[0]?.cards['note-a']?.stickyNote, 'A changed')
    assert.deepEqual(next.columns[0]?.cards['note-a']?.stickyNoteViewState, {
      scrollTop: 120,
      selectionStart: 2,
      selectionEnd: 5,
    })
    assert.equal(next.columns[0]?.cards['note-b']?.stickyNote, 'B')
    assert.equal(next.columns[0]?.cards['note-b']?.stickyNoteViewState, undefined)
  })
})

describe('sticky note controls', () => {
  it('shows image insertion, history, and local-location actions without any delete action', () => {
    const html = renderToStaticMarkup(
      React.createElement(StickyNoteCard, {
        content: '独立内容',
        workspacePath: 'D:/repo/one',
        noteId: 'note-a',
        title: '便签 A',
        language: 'zh-CN',
        onChange: () => {},
        onBindNote: () => {},
        onChangeTitle: () => {},
      }),
    )

    assert.match(html, /sticky-note-history-button/)
    assert.match(html, /sticky-note-location-button/)
    assert.match(html, /sticky-note-image-insert-button/)
    assert.match(html, /sticky-note-image-input/)
    assert.match(html, /sticky-note-search-input/)
    assert.match(html, /搜索便签/)
    assert.match(html, /插入图片/)
    assert.match(html, /历史版本/)
    assert.match(html, /打开本地位置/)
    assert.doesNotMatch(html, /sticky-note-discard-button/)
    assert.doesNotMatch(html, /删除记录|删除便签/)
  })
})
