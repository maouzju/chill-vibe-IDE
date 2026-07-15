import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canSendEmptyContinuation,
  createStoppedRunMessage,
  createStructuredActivityMessage,
  createStructuredMessageId,
  finalizeStructuredActivityMessage,
  finalizeStreamedAssistantMessage,
  getAgentDoneSoundUrl,
  getColumnById,
  getResumeSessionIdForModel,
  resolveStreamedAssistantMessageTarget,
} from '../src/app-helpers.ts'
import type { ChatMessage } from '../shared/schema.ts'

const makeMessage = (role: ChatMessage['role'], content = ''): ChatMessage => ({
  id: `msg-${role}-${content || 'empty'}`,
  role,
  content,
  createdAt: '2026-06-28T00:00:00.000Z',
})

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

test('getResumeSessionIdForModel refuses model-unknown sessions when the requested model is explicit', () => {
  assert.equal(
    getResumeSessionIdForModel(
      { sessionId: 'legacy-session-without-model', sessionModel: undefined },
      'claude-opus-4-8',
    ),
    undefined,
  )
})

test('getResumeSessionIdForModel returns the native session only for the matching model', () => {
  assert.equal(
    getResumeSessionIdForModel(
      { sessionId: 'claude-session-opus-48', sessionModel: 'claude-opus-4-8' },
      'claude-opus-4-8',
    ),
    'claude-session-opus-48',
  )
  assert.equal(
    getResumeSessionIdForModel(
      { sessionId: 'claude-session-opus-47', sessionModel: 'claude-opus-4-7' },
      'claude-opus-4-8',
    ),
    undefined,
  )
})

test('createStructuredMessageId gives assistant snapshots a stable stream item id', () => {
  assert.equal(
    createStructuredMessageId('claude', 'stream-1', 'assistant-item-1'),
    'claude:stream-1:item:assistant-item-1',
  )
})

test('Codex deltas reuse one message target when command activity interrupts the same item', () => {
  const first = resolveStreamedAssistantMessageTarget({
    messages: [],
    provider: 'codex',
    streamId: 'stream-1',
    itemId: 'assistant-item-1',
    model: 'gpt-5.6-sol',
  })

  assert.equal(first.messageId, 'codex:stream-1:item:assistant-item-1')
  assert.equal(first.assistantItemId, 'assistant-item-1')
  assert.equal(first.messageToAppend?.meta?.itemId, 'assistant-item-1')

  const interruptedMessages: ChatMessage[] = [
    {
      ...first.messageToAppend!,
      content: '用 Demo 两天完成',
    },
    {
      id: 'codex:stream-1:item:command-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-07-15T02:30:02.304Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        itemId: 'command-1',
      },
    },
  ]

  const resumed = resolveStreamedAssistantMessageTarget({
    messages: interruptedMessages,
    provider: 'codex',
    streamId: 'stream-1',
    itemId: 'assistant-item-1',
    model: 'gpt-5.6-sol',
  })

  assert.equal(resumed.messageId, first.messageId)
  assert.equal(resumed.messageToAppend, undefined)

  const finalized = finalizeStreamedAssistantMessage(
    interruptedMessages,
    resumed.messageId,
    'codex',
    'stream-1',
    {
      itemId: 'assistant-item-1',
      content: '用 Demo 两天完成，项目几个月收不了尾。',
    },
    'gpt-5.6-sol',
  )
  assert.equal(finalized.filter((message) => message.meta?.itemId === 'assistant-item-1').length, 1)
  assert.equal(finalized[0]?.content, '用 Demo 两天完成，项目几个月收不了尾。')
})

test('a new Codex item cannot append into the previous completed assistant message', () => {
  const previousMessageId = createStructuredMessageId('codex', 'stream-1', 'assistant-item-1')
  const target = resolveStreamedAssistantMessageTarget({
    messages: [
      {
        id: previousMessageId,
        role: 'assistant',
        content: 'Previous sub-agent report',
        createdAt: '2026-07-15T02:29:52.588Z',
        meta: {
          provider: 'codex',
          itemId: 'assistant-item-1',
        },
      },
    ],
    provider: 'codex',
    streamId: 'stream-1',
    itemId: 'assistant-item-2',
    activeMessageId: previousMessageId,
    activeItemId: 'assistant-item-1',
  })

  assert.equal(target.messageId, 'codex:stream-1:item:assistant-item-2')
  assert.notEqual(target.messageId, previousMessageId)
  assert.equal(target.messageToAppend?.meta?.itemId, 'assistant-item-2')
})

