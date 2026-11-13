import assert from 'node:assert/strict'
import test from 'node:test'

import { createMessage } from '../shared/default-state.ts'
import type {
  ChatRequest,
  StreamActivity,
  StreamContextUsageEvent,
  StreamEventMap,
} from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'
import {
  mapClaudeTurnStopReason,
  readClaudeCompactBoundary,
  readClaudeContextWindow,
  readClaudeRequestContextUsage,
  readClaudeTurnUsage,
  readCodexContextUsage,
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

// ---------------------------------------------------------------------------
// 上下文占用的实时信号（docs/specs/context-usage-auto-compact）
// ---------------------------------------------------------------------------

// 2026-11-12 实测夹具：claude 2.1.233 `-p --output-format stream-json --include-partial-messages`
// 的真实行（只删掉了与用量无关的 id / uuid / 计费明细）。
const realMessageStart = {
  type: 'stream_event',
  event: {
    type: 'message_start',
    message: {
      model: 'claude-haiku-4-5-20251001',
      type: 'message',
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 44278,
        cache_read_input_tokens: 0,
        output_tokens: 1,
        service_tier: 'standard',
      },
    },
  },
  session_id: 'ddcabbbe-0000-4000-8000-000000000000',
  parent_tool_use_id: null,
} satisfies Record<string, unknown>

const realMessageDelta = {
  type: 'stream_event',
  event: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 44278,
      cache_read_input_tokens: 0,
      output_tokens: 89,
      output_tokens_details: { thinking_tokens: 81 },
    },
  },
  session_id: 'ddcabbbe-0000-4000-8000-000000000000',
  parent_tool_use_id: null,
} satisfies Record<string, unknown>

const realCompactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'ddcabbbe-0000-4000-8000-000000000000',
  compact_metadata: {
    trigger: 'manual',
    pre_tokens: 44641,
    post_tokens: 891,
    cumulative_dropped_tokens: 43750,
    duration_ms: 22163,
  },
} satisfies Record<string, unknown>

// 手动 /compact 回合的 result：usage 全 0、没有任何 stream_event，但仍带 contextWindow。
const realCompactResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 22170,
  num_turns: 0,
  result: '',
  stop_reason: null,
  session_id: 'ddcabbbe-0000-4000-8000-000000000000',
  total_cost_usd: 0.0563255,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    iterations: [],
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
} satisfies Record<string, unknown>

const runClaudeLines = (events: Record<string, unknown>[]) => {
  const timeline: string[] = []
  const contextUsage: StreamContextUsageEvent[] = []
  const activities: StreamActivity[] = []
  const errors: string[] = []
  const parser = createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    sink: {
      onSession: () => {},
      onDelta: () => {},
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: (activity) => {
        activities.push(activity)
        timeline.push(`activity:${activity.kind}`)
      },
      onContextUsage: (event) => {
        contextUsage.push(event)
        timeline.push('context_usage')
      },
      onDone: () => timeline.push('done'),
      onError: (message: string) => errors.push(message),
    },
  })

  for (const event of events) {
    parser.handleLine(JSON.stringify(event))
  }

  return { timeline, contextUsage, activities, errors }
}

test('a Claude request reports its context occupancy as soon as it starts', () => {
  // 占用 = 这一次请求的输入侧（含两类缓存）+ 输出，不是一回合所有请求之和（pitfall #322）。
  assert.equal(readClaudeRequestContextUsage(realMessageStart), 10 + 44278 + 0 + 1)
  // message_delta 的用量在 event.usage（不是 delta.usage），带着最终输出。
  assert.equal(readClaudeRequestContextUsage(realMessageDelta), 10 + 44278 + 0 + 89)
})

test('sub-agent requests never count toward the main thread context occupancy', () => {
  // 子 Agent 有自己的上下文窗口；把它的请求算进来会让主线程占用在 45k 和 3k 之间乱跳。
  assert.equal(
    readClaudeRequestContextUsage({ ...realMessageStart, parent_tool_use_id: 'toolu_01abc' }),
    undefined,
  )
})

test('a message_delta without input-side tokens is not reported as occupancy', () => {
  // 只有输出的 delta 会把 45k 的占用报成 89 —— 宁可不报，沿用 message_start 的值。
  assert.equal(
    readClaudeRequestContextUsage({
      ...realMessageDelta,
      event: { type: 'message_delta', delta: {}, usage: { output_tokens: 89 } },
    }),
    undefined,
  )
  assert.equal(readClaudeRequestContextUsage(realSuccessResult), undefined)
  assert.equal(
    readClaudeRequestContextUsage({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      parent_tool_use_id: null,
    }),
    undefined,
  )
})

test('the Claude context window comes from what the CLI itself reports', () => {
  assert.equal(readClaudeContextWindow(realSuccessResult), 200000)
  assert.equal(readClaudeContextWindow(realCompactResult), 200000)
  assert.equal(readClaudeContextWindow({ type: 'result' }), undefined)
})

