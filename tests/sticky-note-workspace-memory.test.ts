import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultSettings } from '../shared/default-state.ts'
import { StickyNoteCard } from '../src/components/StickyNoteCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const { createElement } = React
import { DEFAULT_CODEX_MODEL, STICKYNOTE_TOOL_MODEL, TEXTEDITOR_TOOL_MODEL } from '../shared/models.ts'
import { appStateSchema, defaultAutoUrgeProfileId } from '../shared/schema.ts'
import type { AppState, BoardColumn, ChatCard, PaneNode } from '../shared/schema.ts'
import { ideReducer } from '../src/state.ts'

const timestamp = '2026-04-04T12:00:00.000Z'

const createCard = (overrides: Partial<ChatCard> = {}): ChatCard => ({
  id: overrides.id ?? 'card-1',
  title: overrides.title ?? 'Note',
  providerSessions: {},
  status: 'idle',
  provider: 'codex',
  model: overrides.model ?? STICKYNOTE_TOOL_MODEL,
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: defaultAutoUrgeProfileId,
  collapsed: false,
  unread: false,
  draft: '',
  stickyNote: overrides.stickyNote ?? '',
  draftAttachments: [],
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

const createPane = (id: string, tabs: string[]): PaneNode => ({
  type: 'pane',
  id,
  tabs,
  activeTabId: tabs[0] ?? '',
})

const createColumn = (overrides: Partial<BoardColumn> = {}): BoardColumn => {
  const cards = overrides.cards ?? {
    'card-1': createCard(),
  }

  return {
    id: overrides.id ?? 'column-1',
    title: overrides.title ?? 'Workspace 1',
    provider: overrides.provider ?? 'codex',
    workspacePath: overrides.workspacePath ?? 'D:/repo/one',
    model: overrides.model ?? DEFAULT_CODEX_MODEL,
    layout: overrides.layout ?? createPane('pane-1', Object.keys(cards)),
    cards,
  }
}

const createState = (overrides: Partial<AppState> = {}): AppState => ({
  version: 1,
  updatedAt: timestamp,
  settings: createDefaultSettings(),
  columns: overrides.columns ?? [createColumn()],
  sessionHistory: [],
  stickyNoteArchive: overrides.stickyNoteArchive ?? {},
})

describe('sticky note workspace memory', () => {
  it('parses legacy state without stickyNoteArchive into an empty archive', () => {
    const legacy = {
      version: 1,
      updatedAt: timestamp,
      settings: createDefaultSettings(),
      columns: [],
      sessionHistory: [],
    }

    const parsed = appStateSchema.parse(legacy)
    assert.deepEqual(parsed.stickyNoteArchive, {})
  })

  it('mirrors sticky note edits into the workspace archive', () => {
    const state = createState()

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: { stickyNote: '买牛奶\n回邮件' },
    })

    assert.equal(next.stickyNoteArchive['D:/repo/one']?.content, '买牛奶\n回邮件')
  })

  it('remembers the sticky note scroll and cursor position for the workspace', () => {
    const state = createState({
      stickyNoteArchive: {
        'D:/repo/one': { content: 'line 1\nline 2\nline 3', updatedAt: timestamp },
      },
    })

    const next = ideReducer(state, {
      type: 'updateStickyNoteViewState',
      workspacePath: 'D:/repo/one',
      viewState: { scrollTop: 128, selectionStart: 9, selectionEnd: 15 },
    })

    assert.deepEqual(next.stickyNoteArchive['D:/repo/one']?.viewState, {
      scrollTop: 128,
      selectionStart: 9,
      selectionEnd: 15,
    })
    assert.equal(next.stickyNoteArchive['D:/repo/one']?.content, 'line 1\nline 2\nline 3')
  })

  it('keeps the remembered view position when note content is updated', () => {
    const state = createState({
      stickyNoteArchive: {
        'D:/repo/one': {
          content: 'old',
          updatedAt: timestamp,
          viewState: { scrollTop: 72, selectionStart: 2, selectionEnd: 2 },
        },
      },
    })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: { stickyNote: 'new content' },
    })

    assert.deepEqual(next.stickyNoteArchive['D:/repo/one']?.viewState, {
      scrollTop: 72,
      selectionStart: 2,
      selectionEnd: 2,
    })
  })

  it('does not archive stickyNote patches for non-sticky tool cards', () => {
    const state = createState({
      columns: [
        createColumn({
          cards: { 'card-1': createCard({ model: TEXTEDITOR_TOOL_MODEL }) },
        }),
      ],
    })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: { stickyNote: 'src/App.tsx' },
    })

    assert.equal(next.stickyNoteArchive['D:/repo/one'], undefined)
  })

  it('does not archive when the column has no workspace path', () => {
    const state = createState({
      columns: [createColumn({ workspacePath: '' })],
    })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: { stickyNote: 'hello' },
    })

    assert.deepEqual(next.stickyNoteArchive, {})
  })

  it('removes the archive entry when the sticky note is cleared', () => {
    const state = createState({
      columns: [createColumn({ cards: { 'card-1': createCard({ stickyNote: 'old' }) } })],
      stickyNoteArchive: {
        'D:/repo/one': { content: 'old', updatedAt: timestamp },
      },
    })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: { stickyNote: '' },
    })

    assert.equal(next.stickyNoteArchive['D:/repo/one'], undefined)
  })

  it('clearStickyNoteArchive removes the entry for the workspace', () => {
    const state = createState({
      stickyNoteArchive: {
        'D:/repo/one': { content: 'old', updatedAt: timestamp },
        'D:/repo/two': { content: 'keep', updatedAt: timestamp },
      },
    })

    const next = ideReducer(state, {
      type: 'clearStickyNoteArchive',
      workspacePath: 'D:/repo/one',
    })

    assert.equal(next.stickyNoteArchive['D:/repo/one'], undefined)
    assert.equal(next.stickyNoteArchive['D:/repo/two']?.content, 'keep')
  })

  it('evicts the oldest entries beyond the archive cap', () => {
    const archive: AppState['stickyNoteArchive'] = {}
    for (let index = 0; index < 50; index += 1) {
      archive[`D:/repo/filler-${index}`] = {
        content: `note ${index}`,
        // filler-0 is the oldest entry
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      }
    }

    const state = createState({ stickyNoteArchive: archive })

    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'card-1',
      patch: { stickyNote: 'newest note' },
    })

    assert.equal(next.stickyNoteArchive['D:/repo/one']?.content, 'newest note')
    assert.equal(next.stickyNoteArchive['D:/repo/filler-0'], undefined)
    assert.equal(next.stickyNoteArchive['D:/repo/filler-1']?.content, 'note 1')
    assert.equal(Object.keys(next.stickyNoteArchive).length, 50)
  })
})

describe('sticky note restore entry', () => {
  const render = (content: string, archivedContent: string) =>
    renderToStaticMarkup(
      createElement(StickyNoteCard, {
        content,
        archivedContent,
        language: 'zh-CN',
        onChange: () => {},
        onDiscardArchive: () => {},
      }),
    )

  it('shows the restore bar when the note is empty and an archive exists', () => {
    const html = render('', '旧的便签内容\n第二行')
    assert.ok(html.includes('sticky-note-restore-bar'))
    assert.ok(html.includes('旧的便签内容'), 'should preview the archived first line')
    assert.ok(!html.includes('第二行'), 'preview should stay on the first line')
  })

  it('hides the restore bar when the note already has content', () => {
    const html = render('正在写', '旧的便签内容')
    assert.ok(!html.includes('sticky-note-restore-bar'))
  })

  it('hides the restore bar when there is no archive', () => {
    const html = render('', '')
    assert.ok(!html.includes('sticky-note-restore-bar'))
  })
})
