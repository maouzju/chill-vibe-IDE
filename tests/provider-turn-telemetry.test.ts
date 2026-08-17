import assert from 'node:assert/strict'
import test from 'node:test'

import { createMessage } from '../shared/default-state.ts'
import type { ChatRequest, StreamEventMap } from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'
import {
  mapClaudeTurnStopReason,
  readClaudeTurnUsage,
} from '../server/provider-turn-telemetry.ts'
import {
  attachTurnTelemetry,
  readTurnTelemetry,
  summarizeTurnUsage,
} from '../shared/turn-telemetry-summary.ts'

// 2026-08-16 实测夹具：claude 2.1.206 `-p --output-format stream-json --verbose`
// 的真实 result 行（`claude -p "say ok" --model claude-haiku-4-5-20251001`）。
// 只删掉与本测试无关的 tools/slash_commands 噪音，保留的字段一律是原文。
// 为什么必须实测而不是照文档写：pitfall #289/#291 —— 只有 CLI 的真实反应算证据。
const realSuccessResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  duration_ms: 2435,
  num_turns: 1,
  result: 'ok',
  stop_reason: 'end_turn',
  session_id: 'a1860be7-f8bc-4f0a-866b-1806a5a2b1e1',
  total_cost_usd: 0.0563255,
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 45042,
    cache_read_input_tokens: 0,
    output_tokens: 4,
    service_tier: 'standard',
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 45042,
      costUSD: 0.0563255,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  terminal_reason: 'completed',
} satisfies Record<string, unknown>

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

const runResultLine = (event: Record<string, unknown>) => {
  const donePayloads: (StreamEventMap['done'] | undefined)[] = []
  const errors: string[] = []
  createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    sink: {
      onSession: () => {},
      onDelta: () => {},
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: (payload) => donePayloads.push(payload),
      onError: (message: string) => errors.push(message),
    },
  }).handleLine(JSON.stringify(event))
  return { donePayloads, errors }
}

// ---------------------------------------------------------------------------
// 缺陷 A —— turn 终态原因从未离开日志
// ---------------------------------------------------------------------------

test('Claude stop_reason maps onto the ACP turn stop reasons', () => {
  assert.equal(mapClaudeTurnStopReason({ stop_reason: 'end_turn' }), 'end_turn')
  assert.equal(mapClaudeTurnStopReason({ stop_reason: 'max_tokens' }), 'max_tokens')
  assert.equal(mapClaudeTurnStopReason({ stop_reason: 'refusal' }), 'refusal')
  // 轮次上限是 subtype 携带的，不在 stop_reason 里。
  assert.equal(mapClaudeTurnStopReason({ subtype: 'error_max_turns' }), 'max_turn_requests')
})

test('an unknown Claude stop_reason stays undefined instead of being invented', () => {
  // 不认识就不猜：编一个假值会让下游把"没数据"和"真的是这个原因"混为一谈。
  assert.equal(mapClaudeTurnStopReason({ stop_reason: 'brand_new_upstream_value' }), undefined)
  assert.equal(mapClaudeTurnStopReason({}), undefined)
})

test('a real Claude turn reports its stop reason on the done event', () => {
  const { donePayloads, errors } = runResultLine(realSuccessResult)

  assert.deepEqual(errors, [])
  assert.equal(donePayloads.length, 1)
  assert.equal(donePayloads[0]?.turnStopReason, 'end_turn')
})

// ---------------------------------------------------------------------------
// 缺陷 B —— token / 上下文用量全项目零采集
// ---------------------------------------------------------------------------

test('a real Claude result yields ACP-shaped context usage', () => {
  const usage = readClaudeTurnUsage(realSuccessResult)

  // used = 本轮真正占用的上下文 = 入参 + 两类缓存 + 出参。
  assert.equal(usage?.used, 45049)
  // size 来自 CLI 自己报的 contextWindow，不是我们硬编码的模型表。
  assert.equal(usage?.size, 200000)
  assert.equal(usage?.inputTokens, 3)
  assert.equal(usage?.outputTokens, 4)
  assert.equal(usage?.cacheCreationTokens, 45042)
  assert.equal(usage?.cacheReadTokens, 0)
  assert.equal(usage?.costUsd, 0.0563255)
})

test('usage without modelUsage still reports used but omits the window size', () => {
  const usage = readClaudeTurnUsage({
    usage: { input_tokens: 10, output_tokens: 5 },
  })

  assert.equal(usage?.used, 15)
  assert.equal(usage?.size, undefined)
})

test('a result with no usage block yields no usage at all', () => {
  assert.equal(readClaudeTurnUsage({ type: 'result', subtype: 'success' }), undefined)
})

test('a real Claude turn reports context usage on the done event', () => {
  const { donePayloads } = runResultLine(realSuccessResult)

  assert.equal(donePayloads[0]?.usage?.used, 45049)
  assert.equal(donePayloads[0]?.usage?.size, 200000)
})

// ---------------------------------------------------------------------------
// 回归护栏 —— 新字段必须是纯增量，不能改动既有终态语义
// ---------------------------------------------------------------------------

test('adding telemetry does not disturb the existing completion field', () => {
  const { donePayloads } = runResultLine(realSuccessResult)

  // completion 是既有契约（terminal / background-pending），遥测字段不得挤占它。
  assert.equal(donePayloads[0]?.completion, 'terminal')
})

