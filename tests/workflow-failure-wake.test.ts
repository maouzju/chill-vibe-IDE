import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatCard, StreamAgentsActivity } from '../shared/schema'
import { buildWorkflowFailureWakePrompt, detectWorkflowFailureMajority } from '../src/components/workflow-failure-wake'

const card = (counts?: { done: number; running: number; failed: number; queued: number; total: number }, status = 'running') => {
  const activity: StreamAgentsActivity = {
    itemId: 'agent-status:claude',
    kind: 'agents',
    status: 'completed',
    view: 'status',
    agents: [{ threadId: 'wf_1', nickname: '漫画分镜调研', role: 'Workflow', status: status as 'running', ...(counts ? { workflowCounts: counts } : {}) }],
  }
  return {
    provider: 'claude',
    messages: [{ id: 'claude:s:item:agent-status:claude', role: 'assistant', content: '', createdAt: '', meta: { provider: 'claude', kind: 'agents', structuredData: JSON.stringify(activity) } }],
  } as unknown as ChatCard
}

test('fires once on the edge where failed reaches half of the Workflow', () => {
  const before = card({ done: 1, running: 3, failed: 2, queued: 0, total: 6 })
  const after = card({ done: 1, running: 2, failed: 3, queued: 0, total: 6 })
  const hits = detectWorkflowFailureMajority(before, after)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.threadId, 'wf_1')
  assert.equal(hits[0]?.label, '漫画分镜调研')
  // 已在线上方：不重复叫醒。
  assert.deepEqual(detectWorkflowFailureMajority(after, card({ done: 1, running: 1, failed: 4, queued: 0, total: 6 })), [])
})

test('does not fire below half, for a single failure, for settled runs, or on a first observation', () => {
  assert.deepEqual(detectWorkflowFailureMajority(card({ done: 0, running: 3, failed: 1, queued: 0, total: 4 }), card({ done: 0, running: 2, failed: 1, queued: 0, total: 3 })), [])
  assert.deepEqual(detectWorkflowFailureMajority(card({ done: 0, running: 2, failed: 0, queued: 0, total: 2 }), card({ done: 0, running: 1, failed: 1, queued: 0, total: 2 })), [])
  assert.deepEqual(detectWorkflowFailureMajority(card({ done: 1, running: 3, failed: 2, queued: 0, total: 6 }), card({ done: 1, running: 2, failed: 3, queued: 0, total: 6 }, 'completed')), [])
  // 重启/重新附着后第一次看到的就已过半：那是旧事，不叫。
  assert.deepEqual(detectWorkflowFailureMajority(card(), card({ done: 1, running: 2, failed: 3, queued: 0, total: 6 })), [])
})

test('the wake prompt tells the parent what failed and what to do, in both languages', () => {
  const hit = { threadId: 'wf_1', label: '漫画分镜调研', counts: { done: 1, running: 2, failed: 3, queued: 0, total: 6 } }
  const zh = buildWorkflowFailureWakePrompt(hit, 'zh-CN')
  assert.match(zh, /漫画分镜调研/)
  assert.match(zh, /失败 3\/6/)
  assert.match(zh, /TaskStop/)
  assert.match(buildWorkflowFailureWakePrompt(hit, 'en'), /3\/6 failed/)
})
