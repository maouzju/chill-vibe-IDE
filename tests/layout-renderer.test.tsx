import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createPane, createSplit } from '../shared/default-state.ts'
import type { BoardColumn, ProviderStatus } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { LayoutRenderer } from '../src/components/LayoutRenderer.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createColumn = (): BoardColumn => {
  const leftPane = createPane(['card-1'], 'card-1', 'pane-left')
  const rightPane = createPane(['card-2'], 'card-2', 'pane-right')

  return {
    id: 'column-1',
    title: 'Workspace 1',
    provider: 'codex',
    workspacePath: 'd:\\Git\\chill-vibe',
    model: 'gpt-5.4',
    layout: createSplit('horizontal', [leftPane, rightPane], [0.5, 0.5], 'split-1'),
    cards: {
      'card-1': {
        id: 'card-1',
        title: 'Left tab',
        status: 'idle',
        size: 560,
        provider: 'codex',
        model: 'gpt-5.4',
        reasoningEffort: 'medium',
        thinkingEnabled: true,
        planMode: false,
        autoUrgeActive: false,
        autoUrgeProfileId: 'auto-urge-default',
        collapsed: false,
        unread: false,
        draft: '',
        draftAttachments: [],
        stickyNote: '',
        brainstorm: {
          prompt: '',
          provider: 'codex',
          model: 'gpt-5.4',
          answerCount: 6,
          answers: [],
          failedAnswers: [],
        },
        providerSessions: {},
        messages: [],
      },
      'card-2': {
        id: 'card-2',
        title: 'Right tab',
        status: 'idle',
        size: 560,
        provider: 'codex',
        model: 'gpt-5.4',
        reasoningEffort: 'medium',
        thinkingEnabled: true,
        planMode: false,
        autoUrgeActive: false,
        autoUrgeProfileId: 'auto-urge-default',
        collapsed: false,
        unread: false,
        draft: '',
        draftAttachments: [],
        stickyNote: '',
        brainstorm: {
          prompt: '',
          provider: 'codex',
          model: 'gpt-5.4',
          answerCount: 6,
          answers: [],
          failedAnswers: [],
        },
        providerSessions: {},
        messages: [],
      },
    },
  }
}

const renderLayout = () => {
  const column = createColumn()

  return renderToStaticMarkup(
    <LayoutRenderer
      column={column}
      node={column.layout}
      providers={{} as Record<string, ProviderStatus>}
      language="en"
      systemPrompt={defaultSystemPrompt}
      crossProviderSkillReuseEnabled={true}
      musicAlbumCoverEnabled={false}
      weatherCity=""
      gitAgentModel="gpt-5.4 low"
      brainstormRequestModel="gpt-5.4"
      availableQuickToolModels={[]}
      autoUrgeEnabled={false}
      autoUrgeMessage=""
      autoUrgeSuccessKeyword=""
      onSetAutoUrgeEnabled={() => undefined}
      flashCardIds={new Set()}
      onRestoredAnimationEnd={() => undefined}
      onAddTab={() => undefined}
      onSplitPane={() => undefined}
      onSplitMoveTab={() => undefined}
      onCloseTab={() => undefined}
      onMoveTab={() => undefined}
      onReorderTab={() => undefined}
      onSetActiveTab={() => undefined}
      onResizePane={() => undefined}
      onActivatePane={() => undefined}
      onChangeCardModel={() => undefined}
      onChangeCardReasoningEffort={() => undefined}
      onToggleCardPlanMode={() => undefined}
      onToggleCardThinking={() => undefined}
      onToggleCardCollapsed={() => undefined}
      onMarkCardRead={() => undefined}
      onChangeCardDraft={() => undefined}
      onChangeCardStickyNote={() => undefined}
      onPatchCard={() => undefined}
      onChangeCardTitle={() => undefined}
      onSendMessage={async () => undefined}
      onStopMessage={async () => undefined}
    />,
  )
}

test('renders split resize handles between sibling panes', () => {
  const markup = renderLayout()

  assert.match(
    markup,
    /class="split-child"[^>]*>[\s\S]*?<\/div><div class="split-resize-handle is-horizontal"[\s\S]*?<\/div><div class="split-child"/,
  )
})
