import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCodexAgentStatusTracker,
  summarizeCodexAgentActivityItem,
} from '../server/codex-agent-status'

const rootThreadId = '00000000-0000-0000-0000-000000000001'
const childThreadId = '00000000-0000-0000-0000-000000000002'
const nestedThreadId = '00000000-0000-0000-0000-000000000003'

const childStarted = (threadId = childThreadId, parentThreadId = rootThreadId) => ({
  method: 'thread/started',
  params: {
    thread: {
      id: threadId,
      parentThreadId,
      agentNickname: threadId === childThreadId ? 'Robie' : 'Bob',
      agentRole: threadId === childThreadId ? 'explorer' : 'worker',
      status: { type: 'active', activeFlags: [] },
    },
  },
})

const subAgentActivity = (
  threadId: string,
  path: string,
  kind: 'started' | 'interacted' | 'interrupted' = 'started',
  senderThreadId = rootThreadId,
) => ({
  method: 'item/completed',
  params: {
    threadId: senderThreadId,
    turnId: `turn-${senderThreadId}`,
    item: {
      id: `subagent-${threadId}-${kind}`,
      type: 'subAgentActivity',
      kind,
      agentThreadId: threadId,
      agentPath: path,
    },
  },
})

const childItem = (item: Record<string, unknown>, method = 'item/completed') => ({
  method,
  params: {
    threadId: childThreadId,
    turnId: 'turn-child',
    item,
  },
})

test('tracks v2 child and nested sub-agent activity in stable first-seen order', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })

  assert.equal(tracker.handleNotification(childStarted()).handled, true)
  tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))
  tracker.handleNotification(childStarted(nestedThreadId, childThreadId))
  const update = tracker.handleNotification(
    subAgentActivity(nestedThreadId, '/root/reviewer/worker', 'started', childThreadId),
  )

  assert.equal(update.handled, true)
  assert.deepEqual(
    update.activity?.agents.map((agent) => ({
      threadId: agent.threadId,
      path: agent.path,
      status: agent.status,
    })),
    [
      { threadId: childThreadId, path: '/root/reviewer', status: 'running' },
      { threadId: nestedThreadId, path: '/root/reviewer/worker', status: 'running' },
    ],
  )
})

test('ignores unrelated child trees while accepting descendants of tracked agents', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })

  tracker.handleNotification(childStarted('thread-unrelated', 'thread-other-root'))
  tracker.handleNotification(
    subAgentActivity('thread-unrelated-agent', '/other/reviewer', 'started', 'thread-other-root'),
  )

  assert.equal(tracker.getAgent('thread-unrelated'), undefined)
  assert.equal(tracker.getAgent('thread-unrelated-agent'), undefined)
  assert.deepEqual(tracker.snapshot().agents, [])

  tracker.handleNotification(childStarted())
  tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))
  tracker.handleNotification(childStarted(nestedThreadId, childThreadId))

  assert.equal(tracker.isChildThread(nestedThreadId), true)
})

test('suppresses unknown non-root notifications without creating a phantom running agent', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })
  const update = tracker.handleNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-unknown',
      turnId: 'turn-unknown',
      itemId: 'message-unknown',
      delta: 'must not leak',
    },
  })

  assert.equal(update.handled, true)
  assert.equal(tracker.getAgent('thread-unknown'), undefined)
  assert.equal(tracker.hasRunningAgents(), false)
  assert.equal(tracker.markRootTurnCompleted(), 'finish')
})

test('deduplicates item lifecycle updates and retains only the latest six previews', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })
  tracker.handleNotification(childStarted())
  tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))

  tracker.handleNotification(childItem({
    id: 'command-1',
    type: 'commandExecution',
    command: 'pnpm test',
    aggregatedOutput: 'must never leak',
  }, 'item/started'))
  tracker.handleNotification(childItem({
    id: 'command-1',
    type: 'commandExecution',
    command: 'pnpm test',
    aggregatedOutput: 'must never leak',
  }))

  for (let index = 2; index <= 7; index += 1) {
    tracker.handleNotification(childItem({
      id: `message-${index}`,
      type: 'agentMessage',
      text: `activity ${index}`,
    }))
  }

  const activity = tracker.snapshot()
  assert.deepEqual(activity.agents[0]?.activity, [
    'activity 2',
    'activity 3',
    'activity 4',
    'activity 5',
    'activity 6',
    'activity 7',
  ])
  assert.doesNotMatch(JSON.stringify(activity), /must never leak/)
})

test('uses reasoning summaries without exposing raw reasoning content', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })
  tracker.handleNotification(childStarted())
  tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))

  tracker.handleNotification(childItem({
    id: 'reasoning-1',
    type: 'reasoning',
    summary: ['older summary', 'safe summary'],
    content: ['hidden raw reasoning'],
  }))
  tracker.handleNotification(childItem({
    id: 'reasoning-2',
    type: 'reasoning',
    summary: [],
    content: ['raw-only reasoning'],
  }))

  const serialized = JSON.stringify(tracker.snapshot())
  assert.match(serialized, /safe summary/)
  assert.doesNotMatch(serialized, /older summary|hidden raw reasoning|raw-only reasoning/)
})

