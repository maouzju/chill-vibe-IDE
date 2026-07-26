import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema'
import { createCodexAgentStatusSnapshotActivity } from '../src/codex-agent-status-slash'

const statusMessage = (
  itemId: string,
  agents: Array<Record<string, unknown>>,
): ChatMessage => ({
  id: `message-${itemId}`,
  role: 'assistant',
  content: '',
  createdAt: '2026-07-23T08:00:00.000Z',
  meta: {
    provider: 'codex',
    kind: 'agents',
    structuredData: JSON.stringify({
      itemId,
      kind: 'agents',
      status: 'completed',
      view: 'status',
      agents,
    }),
  },
})

test('creates a local /agent snapshot from the newest live status payload', () => {
  const activity = createCodexAgentStatusSnapshotActivity([
    statusMessage('older', []),
    statusMessage('newer', [
      {
        threadId: 'thread-reviewer',
        path: '/root/reviewer',
        status: 'running',
        activity: ['$ pnpm test'],
      },
    ]),
  ], 'slash-snapshot-1')

  assert.equal(activity.itemId, 'slash-snapshot-1')
  assert.equal(activity.view, 'status')
  assert.deepEqual(activity.agents, [
    {
      threadId: 'thread-reviewer',
      path: '/root/reviewer',
      status: 'running',
      message: null,
      activity: ['$ pnpm test'],
    },
  ])
})

test('prefers the updated live panel over a newer but stale slash snapshot', () => {
  const activity = createCodexAgentStatusSnapshotActivity([
    statusMessage('agent-status:root', [
      {
        threadId: 'thread-reviewer',
        path: '/root/reviewer',
        status: 'running',
        activity: ['latest live activity'],
      },
    ]),
    statusMessage('agent-status-snapshot:old', [
      {
        threadId: 'thread-reviewer',
        path: '/root/reviewer',
        status: 'running',
        activity: ['stale slash activity'],
      },
    ]),
  ], 'slash-snapshot-next')

  assert.deepEqual(activity.agents[0]?.activity, ['latest live activity'])
})

test('creates the Codex empty status panel when no live payload exists', () => {
  const activity = createCodexAgentStatusSnapshotActivity([], 'slash-snapshot-empty')

  assert.deepEqual(activity, {
    itemId: 'slash-snapshot-empty',
    kind: 'agents',
    status: 'completed',
    view: 'status',
    agents: [],
  })
})
