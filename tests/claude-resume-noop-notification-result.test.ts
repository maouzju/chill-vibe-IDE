import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatRequest, StreamEventMap } from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'

// 2026-11-27 实测夹具：claude 2.1.322，scripts/probe-claude-resume-killed-agents.mjs 的 phase2。
// 会话里挂着后台子代理时整棵进程树被杀（= 关 IDE），新进程 `--resume` 后 CLI 在 0.7s 内自己吐出的前三行。
// 只删了 init 里的 tools / slash_commands 等噪音，result 的判别字段一律是原文。
const SESSION_ID = '5d068286-ce0c-4871-9736-523faa3e271f'

const stoppedAgentNotification = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'a3d2e6bf32a206c07',
  status: 'stopped',
  summary: 'Background agent "Run sleep command and reply DONE" didn\'t finish before the previous session ended',
  session_id: SESSION_ID,
}

const initLine = { type: 'system', subtype: 'init', session_id: SESSION_ID, model: 'claude-haiku-5-5' }

const noOpNotificationResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 87,
  duration_api_ms: 0,
  num_turns: 0,
  stop_reason: null,
  result: '',
  session_id: SESSION_ID,
  total_cost_usd: 0,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
  origin: { kind: 'task-notification' },
  queued_turn_count: 0,
  result_index: 0,
}

const realTurnLines = [
  { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION_ID },
  {
    type: 'stream_event',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_real', role: 'assistant', content: [] } },
  },
  {
    type: 'stream_event',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    type: 'stream_event',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'RESUMED' } },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 27400,
    duration_api_ms: 22712,
    num_turns: 1,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    result: 'RESUMED',
    session_id: SESSION_ID,
    total_cost_usd: 0.00060753,
    usage: { input_tokens: 4, cache_creation_input_tokens: 520, cache_read_input_tokens: 47413, output_tokens: 58 },
    queued_turn_count: 0,
    result_index: 1,
  },
]

const request: ChatRequest = {
  provider: 'claude',
  workspacePath: '.',
  model: 'claude-haiku-5-5',
  reasoningEffort: 'high',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  sessionId: SESSION_ID,
  prompt: 'The IDE was closed while this turn was running and has just been reopened; resume the turn.',
  attachments: [],
}

const createHarness = () => {
  const events: string[] = []
  const donePayloads: (StreamEventMap['done'] | undefined)[] = []
  const errors: string[] = []
  let settledCount = 0
  const parser = createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    onSettled: () => {
      settledCount += 1
    },
    sink: {
      onSession: () => {},
      onDelta: (text) => events.push(`delta:${text}`),
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: (payload) => {
        events.push('done')
        donePayloads.push(payload)
      },
      onError: (message: string) => {
        events.push('error')
        errors.push(message)
      },
    },
  })
  const feed = (lines: Record<string, unknown>[]) => {
    for (const line of lines) parser.handleLine(JSON.stringify(line))
  }
  return { parser, feed, events, donePayloads, errors, settled: () => settledCount }
}

test('重启续跑：CLI 为「上次没跑完的后台子代理」自产的零轮次 result 不能结束这一回合', (t) => {
  const harness = createHarness()
  t.after(() => harness.parser.cancel())

  harness.feed([stoppedAgentNotification, initLine, noOpNotificationResult])

  // 症状复现点：旧逻辑在这里就 onDone 了 —— 卡片 1 秒内落回 idle（「恢复的窗口一两秒又停下」），
  // 开着循环重复的卡同时被判「跑完一轮」而新开一个 Tab 重跑首条提示（「多开一个循环重复的窗口」）。
  assert.equal(harness.donePayloads.length, 0)
  assert.equal(harness.errors.length, 0)
  assert.equal(harness.settled(), 0)
  assert.equal(harness.parser.settled(), false)

  harness.feed([initLine, ...realTurnLines])

  assert.deepEqual(harness.events, ['delta:RESUMED', 'done'])
  assert.equal(harness.donePayloads.length, 1)
  assert.equal(harness.donePayloads[0]?.completion, 'terminal')
  assert.equal(harness.donePayloads[0]?.turnStopReason, 'end_turn')
  assert.equal(harness.donePayloads[0]?.usage?.outputTokens, 58)
  assert.equal(harness.settled(), 1)
})

test('模型已经开口之后到达的 task-notification result 仍然是这一回合的收尾', (t) => {
  // 后台任务回流唤醒的回合（unsolicited）result 也带 origin.kind=task-notification，
  // 但它前面一定有顶层 message_start —— 那是真收尾，不能被一并吞掉。
  const harness = createHarness()
  t.after(() => harness.parser.cancel())

  harness.feed([
    ...realTurnLines.slice(0, 4),
    { ...realTurnLines[4], origin: { kind: 'task-notification' }, num_turns: 0 },
  ])

  assert.deepEqual(harness.events, ['delta:RESUMED', 'done'])
  assert.equal(harness.settled(), 1)
})

test('没有 task-notification 来源的零轮次 result（本地斜杠命令等）照常结束回合', (t) => {
  const harness = createHarness()
  t.after(() => harness.parser.cancel())

  const { origin: _origin, ...localCommandResult } = noOpNotificationResult
  void _origin
  harness.feed([initLine, localCommandResult])

  assert.deepEqual(harness.events, ['done'])
  assert.equal(harness.settled(), 1)
})

test('首 token 前就失败的 task-notification 回合（is_error）照常报错，不被当成空操作吞掉', (t) => {
  // pitfall #426：被唤醒的回合在 message_start 之前失败时只有 result(is_error)。
  const harness = createHarness()
  t.after(() => harness.parser.cancel())

  harness.feed([
    initLine,
    {
      ...noOpNotificationResult,
      is_error: true,
      subtype: 'success',
      api_error_status: 429,
      result: 'API Error: 429 rate limited',
    },
  ])

  assert.equal(harness.donePayloads.length, 0)
  assert.equal(harness.errors.length, 1)
  assert.equal(harness.settled(), 1)
})
