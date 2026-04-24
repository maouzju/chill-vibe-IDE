import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import { createPane } from '../shared/default-state.ts'
import type { BoardColumn, ProviderStatus, ChatCard, PaneNode } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { PaneView } from '../src/components/PaneView.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createColumn = (overrides: Partial<BoardColumn> = {}): BoardColumn => ({
  id: overrides.id ?? 'column-1',
  title: overrides.title ?? 'Workspace 1',
  provider: overrides.provider ?? 'codex',
  workspacePath: overrides.workspacePath ?? '',
  model: overrides.model ?? 'gpt-5.5',
  width: overrides.width,
  cards: overrides.cards ?? {},
  layout: overrides.layout ?? createPane(
    Object.keys(overrides.cards ?? {}),
    Object.keys(overrides.cards ?? {})[0] ?? '',
    'pane-1',
  ),
})

const createMarkup = (column: BoardColumn) =>
  renderToStaticMarkup(
    React.createElement(PaneView, {
      column,
      pane: column.layout as PaneNode,
      providers: {} as Record<string, ProviderStatus>,
      language: 'en',
      systemPrompt: defaultSystemPrompt,
      crossProviderSkillReuseEnabled: true,
      musicAlbumCoverEnabled: false,
      weatherCity: '',
      gitAgentModel: 'gpt-5.5 low',
      brainstormRequestModel: 'gpt-5.5',
      availableQuickToolModels: [],
      autoUrgeEnabled: false,
      autoUrgeMessage: '',
      autoUrgeSuccessKeyword: '',
      onSetAutoUrgeEnabled: () => {},
      flashCardIds: new Set<string>(),
      onRestoredAnimationEnd: () => {},
      onAddTab: () => {},
      onSplitPane: () => {},
      onSplitMoveTab: () => {},
      onCloseTab: () => {},
      onMoveTab: () => {},
      onReorderTab: () => {},
      onSetActiveTab: () => {},
      onActivatePane: () => {},
      onChangeCardModel: () => {},
      onChangeCardReasoningEffort: () => {},
      onToggleCardPlanMode: () => {},
      onToggleCardThinking: () => {},
      onToggleCardCollapsed: () => {},
      onMarkCardRead: () => {},
      onChangeCardDraft: () => {},
      onChangeCardStickyNote: () => {},
      onPatchCard: () => {},
      onChangeCardTitle: () => {},
      onSendMessage: async () => {},
      onStopMessage: async () => {},
    }),
  )