test('a Claude compact boundary is recognised with its trigger', () => {
  assert.deepEqual(readClaudeCompactBoundary(realCompactBoundary), {
    trigger: 'manual',
    preTokens: 44641,
  })
  assert.deepEqual(
    readClaudeCompactBoundary({
      ...realCompactBoundary,
      compact_metadata: { trigger: 'auto', pre_tokens: 181234 },
    }),
    { trigger: 'auto', preTokens: 181234 },
  )
  // CLI 回合内自带的自动压缩没实测到 trigger 取值：不是 manual 就按自动处理。
  assert.deepEqual(
    readClaudeCompactBoundary({ type: 'system', subtype: 'compact_boundary' }),
    { trigger: 'auto', preTokens: undefined },
  )
  assert.equal(readClaudeCompactBoundary({ type: 'system', subtype: 'init' }), undefined)
  assert.equal(readClaudeCompactBoundary(realSuccessResult), undefined)
})

test('a Claude turn streams occupancy during the turn and the window before done', () => {
  const { timeline, contextUsage, errors } = runClaudeLines([
    realMessageStart,
    realMessageDelta,
    realSuccessResult,
  ])

  assert.deepEqual(errors, [])
  assert.deepEqual(contextUsage, [
    { used: 44289 },
    { used: 44377 },
    // result 才知道窗口大小；它必须排在 done 之前，终态之后的事件会被 chat-manager 丢掉。
    { used: 44377, size: 200000 },
  ])
  assert.deepEqual(timeline, ['context_usage', 'context_usage', 'context_usage', 'done'])
})

test('a manual Claude /compact resets occupancy without a duplicate compaction activity', () => {
  const { contextUsage, activities, errors } = runClaudeLines([
    realCompactBoundary,
    realCompactResult,
  ])

  assert.deepEqual(errors, [])
  // 压缩后的占用是未知：post_tokens（891）不含系统提示和工具定义，下一次请求实测 45261。
  assert.deepEqual(contextUsage, [{ reset: true }, { size: 200000 }])
  // 渲染端已经为用户敲的 /compact 建了边界，再发活动会重复插一条。
  assert.deepEqual(
    activities.filter((activity) => activity.kind === 'compaction'),
    [],
  )
})

test('a CLI-initiated Claude compaction surfaces as an auto compaction activity', () => {
  const { contextUsage, activities } = runClaudeLines([
    realMessageStart,
    {
      ...realCompactBoundary,
      compact_metadata: { trigger: 'auto', pre_tokens: 181234, post_tokens: 2100 },
    },
  ])

  assert.deepEqual(contextUsage, [{ used: 44289 }, { reset: true }])
  const compactions = activities.filter((activity) => activity.kind === 'compaction')
  assert.equal(compactions.length, 1)
  assert.equal(compactions[0]?.kind === 'compaction' ? compactions[0].trigger : undefined, 'auto')
})

// Codex 协议 0.147.0（`codex app-server generate-ts` 导出的 ThreadTokenUsageUpdatedNotification）。
// 数值取自本机历史会话记录里的真实用量事件；线上通知没能实测（中转站 401）。
const codexTokenUsageParams = {
  threadId: 'thread-root',
  turnId: 'turn-1',
  tokenUsage: {
    total: {
      totalTokens: 28954,
      inputTokens: 28412,
      cachedInputTokens: 12800,
      cacheWriteInputTokens: 0,
      outputTokens: 542,
      reasoningOutputTokens: 320,
    },
    last: {
      totalTokens: 14494,
      inputTokens: 14223,
      cachedInputTokens: 12800,
      cacheWriteInputTokens: 0,
      outputTokens: 271,
      reasoningOutputTokens: 160,
    },
    modelContextWindow: 258400,
  },
} satisfies Record<string, unknown>

test('a Codex token usage notification yields the last request occupancy and the window', () => {
  // 占用取 last（最近一次请求），不是 total（整个线程累计，会越过窗口大小）。
  assert.deepEqual(readCodexContextUsage(codexTokenUsageParams), {
    threadId: 'thread-root',
    used: 14494,
    size: 258400,
  })
})

test('a Codex token usage notification without a window still reports occupancy', () => {
  assert.deepEqual(
    readCodexContextUsage({
      ...codexTokenUsageParams,
      tokenUsage: { ...codexTokenUsageParams.tokenUsage, modelContextWindow: null },
    }),
    { threadId: 'thread-root', used: 14494, size: undefined },
  )
  assert.equal(readCodexContextUsage({ threadId: 'thread-root' }), undefined)
  assert.equal(readCodexContextUsage({ threadId: 'thread-root', tokenUsage: { last: {} } }), undefined)
})
