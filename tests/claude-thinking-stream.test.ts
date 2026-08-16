import assert from 'node:assert/strict'
import test from 'node:test'

import { createClaudeTurnParser } from '../server/providers.ts'
import type { ChatRequest, StreamActivity } from '../shared/schema.ts'

// 症状 — 长思考期间界面**完全静默**：Claude 的 thinking 被累积到 content_block_stop
//   才一次性发出，一段几十秒的思考在此期间没有任何可见变化，用户读作"是不是卡死了"。
// 对照 — ACP 的 agent_thought_chunk 本来就是流式 chunk；Codex 侧同样是一次性，
//   所以 Claude 改增量后会是本仓库第一个增量 reasoning 源。
// 关键约束 — 渲染层按 itemId **整条覆盖**（finalizeStructuredActivityMessage），
//   所以每次增量必须发**累积全文**而不是新增片段，否则用户只会看到最后一小段。

const request: ChatRequest = {
  provider: 'claude',
  workspacePath: '.',
  model: 'claude-opus-5',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: 'test',
  attachments: [],
}

type ReasoningActivity = Extract<StreamActivity, { kind: 'reasoning' }>

const runThinkingTurn = (chunks: string[]) => {
  const activities: StreamActivity[] = []
  const parser = createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    sink: {
      onSession: () => {},
      onDelta: () => {},
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: (activity) => activities.push(activity),
      onDone: () => {},
      onError: () => {},
    },
  })

  const feed = (event: Record<string, unknown>) =>
    parser.handleLine(JSON.stringify({ type: 'stream_event', event }))

  feed({ type: 'message_start', message: { id: 'msg_think_1' } })
  feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
  for (const chunk of chunks) {
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } })
  }
  feed({ type: 'content_block_stop', index: 0 })

  return activities.filter(
    (activity): activity is ReasoningActivity => activity.kind === 'reasoning',
  )
}

test('a long thinking block streams progress instead of staying silent', () => {
  // 每块 120 字，累计 600 —— 足以越过节流阈值好几次。
  const reasoning = runThinkingTurn(Array.from({ length: 5 }, (_, index) => `${index}`.repeat(120)))

  const inProgress = reasoning.filter((activity) => activity.status === 'in_progress')
  assert.ok(inProgress.length > 0, '长思考期间必须有可见进展，否则界面全程静默')

  const completed = reasoning.filter((activity) => activity.status === 'completed')
  assert.equal(completed.length, 1, '终态仍然只发一条')
})

test('every thinking update keeps the same itemId so the card is replaced, not duplicated', () => {
  const reasoning = runThinkingTurn(Array.from({ length: 5 }, (_, index) => `${index}`.repeat(120)))

  const itemIds = new Set(reasoning.map((activity) => activity.itemId))
  assert.equal(itemIds.size, 1)
  assert.equal([...itemIds][0], 'msg_think_1:thinking:0')
})

test('each streamed update carries the accumulated text, not just the new slice', () => {
  const reasoning = runThinkingTurn(['A'.repeat(300), 'B'.repeat(300)])

  const inProgress = reasoning.filter((activity) => activity.status === 'in_progress')
  const latest = inProgress.at(-1)
  assert.ok(latest)
  // 渲染层整条覆盖，所以这里必须是累积全文；发增量片段会让用户只看到结尾。
  assert.ok(latest.text.startsWith('A'.repeat(50)), '增量必须从思考开头带全')
  assert.ok(latest.text.length >= 300)
})

test('a short thinking block does not spam an update per delta', () => {
  // 节流的意义：每个 delta 发一条 activity 会把渲染主线程压垮（pitfall 187/189）。
  const reasoning = runThinkingTurn(['短', '思', '考'])

  assert.equal(reasoning.filter((activity) => activity.status === 'in_progress').length, 0)
  assert.equal(reasoning.filter((activity) => activity.status === 'completed').length, 1)
})

test('an empty thinking block still emits nothing at all', () => {
  // 既有行为：omitted-display 的思考没有 thinking_delta，一条都不该发。
  assert.deepEqual(runThinkingTurn([]), [])
  assert.deepEqual(runThinkingTurn(['   ']), [])
})

test('the final completed activity carries the whole trimmed thinking', () => {
  const reasoning = runThinkingTurn(['  head ', 'X'.repeat(400), ' tail  '])
  const completed = reasoning.find((activity) => activity.status === 'completed')

  assert.ok(completed?.text.startsWith('head'))
  assert.ok(completed?.text.endsWith('tail'))
})