describe('PaneView tab state preservation', () => {
  it('renders all tab cards inside stable pane panels while hiding inactive tabs', () => {
    const card1: ChatCard = {
      id: 'card-1',
      title: 'Chat 1',
      status: 'idle',
      size: 560,
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      thinkingEnabled: false,
      planMode: false,
      autoUrgeActive: false,
      autoUrgeProfileId: 'auto-urge-default',
      collapsed: false,
      unread: false,
      draft: '',
      draftAttachments: [],
      stickyNote: '',
      brainstorm: createDefaultBrainstormState(),
      providerSessions: {},
      messages: [],
    }
    const card2: ChatCard = { ...card1, id: 'card-2', title: 'Chat 2' }
    const card3: ChatCard = { ...card1, id: 'card-3', title: 'Chat 3' }

    const column = createColumn({
      cards: {
        'card-1': card1,
        'card-2': card2,
        'card-3': card3,
      },
    })

    const markup = createMarkup(column)

    assert.match(markup, /Chat 1/, 'card-1 should be in markup')
    assert.match(markup, /Chat 2/, 'card-2 should be in markup')
    assert.match(markup, /Chat 3/, 'card-3 should be in markup')

    const panePanelCount = (markup.match(/class="pane-tab-panel/g) ?? []).length
    assert.equal(panePanelCount, 3, 'each tab should render inside its own pane panel')

    assert.match(
      markup,
      /class="pane-tab-panel is-active"/,
      'active tab should keep a dedicated pane panel instead of display:contents',
    )

    const hiddenPanelCount = (markup.match(/class="pane-tab-panel" hidden=""/g) ?? []).length
    assert.equal(hiddenPanelCount, 2, 'inactive tab panels should stay mounted but hidden')
    assert.doesNotMatch(markup, /display:\s*contents/, 'pane panels should preserve a layout box')
  })

  it('keeps inactive pane tabs mounted without rendering their full transcript DOM', () => {
    const activeCard: ChatCard = {
      id: 'card-1',
      title: 'Active Chat',
      status: 'idle',
      size: 560,
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      thinkingEnabled: false,
      planMode: false,
      autoUrgeActive: false,
      autoUrgeProfileId: 'auto-urge-default',
      collapsed: false,
      unread: false,
      draft: '',
      draftAttachments: [],
      stickyNote: '',
      brainstorm: createDefaultBrainstormState(),
      providerSessions: {},
      messages: [
        {
          id: 'active-msg-1',
          role: 'user',
          content: 'Visible transcript content',
          createdAt: '2026-04-12T01:00:00.000Z',
        },
      ],
    }
    const backgroundCard: ChatCard = {
      ...activeCard,
      id: 'card-2',
      title: 'Background Chat',
      draft: 'background draft',
      messages: [
        {
          id: 'background-msg-1',
          role: 'assistant',
          content: 'Hidden transcript should stay out of the DOM',
          createdAt: '2026-04-12T01:00:01.000Z',
        },
      ],
    }

    const column = createColumn({
      cards: {
        'card-1': activeCard,
        'card-2': backgroundCard,
      },
    })

    const markup = createMarkup(column)

    assert.match(markup, /Active Chat/, 'active tab title should still be rendered')
    assert.match(markup, /Background Chat/, 'inactive tab title should still stay in the pane chrome')
    assert.match(markup, /Visible transcript content/, 'active transcript content should stay rendered')
    assert.doesNotMatch(
      markup,
      /Hidden transcript should stay out of the DOM/,
      'inactive tab transcript content should not stay mounted',
    )

    const messageListCount = (markup.match(/class="message-list/g) ?? []).length
    assert.equal(messageListCount, 1, 'only the active tab should render a transcript shell')

    const textareaCount = (markup.match(/<textarea/g) ?? []).length
    assert.equal(textareaCount, 1, 'only the active tab should keep a mounted composer textarea')
  })

  it('does not keep inactive chat card shells mounted after tab switches', () => {
    const activeCard: ChatCard = {
      id: 'card-1',
      title: 'Active Chat',
      status: 'idle',
      size: 560,
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      thinkingEnabled: false,
      planMode: false,
      autoUrgeActive: false,
      autoUrgeProfileId: 'auto-urge-default',
      collapsed: false,
      unread: false,
      draft: '',
      draftAttachments: [],
      stickyNote: '',
      brainstorm: createDefaultBrainstormState(),
      providerSessions: {},
      messages: [],
    }
    const backgroundCard: ChatCard = {
      ...activeCard,
      id: 'card-2',
      title: 'Background Chat',
      draft: 'unsaved draft',
      messages: [
        {
          id: 'background-msg-1',
          role: 'assistant',
          content: 'Background transcript',
          createdAt: '2026-04-12T01:00:01.000Z',
        },
      ],
    }

    const column = createColumn({
      cards: {
        'card-1': activeCard,
        'card-2': backgroundCard,
      },
    })

    const markup = createMarkup(column)
    const cardShellCount = (markup.match(/class="card-shell/g) ?? []).length

    assert.equal(cardShellCount, 1, 'only the active tab should keep a full card shell mounted')
  })

  it('renders a single active pane panel with no hidden siblings', () => {
    const card: ChatCard = {
      id: 'card-1',
      title: 'Only Chat',
      status: 'idle',
      size: 560,
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      thinkingEnabled: false,
      planMode: false,
      autoUrgeActive: false,
      autoUrgeProfileId: 'auto-urge-default',
      collapsed: false,
      unread: false,
      draft: '',
      draftAttachments: [],
      stickyNote: '',
      brainstorm: createDefaultBrainstormState(),
      providerSessions: {},
      messages: [],
    }

    const column = createColumn({ cards: { 'card-1': card } })
    const markup = createMarkup(column)

    assert.match(markup, /Only Chat/, 'single card should be in markup')
    assert.match(markup, /class="pane-tab-panel is-active"/, 'single tab should render as the active pane panel')
    assert.doesNotMatch(markup, /hidden=""/, 'single-tab pane should not render hidden siblings')
    assert.doesNotMatch(markup, /display:\s*contents/, 'single-tab pane should still preserve layout wrappers')
  })

  it('renders empty pane when no tab cards exist', () => {
    const column = createColumn({ cards: {} })
    column.layout = { ...(column.layout as PaneNode), tabs: [], activeTabId: '' }

    const markup = createMarkup(column)

    assert.match(markup, /empty-pane/, 'should render empty pane')
    assert.doesNotMatch(markup, /card-shell/, 'no cards should be in markup')
  })

  it('keeps streaming tabs draggable so they can be rearranged within the workspace', () => {
    const streamingCard: ChatCard = {
      id: 'card-1',
      title: 'Running Agent',
      status: 'streaming',
      size: 560,
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      thinkingEnabled: false,
      planMode: false,
      autoUrgeActive: false,
      autoUrgeProfileId: 'auto-urge-default',
      collapsed: false,
      unread: false,
      draft: '',
      draftAttachments: [],
      stickyNote: '',
      brainstorm: createDefaultBrainstormState(),
      providerSessions: {},
      messages: [],
    }

    const column = createColumn({ cards: { 'card-1': streamingCard } })
    const markup = createMarkup(column)

    assert.match(
      markup,
      /class="pane-tab[^"]*is-active[^"]*is-streaming[^"]*"[^>]*title="Running Agent"[^>]*draggable="true"/,
      'streaming pane tabs should remain draggable',
    )
  })
})
