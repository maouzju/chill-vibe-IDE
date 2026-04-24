import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createDefaultBrainstormState } from '../shared/brainstorm.ts'
import { TEXTEDITOR_TOOL_MODEL } from '../shared/models.ts'
import type { ChatCard as ChatCardModel, ImageAttachment } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { ChatCard } from '../src/components/ChatCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createCard = (): ChatCardModel => ({
  id: 'card-editor-empty',
  title: 'Editor',
  status: 'idle',
  size: 560,
  provider: 'codex',
  model: TEXTEDITOR_TOOL_MODEL,
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
  brainstorm: createDefaultBrainstormState(),
  providerSessions: {},
  messages: [],
})

test('text editor cards without a file show a usable empty state instead of a blank shell', () => {
  const markup = renderToStaticMarkup(
    <ChatCard
      card={createCard()}
      providerReady={true}
      workspacePath="d:\\Git\\chill-vibe"
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

  assert.match(markup, /text-editor-empty/)
  assert.match(markup, /Open a file to start editing\./)
  assert.match(markup, /Use Files or a generated plan result to open one here\./)
})
