import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import type { ChatCard as ChatCardModel, ImageAttachment } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { ChatCard } from '../src/components/ChatCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createCard = (): ChatCardModel => ({
  id: 'card-cli-unavailable',
  title: 'Feature Chat',
  status: 'idle',
  size: 560,
  provider: 'codex',
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  thinkingEnabled: true,
  planMode: false,
  autoUrgeActive: false,
  autoUrgeProfileId: 'auto-urge-default',
  collapsed: false,
  unread: false,
  draft: 'Please help with this task',
  draftAttachments: [],
  stickyNote: '',
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [],
})

test('chat composer keeps send clickable when the provider CLI is unavailable so App can append a visible hint', () => {
  const markup = renderToStaticMarkup(
    <ChatCard
      card={createCard()}
      providerReady={false}
      workspacePath="D:\\Git\\chill-vibe"
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
      onRestoredAnimationEnd={() => undefined}
    />,
  )

  assert.match(markup, /placeholder="CLI unavailable"/)
  assert.match(markup, /aria-label="Send message"/)
  assert.doesNotMatch(markup, /aria-label="Send message"[^>]*disabled/)
})

test('running chat composer exposes a send-later hover hint and queued-send controls', () => {
  const markup = renderToStaticMarkup(
    <ChatCard
      card={{
        ...createCard(),
        status: 'streaming',
        streamId: 'stream-1',
        draft: 'Please queue this',
      }}
      providerReady={true}
      workspacePath="D:\\Git\\chill-vibe"
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
      autoUrgeMessage=""
      autoUrgeSuccessKeyword=""
      queuedSendSummary={{
        count: 1,
        nextPreview: 'Queued follow-up',
        nextAttachmentCount: 0,
      }}
      onSetAutoUrgeEnabled={() => undefined}
      onRemove={() => undefined}
      onSend={async (_prompt: string, _attachments: ImageAttachment[]) => undefined}
      onStop={async () => undefined}
      onCancelQueuedSends={() => undefined}
      onSendNextQueuedNow={() => undefined}
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
      onRestoredAnimationEnd={() => undefined}
    />,
  )

  assert.match(markup, /aria-label="Send later"/)
  assert.match(markup, /Click or right-click to queue this message for after the current answer\./)
  assert.match(markup, /1 queued: Queued follow-up/)
  assert.match(markup, />Send now</)
  assert.match(markup, />Cancel</)
})
