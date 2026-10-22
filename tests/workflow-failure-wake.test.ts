import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatCard, StreamAgentsActivity } from '../shared/schema'
import { buildWorkflowFailureWakePrompt, detectWorkflowCatastrophicFailure, type WorkflowCounts } from '../src/components/workflow-failure-wake'

const card = (counts?: WorkflowCounts, status = 'running') => {
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

test('fires once on the edge where a second sub-agent dies of an infrastructure error', () => {
  const before = card({ done: 1, running: 4, failed: 1, queued: 0, total: 6, catastrophic: 1 })
  const after = card({ done: 1, running: 3, failed: 2, queued: 0, total: 6, catastrophic: 2, catastrophicSample: 'API Error: 529 overloaded' })
  const hits = detectWorkflowCatastrophicFailure(before, after)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.threadId, 'wf_1')
  assert.equal(hits[0]?.label, '漫画分镜调研')
  // 已在线上方：不重复叫醒。
  assert.deepEqual(detectWorkflowCatastrophicFailure(after, card({ done: 1, running: 2, failed: 3, queued: 0, total: 6, catastrophic: 3 })), [])
})

// 2026-10-22 用户截图：「失败 2/3（已完成 0，在跑 1）」就叫醒——那两次是脚本自己会处理的普通失败。
test('ordinary failures never wake the parent, even past half', () => {
  assert.deepEqual(detectWorkflowCatastrophicFailure(card({ done: 0, running: 2, failed: 1, queued: 0, total: 3 }), card({ done: 0, running: 1, failed: 2, queued: 0, total: 3 })), [])
  assert.deepEqual(detectWorkflowCatastrophicFailure(card({ done: 1, running: 3, failed: 2, queued: 0, total: 6 }), card({ done: 1, running: 1, failed: 4, queued: 0, total: 6, catastrophic: 1 })), [])
})

test('does not fire for settled runs or on a first observation', () => {
  const hot = { done: 1, running: 2, failed: 3, queued: 0, total: 6, catastrophic: 2 }
  assert.deepEqual(detectWorkflowCatastrophicFailure(card({ done: 1, running: 3, failed: 2, queued: 0, total: 6, catastrophic: 1 }), card(hot, 'completed')), [])
  // 重启/重新附着后第一次看到的就已过线：那是旧事，不叫。
  assert.deepEqual(detectWorkflowCatastrophicFailure(card(), card(hot)), [])
})

test('the wake prompt tells the parent what failed and what to do, in both languages', () => {
  const hit = { threadId: 'wf_1', label: '漫画分镜调研', counts: { done: 1, running: 2, failed: 3, queued: 0, total: 6, catastrophic: 2, catastrophicSample: 'API Error: 529 overloaded' } }
  const zh = buildWorkflowFailureWakePrompt(hit, 'zh-CN')
  assert.match(zh, /漫画分镜调研/)
  assert.match(zh, /2 个子 agent 死于基础设施错误/)
  assert.match(zh, /失败 3\/6/)
  assert.match(zh, /529 overloaded/)
  assert.match(zh, /TaskStop/)
  const en = buildWorkflowFailureWakePrompt(hit, 'en')
  assert.match(en, /3\/6 failed/)
  assert.match(en, /2 sub-agents died/)
})
