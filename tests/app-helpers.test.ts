import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createStructuredActivityMessage,
  finalizeStructuredActivityMessage,
  finalizeStreamedAssistantMessage,
  getAgentDoneSoundUrl,
  getColumnById,
} from '../src/app-helpers.ts'

test('agent-done sound URL respects the active base path', () => {
  assert.equal(getAgentDoneSoundUrl('/'), '/agent-done.wav')
  assert.equal(getAgentDoneSoundUrl('./'), './agent-done.wav')
  assert.equal(getAgentDoneSoundUrl('/chill-vibe/'), '/chill-vibe/agent-done.wav')
})

test('getColumnById resolves a board column by its id', () => {
  const columns = [
    { id: 'column-1', title: 'One' },
    { id: 'column-2', title: 'Two' },
  ]

  assert.equal(getColumnById(columns, 'column-2')?.id, 'column-2')
  assert.equal(getColumnById(columns, 'missing'), undefined)
})

test('ask-user activities reuse a stable message id within the same stream', () => {
  const first = createStructuredActivityMessage('claude', 'stream-1', {
    itemId: 'tooluse_first',
    kind: 'ask-user',
    status: 'completed',
    question: 'Which direction should we take?',
    header: 'Clarify scope',
    multiSelect: false,
    options: [
      { label: 'Option A', description: 'Keep the current layout.' },
      { label: 'Option B', description: 'Switch to a VSCode-like layout.' },
    ],
  })

  const second = createStructuredActivityMessage('claude', 'stream-1', {
    itemId: 'tooluse_second',
    kind: 'ask-user',
    status: 'completed',
    question: 'Which direction should we take?',
    header: 'Clarify scope',
    multiSelect: false,
    options: [
      { label: 'Option A', description: 'Keep the current layout.' },
      { label: 'Option B', description: 'Switch to a VSCode-like layout.' },
    ],
  })

  const planApproval = createStructuredActivityMessage('claude', 'stream-1', {
    itemId: 'tooluse_plan',
    kind: 'ask-user',
    status: 'completed',
    question: 'Plan is ready for review',
    header: 'Plan approval',
    multiSelect: false,
    options: [
      { label: 'Approve plan', description: '' },
      { label: 'Reject plan', description: '' },
    ],
    planFile: 'C:/Users/demo/.claude/plans/test.md',
  })

  assert.equal(first.id, second.id)
  assert.notEqual(first.id, planApproval.id)
})

test('todo activities reuse a stable message id within the same stream', () => {
  const first = createStructuredActivityMessage('claude', 'stream-1', {
    itemId: 'tooluse_todo_1',
    kind: 'todo',
    status: 'completed',
    items: [
      {
        id: 'todo-1',
        content: 'Inspect the provider stream',
        status: 'completed',
      },
      {
        id: 'todo-2',
        content: 'Render a VS Code-like task list',
        activeForm: 'Rendering a VS Code-like task list',
        status: 'in_progress',
      },
    ],
  })

  const second = createStructuredActivityMessage('claude', 'stream-1', {
    itemId: 'tooluse_todo_2',
    kind: 'todo',
    status: 'completed',
    items: [
      {
        id: 'todo-1',
        content: 'Inspect the provider stream',
        status: 'completed',
      },
      {
        id: 'todo-2',
        content: 'Render a VS Code-like task list',
        status: 'completed',
      },
    ],
  })

  assert.equal(first.id, second.id)
})

test('finalizeStreamedAssistantMessage replaces the live streamed bubble in place', () => {
  const existingMessages = [
    {
      id: 'assistant-live-1',
      role: 'assistant' as const,
      content: 'First paragraph Second paragraph',
      createdAt: '2026-04-13T00:00:00.000Z',
      meta: {
        provider: 'codex' as const,
      },
    },
  ]

  const nextMessages = finalizeStreamedAssistantMessage(
    existingMessages,
    'assistant-live-1',
    'codex',
    'stream-1',
    {
      itemId: 'assistant-item-1',
      content: 'First paragraph\n\nSecond paragraph',
    },
  )

  assert.equal(nextMessages.length, 1)
  assert.equal(nextMessages[0]?.id, 'assistant-live-1')
  assert.equal(nextMessages[0]?.content, 'First paragraph\n\nSecond paragraph')
  assert.equal(nextMessages[0]?.meta?.provider, 'codex')
  assert.equal(nextMessages[0]?.meta?.itemId, 'assistant-item-1')
})

test('finalizeStructuredActivityMessage replaces a live ask-user XML bubble with the structured card', () => {
  const existingMessages = [
    {
      id: 'assistant-live-1',
      role: 'assistant' as const,
      content:
        '<ask-user-question>{"header":"Confirmation","question":"Which path should I use?","multiSelect":false,"options":[{"label":"Delete normally","description":"Delete only the current skill."},{"label":"Check impact first","description":"Inspect remotes and refs before deciding."}]}</ask-user-question>',
      createdAt: '2026-04-16T00:00:00.000Z',
      meta: {
        provider: 'codex' as const,
      },
    },
  ]

  const nextMessages = finalizeStructuredActivityMessage(
    existingMessages,
    'assistant-live-1',
    'codex',
    'stream-1',
    {
      itemId: 'agent_message_1',
      kind: 'ask-user',
      status: 'completed',
      header: 'Confirmation',
      question: 'Which path should I use?',
      multiSelect: false,
      options: [
        {
          label: 'Delete normally',
          description: 'Delete only the current skill.',
        },
        {
          label: 'Check impact first',
          description: 'Inspect remotes and refs before deciding.',
        },
      ],
    },
  )

  assert.equal(nextMessages.length, 1)
  assert.equal(nextMessages[0]?.id, 'codex:stream-1:item:ask-user:question')
  assert.equal(nextMessages[0]?.content, '')
  assert.equal(nextMessages[0]?.createdAt, '2026-04-16T00:00:00.000Z')
  assert.equal(nextMessages[0]?.meta?.kind, 'ask-user')
  assert.equal(nextMessages[0]?.meta?.itemId, 'agent_message_1')
  assert.match(nextMessages[0]?.meta?.structuredData ?? '', /Which path should I use\?/)
})
