import assert from 'node:assert/strict'
import test from 'node:test'
import { createCard } from '../shared/default-state.ts'
import { claudeAgentStatusPushSchema } from '../shared/schema.ts'
import { applyClaudeAgentStatusPush, claudeWorkflowSummaryPrefix, retireUntrackedClaudeAgents } from '../shared/claude-agent-push.ts'

test('后台状态推送只更新同一张面板，不启动聊天流或重置卡片状态', () => {
  const card = createCard()
  card.provider = 'claude'
  card.sessionId = 'session'
  const status = { itemId: 'agent-status:claude', kind: 'agents', status: 'completed', view: 'status', agents: [{ threadId: 'workflow:one', status: 'running', activity: ['⏳ 已运行 5分0秒'] }] }
  const push = claudeAgentStatusPushSchema.parse({ cardId: card.id, streamId: 'runtime', sessionId: 'session', agentStatus: status })
  const next = applyClaudeAgentStatusPush(card, push)
  assert.equal(next.status, card.status)
  assert.equal(next.streamId, card.streamId)
  assert.equal(next.messages.length, 1)
  const ended = applyClaudeAgentStatusPush(next, { ...push, agentStatus: { ...push.agentStatus, agents: [] } })
  assert.equal(ended.messages.length, 1)
  assert.deepEqual(JSON.parse(ended.messages[0].meta!.structuredData!).agents, [])
  assert.equal(applyClaudeAgentStatusPush(card, { ...push, sessionId: 'wrong' }), card)
  assert.equal(claudeAgentStatusPushSchema.safeParse({ ...push, agentStatus: { agents: [] } }).success, false)
})

test('旧 Workflow 快照在失去追踪后标为中断，保留记录且不猜耗时', () => {
  const card = createCard()
  card.provider = 'claude'
  card.messages = [{ id: 'old', role: 'assistant', content: '', createdAt: new Date().toISOString(), meta: { provider: 'claude', kind: 'agents', structuredData: JSON.stringify({ kind: 'agents', view: 'status', agents: [{ threadId: 'workflow:old', status: 'running', activity: ['⏳ 已运行 1分34秒'] }] }) } }]
  const messages = retireUntrackedClaudeAgents(card.messages)
  assert.equal(JSON.parse(messages[0].meta!.structuredData!).agents[0].status, 'interrupted')
  assert.deepEqual(JSON.parse(messages[0].meta!.structuredData!).agents[0].activity, ['⏳ 已运行 1分34秒'])
  assert.equal(retireUntrackedClaudeAgents(messages), messages)
})

// 2026-09-27 对抗审查复现：中途退出再启动，条目已标 interrupted，旁边的汇总仍写着「在跑 1 · 排队 2」。
test('失去追踪的 Workflow 汇总只留已完成计数，不再声称还有 agent 在跑', () => {
  const card = createCard()
  card.provider = 'claude'
  const snapshot = (activity: string[]) => JSON.stringify({ kind: 'agents', view: 'status', agents: [{ threadId: 'workflow:wf', status: 'running', activity }] })
  card.messages = [
    { id: 'zh', role: 'assistant', content: '', createdAt: new Date().toISOString(), meta: { provider: 'claude', kind: 'agents', structuredData: snapshot(['Wave1: A3:rig · 530 tools · 118m4s', `${claudeWorkflowSummaryPrefix} 已完成 3/4 · 在跑 1 · 排队 2`, '⏳ 已运行 118分4秒']) } },
    { id: 'en', role: 'assistant', content: '', createdAt: new Date().toISOString(), meta: { provider: 'claude', kind: 'agents', structuredData: snapshot([`${claudeWorkflowSummaryPrefix} 1/7 done · 4 running · 1 failed`, '⏳ running 3m0s']) } },
  ]
  const [zh, en] = retireUntrackedClaudeAgents(card.messages).map((message) => JSON.parse(message.meta!.structuredData!).agents[0])
  assert.equal(zh.status, 'interrupted')
  assert.deepEqual(zh.activity, ['Wave1: A3:rig · 530 tools · 118m4s', `${claudeWorkflowSummaryPrefix} 已完成 3/4`, '⏳ 已运行 118分4秒'])
  assert.deepEqual(en.activity, [`${claudeWorkflowSummaryPrefix} 1/7 done`, '⏳ running 3m0s'])
})