test('defers root completion until the final running child settles', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })
  tracker.handleNotification(childStarted())
  tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))

  assert.equal(tracker.markRootTurnCompleted(), 'defer')

  const update = tracker.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: childThreadId,
      turn: { id: 'turn-child', status: 'completed', items: [] },
    },
  })

  assert.equal(update.handled, true)
  assert.equal(update.releaseDeferredRootCompletion, true)
  assert.deepEqual(update.activity?.agents, [])
  assert.equal(tracker.markRootTurnCompleted(), 'finish')
})

test('keeps root completion deferred until every concurrent child settles', () => {
  const tracker = createCodexAgentStatusTracker({ rootThreadId })
  tracker.handleNotification(childStarted())
  tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))
  tracker.handleNotification(childStarted(nestedThreadId, rootThreadId))
  tracker.handleNotification(subAgentActivity(nestedThreadId, '/root/tester'))

  assert.equal(tracker.markRootTurnCompleted(), 'defer')

  const firstDone = tracker.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: childThreadId,
      turn: { id: 'turn-child', status: 'completed', items: [] },
    },
  })
  assert.equal(firstDone.releaseDeferredRootCompletion, undefined)
  assert.deepEqual(firstDone.activity?.agents.map((agent) => agent.path), ['/root/tester'])

  const finalDone = tracker.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: nestedThreadId,
      turn: { id: 'turn-tester', status: 'completed', items: [] },
    },
  })
  assert.equal(finalDone.releaseDeferredRootCompletion, true)
  assert.deepEqual(finalDone.activity?.agents, [])
})

test('maps child failures, interruptions, idle, and close without treating them as running', () => {
  const cases = [
    {
      notification: {
        method: 'turn/completed',
        params: {
          threadId: childThreadId,
          turn: {
            id: 'turn-child',
            status: 'failed',
            error: { message: 'tool timeout' },
            items: [],
          },
        },
      },
      status: 'errored',
    },
    {
      notification: subAgentActivity(childThreadId, '/root/reviewer', 'interrupted'),
      status: 'interrupted',
    },
    {
      notification: {
        method: 'thread/status/changed',
        params: { threadId: childThreadId, status: { type: 'idle' } },
      },
      status: 'completed',
    },
    {
      notification: {
        method: 'thread/closed',
        params: { threadId: childThreadId },
      },
      status: 'shutdown',
    },
  ] as const

  for (const entry of cases) {
    const tracker = createCodexAgentStatusTracker({ rootThreadId })
    tracker.handleNotification(childStarted())
    tracker.handleNotification(subAgentActivity(childThreadId, '/root/reviewer'))
    tracker.handleNotification(entry.notification)

    assert.equal(tracker.getAgent(childThreadId)?.status, entry.status)
    assert.deepEqual(tracker.snapshot().agents, [])
  }
})

test('summarizes Codex CLI preview categories with whitespace and length bounds', () => {
  assert.equal(summarizeCodexAgentActivityItem({
    id: 'command',
    type: 'commandExecution',
    command: '  pnpm   test\n--filter focused  ',
    aggregatedOutput: 'ignored output',
  }), '$ pnpm test --filter focused')
  assert.equal(summarizeCodexAgentActivityItem({
    id: 'files',
    type: 'fileChange',
    changes: [{}, {}, {}],
  }), 'Updated 3 file(s)')
  assert.equal(summarizeCodexAgentActivityItem({
    id: 'mcp',
    type: 'mcpToolCall',
    server: 'docs',
    tool: 'search',
  }), 'MCP docs/search')
  assert.equal(summarizeCodexAgentActivityItem({
    id: 'dynamic',
    type: 'dynamicToolCall',
    namespace: 'collaboration',
    tool: 'spawn_agent',
  }), 'Tool collaboration/spawn_agent')
  assert.equal(summarizeCodexAgentActivityItem({
    id: 'user',
    type: 'userMessage',
    content: 'ignore me',
  }), null)

  const long = summarizeCodexAgentActivityItem({
    id: 'long',
    type: 'agentMessage',
    text: '🧠'.repeat(300),
  })
  assert.equal(Array.from(long ?? '').length, 240)

  const family = '👨‍👩‍👧‍👦'
  const graphemeBounded = summarizeCodexAgentActivityItem({
    id: 'grapheme-long',
    type: 'agentMessage',
    text: family.repeat(300),
  })
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  assert.equal([...segmenter.segment(graphemeBounded ?? '')].length, 240)
  assert.equal(graphemeBounded, family.repeat(240))
})
