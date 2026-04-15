import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import {
  buildRenderableMessages,
  collectChangesSummaryFilesForStream,
  getRestoredStickyUserAnchor,
  getStickyRenderableUserMessageId,
  getLastRenderableUserMessageId,
  getTopVisibleRenderableEntryId,
  parseStructuredTodoMessage,
} from '../src/components/chat-card-parsing.ts'

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `msg-${Math.random().toString(36).slice(2, 8)}`,
  role: 'assistant',
  content: '',
  createdAt: new Date().toISOString(),
  ...overrides,
})

const makeToolMessage = (toolName: string, summary: string): ChatMessage =>
  makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
      structuredData: JSON.stringify({
        itemId: `item-${toolName}`,
        kind: 'tool',
        status: 'completed',
        toolName,
        summary,
      }),
    },
  })

const makeEditsMessage = (
  streamId: string,
  files: Array<{ path: string; addedLines: number; removedLines: number }>,
): ChatMessage =>
  makeMessage({
    id: `claude:${streamId}:item:edits-${Math.random().toString(36).slice(2, 8)}`,
    content: '',
    meta: {
      provider: 'claude',
      kind: 'edits',
      itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
      structuredData: JSON.stringify({
        itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'edits',
        status: 'completed',
        files: files.map((file) => ({
          path: file.path,
          kind: 'modified',
          addedLines: file.addedLines,
          removedLines: file.removedLines,
          patch: '@@',
        })),
      }),
    },
  })

test('buildRenderableMessages groups consecutive tool messages', () => {
  const messages = [
    makeToolMessage('Read', 'Read file.ts'),
    makeToolMessage('Grep', 'Search text: foo'),
  ]

  const result = buildRenderableMessages(messages)

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})

test('buildRenderableMessages skips empty structured messages that fail to parse', () => {
  // A message with meta.kind='tool' but missing/invalid structuredData
  // and empty content — this should NOT appear as a visible message
  const brokenToolMessage = makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: 'item-broken',
      // structuredData is missing entirely
    },
  })

  const brokenToolMessageNoSummary = makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: 'item-broken-2',
      structuredData: JSON.stringify({
        itemId: 'item-broken-2',
        kind: 'tool',
        status: 'completed',
        toolName: 'Agent',
        // summary is missing
      }),
    },
  })

  const validTool = makeToolMessage('Read', 'Read file.ts')
  const textMessage = makeMessage({ content: 'Hello world' })

  const messages = [
    validTool,
    brokenToolMessage,
    brokenToolMessageNoSummary,
    textMessage,
  ]

  const result = buildRenderableMessages(messages)

  // The broken tool messages should be skipped entirely.
  // We expect: one tool-group (containing the valid tool), then one text message.
  const types = result.map((r) => r.type)
  assert.deepEqual(types, ['tool-group', 'message'])

  // The text message should be the "Hello world" one
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, 'Hello world')
  }
})

test('buildRenderableMessages skips broken tool messages between valid tool groups', () => {
  const tool1 = makeToolMessage('Read', 'Read a.ts')
  const broken = makeMessage({
    content: '',
    meta: {
      provider: 'claude',
      kind: 'tool',
      itemId: 'item-broken',
    },
  })
  const tool2 = makeToolMessage('Grep', 'Search: bar')

  const messages = [tool1, broken, tool2]

  const result = buildRenderableMessages(messages)

  // Broken message should be skipped; the two valid tools merge into one group.
  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'tool-group')
  if (result[0]!.type === 'tool-group') {
    assert.equal(result[0]!.items.length, 2)
  }
})

test('buildRenderableMessages skips empty assistant messages (streaming artifacts)', () => {
  const textBefore = makeMessage({ content: 'Before tools' })
  const emptyAssistant1 = makeMessage({ content: '' })
  const emptyAssistant2 = makeMessage({ content: '   ' })
  const emptyAssistantWithProvider = makeMessage({
    content: '',
    meta: { provider: 'claude' },
  })
  const textAfter = makeMessage({ content: 'After tools' })

  const messages = [textBefore, emptyAssistant1, emptyAssistant2, emptyAssistantWithProvider, textAfter]

  const result = buildRenderableMessages(messages)

  // All empty assistant messages should be skipped
  assert.equal(result.length, 2)
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, 'Before tools')
  }
  if (result[1]!.type === 'message') {
    assert.equal(result[1]!.message.content, 'After tools')
  }
})

test('buildRenderableMessages keeps user messages even if empty', () => {
  const emptyUser = makeMessage({ role: 'user', content: '' })
  const result = buildRenderableMessages([emptyUser])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
})

test('buildRenderableMessages skips hidden auto-compact boundary messages', () => {
  const hiddenAutoCompactBoundary = makeMessage({
    role: 'user',
    content: '/compact',
    meta: {
      provider: 'codex',
      compactBoundary: 'true',
      compactTrigger: 'auto',
      compactHidden: 'true',
    },
  })
  const compactedSummary = makeMessage({
    role: 'assistant',
    content: 'Compacted summary remains visible.',
  })

  const result = buildRenderableMessages([hiddenAutoCompactBoundary, compactedSummary])

  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'message')
  if (result[0]!.type === 'message') {
    assert.equal(result[0]!.message.content, 'Compacted summary remains visible.')
  }
})