// ---------------------------------------------------------------------------
// 落盘 —— 挂在既有的 run-duration 消息上，不新增消息、不新增渲染分支
// ---------------------------------------------------------------------------

const runDurationMessage = () =>
  createMessage('system', '', { kind: 'run-duration', durationMs: '1200' })

test('turn telemetry round-trips through the run-duration message meta', () => {
  const attached = attachTurnTelemetry(runDurationMessage(), {
    turnStopReason: 'max_tokens',
    usage: { used: 45049, size: 200000, inputTokens: 3, outputTokens: 4, costUsd: 0.056 },
  })

  const read = readTurnTelemetry(attached)
  assert.equal(read?.turnStopReason, 'max_tokens')
  assert.equal(read?.usage?.used, 45049)
  assert.equal(read?.usage?.size, 200000)
  assert.equal(read?.usage?.costUsd, 0.056)
})

test('attaching telemetry preserves the existing run-duration meta', () => {
  const attached = attachTurnTelemetry(runDurationMessage(), {
    turnStopReason: 'end_turn',
  })

  // run-duration 的渲染只认这两个键；遥测是搭便车的，绝不能挤掉它们。
  assert.equal(attached.meta?.kind, 'run-duration')
  assert.equal(attached.meta?.durationMs, '1200')
})

test('a turn with no telemetry leaves the message untouched', () => {
  const original = runDurationMessage()
  const attached = attachTurnTelemetry(original, {})

  // 没数据就不该长出空键——否则每条 run-duration 都被撑大且读回来是 NaN。
  assert.equal(attached, original)
  assert.equal(readTurnTelemetry(original), null)
})

// ---------------------------------------------------------------------------
// 每轮实际用的模型 / 档位 —— 切换只是"下次请求带不同值"，转录里此前无从追溯
// ---------------------------------------------------------------------------

test('the effective model and reasoning tier of a turn are recoverable afterwards', () => {
  const attached = attachTurnTelemetry(runDurationMessage(), {
    model: 'claude-opus-5',
    reasoningEffort: 'xhigh',
    thinkingEnabled: true,
    planMode: false,
  })

  const read = readTurnTelemetry(attached)
  assert.equal(read?.model, 'claude-opus-5')
  assert.equal(read?.reasoningEffort, 'xhigh')
  assert.equal(read?.thinkingEnabled, true)
  assert.equal(read?.planMode, false)
})

test('thinking-off and plan-mode are distinguishable from "not recorded"', () => {
  // false 与 undefined 必须分得开：一条老消息没有这个字段，不等于用户关了思考。
  const off = readTurnTelemetry(
    attachTurnTelemetry(runDurationMessage(), { thinkingEnabled: false, planMode: true }),
  )
  assert.equal(off?.thinkingEnabled, false)
  assert.equal(off?.planMode, true)

  const legacy = readTurnTelemetry(attachTurnTelemetry(runDurationMessage(), { model: 'x' }))
  assert.equal(legacy?.thinkingEnabled, undefined)
  assert.equal(legacy?.planMode, undefined)
})

test('a partially reported turn only persists the fields it actually has', () => {
  const attached = attachTurnTelemetry(runDurationMessage(), {
    usage: { used: 15 },
  })

  assert.equal(readTurnTelemetry(attached)?.usage?.used, 15)
  assert.equal(readTurnTelemetry(attached)?.usage?.size, undefined)
  assert.equal(readTurnTelemetry(attached)?.turnStopReason, undefined)
  assert.equal(attached.meta?.turnUsageSize, undefined)
})

test('summarizeTurnUsage takes the running cost total instead of adding it up again', () => {
  // 2026-08-16 实测用户归档：同一会话三轮的 turnUsageCostUsd 是
  // 120.592 → 120.857 → 121.433 —— CLI 报的是**会话累计**花费，不是单轮增量。
  // 求和会把这段会话算成 362.88 美元，真实值是 121.43。
  const message = (id: string, cost: string, used: string) => ({
    id,
    role: 'assistant' as const,
    content: 'reply',
    createdAt: new Date(2026, 7, 16, 11, 40, 0).toISOString(),
    meta: {
      turnUsageUsed: used,
      turnUsageSize: '200000',
      turnUsageInput: '1000',
      turnUsageOutput: '100',
      turnUsageCostUsd: cost,
    },
  })

  const totals = summarizeTurnUsage([
    message('m-1', '120.592246', '202524283'),
    message('m-2', '120.857241', '489832'),
    message('m-3', '121.432833', '992969'),
  ])

  assert.ok(totals)
  assert.equal(totals?.turns, 3)
  // token 计数是每轮各自的量，求和仍然正确。
  assert.equal(totals?.input, 3000)
  assert.equal(totals?.output, 300)
  assert.ok(Math.abs((totals?.costUsd ?? 0) - 121.432833) < 1e-9)
})

test('summarizeTurnUsage adds completed cost segments when a session restarts its counter', () => {
  // compact / 换 session 会把累计清零重来。旧段已经发生的费用不能丢失。
  const message = (id: string, cost: string) => ({
    id,
    role: 'assistant' as const,
    content: 'reply',
    createdAt: new Date(2026, 7, 16, 11, 40, 0).toISOString(),
    meta: { turnUsageUsed: '1000', turnUsageCostUsd: cost },
  })

  const totals = summarizeTurnUsage([message('m-1', '15.83'), message('m-2', '7.87')])

  assert.ok(Math.abs((totals?.costUsd ?? 0) - 23.7) < 1e-9)
})
