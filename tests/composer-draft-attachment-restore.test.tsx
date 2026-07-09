import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import type { ChatCard as ChatCardModel, ImageAttachment } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { ChatCard } from '../src/components/ChatCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createCard = (draftAttachments: ImageAttachment[]): ChatCardModel => ({
  id: 'card-draft-attachment-restore',
  title: 'Feature Chat',
  status: 'idle',
  size: 560,
  provider: 'claude',
  model: 'claude-fable-5',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: '',
  draftAttachments,
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [],
})

const renderCard = (card: ChatCardModel) =>
  renderToStaticMarkup(
    <ChatCard
      card={card}
      providerReady={true}
      workspacePath="D:/workspace"
      language="en"
      systemPrompt={defaultSystemPrompt}
      modelPromptRules={[]}
      crossProviderSkillReuseEnabled={true}
      musicAlbumCoverEnabled={false}
      weatherCity=""
      gitAgentModel="gpt-5.5 low"
      brainstormRequestModel="gpt-5.5"
      availableQuickToolModels={[]}
      autoUrgeEnabled={false}
      globalUrgeActive={false}
      globalUrgeProfileId="auto-urge-default"
      autoUrgeMessage=""
      autoUrgeSuccessKeyword=""
      onSetAutoUrgeEnabled={() => undefined}
      onRemove={() => undefined}
      onSend={async (_prompt: string, _attachments: ImageAttachment[]) => undefined}
      onStop={async () => undefined}
      onDraftChange={() => undefined}
      onChangeModel={() => undefined}
      onChangeReasoningEffort={() => undefined}
      onTogglePlanMode={() => undefined}
      onToggleThinking={() => undefined}
      onToggleCollapsed={() => undefined}
      onMarkRead={() => undefined}
      onStickyNoteChange={() => undefined}
      onPatchCard={() => undefined}
      onChangeTitle={() => undefined}
      isRestored={false}
    />,
  )

test('a remounted composer restores pasted-image thumbnails from card.draftAttachments', () => {
  const markup = renderCard(
    createCard([
      { id: 'att-restored', fileName: 'screenshot.png', mimeType: 'image/png', sizeBytes: 2048 },
    ]),
  )

  assert.match(markup, /composer-attachment-list/)
  assert.match(markup, /composer-attachment-item/)
  assert.match(markup, /att-restored/)
})

test('a composer without draft attachments renders no attachment list', () => {
  assert.doesNotMatch(renderCard(createCard([])), /composer-attachment-list/)
})