test('getLastRenderableUserMessageId returns the last visible user message id', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Earlier reply' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First visible prompt' }),
    makeToolMessage('Read', 'Read src/App.tsx'),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Latest reply body' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Keep this prompt pinned' }),
    makeToolMessage('Edit', 'Update the layout'),
  ])

  assert.equal(getLastRenderableUserMessageId(result), 'user-2')
})

test('getLastRenderableUserMessageId returns null when no user message is visible', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Only assistant text' }),
    makeToolMessage('Read', 'Read src/state.ts'),
  ])

  assert.equal(getLastRenderableUserMessageId(result), null)
})

test('getStickyRenderableUserMessageId waits until a reply takes over before pinning that user prompt', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First prompt' }),
    makeToolMessage('Read', 'Read src/App.tsx'),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the first prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Second prompt' }),
    makeMessage({ id: 'assistant-3', role: 'assistant', content: 'Reply to the second prompt' }),
  ])

  assert.equal(getStickyRenderableUserMessageId(result, 'assistant-1'), null)
  assert.equal(getStickyRenderableUserMessageId(result, 'user-1'), null)
  assert.equal(getStickyRenderableUserMessageId(result, 'assistant-2'), 'user-1')
  assert.equal(getStickyRenderableUserMessageId(result, 'user-2'), null)
  assert.equal(getStickyRenderableUserMessageId(result, 'assistant-3'), 'user-2')
})

test('getStickyRenderableUserMessageId hides a latest user prompt that has no following renderable reply yet', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Earlier reply before the latest prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'Earlier prompt with a reply' }),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the earlier prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Latest prompt still waiting for any reply' }),
  ])

  assert.equal(getStickyRenderableUserMessageId(result, 'user-2'), null)
})

test('getRestoredStickyUserAnchor points restored chats at the reply right after the last visible user prompt', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First prompt' }),
    makeToolMessage('Read', 'Read src/App.tsx'),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the first prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Keep this prompt pinned after restore' }),
    makeMessage({ id: 'assistant-3', role: 'assistant', content: 'Short latest reply' }),
  ])

  assert.deepEqual(getRestoredStickyUserAnchor(result), {
    stickyMessageId: 'user-2',
    anchorEntryId: 'assistant-3',
  })
})

test('getRestoredStickyUserAnchor returns null when the latest visible user prompt has no following content', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'Most recent prompt without a reply yet' }),
  ])

  assert.equal(getRestoredStickyUserAnchor(result), null)
})

test('getTopVisibleRenderableEntryId keeps a visible user message as the active boundary before the next reply takes over', () => {
  const result = buildRenderableMessages([
    makeMessage({ id: 'assistant-1', role: 'assistant', content: 'Intro reply before any user prompt' }),
    makeMessage({ id: 'user-1', role: 'user', content: 'First prompt' }),
    makeMessage({ id: 'assistant-2', role: 'assistant', content: 'Reply to the first prompt' }),
    makeMessage({ id: 'user-2', role: 'user', content: 'Second prompt with a tall attachment preview' }),
    makeMessage({ id: 'assistant-3', role: 'assistant', content: 'Reply to the second prompt' }),
  ])

  const visibleEntries = new Set(['user-2', 'assistant-3'])
  assert.equal(getTopVisibleRenderableEntryId(result, (entryId) => visibleEntries.has(entryId)), 'user-2')
})

test('collectChangesSummaryFilesForStream only includes edits from the active stream', () => {
  const previousRunEdit = makeEditsMessage('stream-1', [
    { path: 'src/old.ts', addedLines: 5, removedLines: 1 },
  ])
  const currentRunEditA = makeEditsMessage('stream-2', [
    { path: 'src/current.ts', addedLines: 2, removedLines: 3 },
  ])
  const currentRunEditB = makeEditsMessage('stream-2', [
    { path: 'src/current.ts', addedLines: 1, removedLines: 0 },
    { path: 'src/other.ts', addedLines: 4, removedLines: 2 },
  ])

  const result = collectChangesSummaryFilesForStream(
    [previousRunEdit, currentRunEditA, currentRunEditB],
    'claude',
    'stream-2',
  )

  assert.deepEqual(result, [
    { path: 'src/current.ts', addedLines: 3, removedLines: 3 },
    { path: 'src/other.ts', addedLines: 4, removedLines: 2 },
  ])
})

test('parseStructuredTodoMessage reads structured todo list messages', () => {
  const message = makeMessage({
    meta: {
      provider: 'claude',
      kind: 'todo',
      itemId: 'toolu_todo',
      structuredData: JSON.stringify({
        itemId: 'toolu_todo',
        kind: 'todo',
        status: 'completed',
        items: [
          {
            id: 'todo-1',
            content: 'Inspect the current card pipeline',
            status: 'completed',
          },
          {
            id: 'todo-2',
            content: 'Render the live task list',
            activeForm: 'Rendering the live task list',
            status: 'in_progress',
            priority: 'high',
          },
        ],
      }),
    },
  })

  assert.deepEqual(parseStructuredTodoMessage(message), {
    itemId: 'toolu_todo',
    status: 'completed',
    items: [
      {
        id: 'todo-1',
        content: 'Inspect the current card pipeline',
        status: 'completed',
      },
      {
        id: 'todo-2',
        content: 'Render the live task list',
        activeForm: 'Rendering the live task list',
        status: 'in_progress',
        priority: 'high',
      },
    ],
  })
})