test('createStoppedRunMessage uses the user-interrupted copy for follow-up interrupts', () => {
  const interrupted = createStoppedRunMessage('zh-CN', 'user-interrupt')
  const stopped = createStoppedRunMessage('zh-CN')

  assert.equal(interrupted.role, 'system')
  assert.equal(interrupted.content, '用户打断')
  assert.equal(interrupted.meta?.kind, 'run-stopped')
  assert.equal(interrupted.meta?.stopReason, 'user-interrupt')
  assert.equal(stopped.content, '这次运行已停止。')
  assert.equal(stopped.meta?.stopReason, 'manual')
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

test('finalizeStreamedAssistantMessage records the requested model on assistant output', () => {
  const nextMessages = finalizeStreamedAssistantMessage(
    [
      {
        id: 'assistant-live-1',
        role: 'assistant' as const,
        content: 'Old text',
        createdAt: '2026-05-29T00:00:00.000Z',
        meta: {
          provider: 'claude' as const,
        },
      },
    ],
    'assistant-live-1',
    'claude',
    'stream-1',
    {
      itemId: 'assistant-item-1',
      content: '我是 Claude Opus 4.7。',
    },
    'claude-opus-4-8',
  )

  assert.equal(nextMessages[0]?.meta?.model, 'claude-opus-4-8')
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

test('finalizeStructuredActivityMessage keeps a live assistant text bubble when an ask-user activity arrives alongside it', () => {
  const existingMessages = [
    {
      id: 'assistant-live-2',
      role: 'assistant' as const,
      content: '好的，我先帮你确认一下方向。',
      createdAt: '2026-04-16T00:00:00.000Z',
      meta: {
        provider: 'claude' as const,
      },
    },
  ]

  const nextMessages = finalizeStructuredActivityMessage(
    existingMessages,
    'assistant-live-2',
    'claude',
    'stream-2',
    {
      itemId: 'tooluse_ask_1',
      kind: 'ask-user',
      status: 'completed',
      header: 'Confirmation',
      question: 'Which path should I use?',
      multiSelect: false,
      options: [
        { label: 'Option A', description: 'Keep current approach.' },
        { label: 'Option B', description: 'Try a new approach.' },
      ],
    },
  )

  assert.equal(nextMessages.length, 2)
  assert.equal(nextMessages[0]?.id, 'assistant-live-2')
  assert.equal(nextMessages[0]?.content, '好的，我先帮你确认一下方向。')
  assert.equal(nextMessages[1]?.id, 'claude:stream-2:item:ask-user:question')
  assert.equal(nextMessages[1]?.meta?.kind, 'ask-user')
})

test('finalizeStructuredActivityMessage keeps Claude prose before an ask-user tool even when XML appears later', () => {
  const existingMessages = [
    {
      id: 'assistant-live-3',
      role: 'assistant' as const,
      content:
        'I reviewed the previous work and found the risky path.\n\n<ask-user-question>{"header":"Confirmation","question":"Which path should I use?","multiSelect":false,"options":[{"label":"Patch now","description":"Keep the smallest diff."},{"label":"Refactor first","description":"Clean the flow before patching."}]}</ask-user-question>',
      createdAt: '2026-04-16T00:00:00.000Z',
      meta: {
        provider: 'claude' as const,
      },
    },
  ]

  const nextMessages = finalizeStructuredActivityMessage(
    existingMessages,
    'assistant-live-3',
    'claude',
    'stream-3',
    {
      itemId: 'toolu_ask_1',
      kind: 'ask-user',
      status: 'completed',
      header: 'Confirmation',
      question: 'Which path should I use?',
      multiSelect: false,
      options: [
        { label: 'Patch now', description: 'Keep the smallest diff.' },
        { label: 'Refactor first', description: 'Clean the flow before patching.' },
      ],
    },
  )

  assert.equal(nextMessages.length, 2)
  assert.equal(nextMessages[0]?.id, 'assistant-live-3')
  assert.equal(nextMessages[0]?.content, 'I reviewed the previous work and found the risky path.')
  assert.equal(nextMessages[1]?.id, 'claude:stream-3:item:ask-user:question')
  assert.equal(nextMessages[1]?.meta?.kind, 'ask-user')
})

test('canSendEmptyContinuation allows an idle card with assistant history', () => {
  assert.equal(
    canSendEmptyContinuation({
      messages: [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')],
      sessionId: undefined,
      status: 'idle',
    }),
    true,
  )
})

test('canSendEmptyContinuation allows an idle card that only has a resumable session', () => {
  assert.equal(
    canSendEmptyContinuation({
      messages: [],
      sessionId: 'codex-session-1',
      status: 'idle',
    }),
    true,
  )
})

test('canSendEmptyContinuation allows continuing an error/interrupted card', () => {
  assert.equal(
    canSendEmptyContinuation({
      messages: [makeMessage('user', 'do it'), makeMessage('assistant', 'partial...')],
      sessionId: undefined,
      status: 'error',
    }),
    true,
  )
})

test('canSendEmptyContinuation refuses while the card is streaming', () => {
  assert.equal(
    canSendEmptyContinuation({
      messages: [makeMessage('user', 'hi'), makeMessage('assistant', 'hello')],
      sessionId: 'codex-session-1',
      status: 'streaming',
    }),
    false,
  )
})

test('canSendEmptyContinuation refuses a fresh card with no history and no session', () => {
  assert.equal(
    canSendEmptyContinuation({
      messages: [],
      sessionId: undefined,
      status: 'idle',
    }),
    false,
  )
})

test('canSendEmptyContinuation refuses a card that only holds a system notice', () => {
  assert.equal(
    canSendEmptyContinuation({
      messages: [makeMessage('system', 'Local CLI unavailable')],
      sessionId: undefined,
      status: 'idle',
    }),
    false,
  )
})
