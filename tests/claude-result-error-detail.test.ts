import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatRequest } from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'

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

const runResultLine = (event: Record<string, unknown>, language: 'zh-CN' | 'en' = 'zh-CN') => {
  const errors: string[] = []
  const logs: string[] = []
  createClaudeTurnParser({
    request,
    language,
    killChild: () => {},
    sink: {
      onSession: () => {},
      onDelta: () => {},
      onLog: (message: string) => logs.push(message),
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: () => {},
      onError: (message: string) => errors.push(message),
    },
  }).handleLine(JSON.stringify(event))
  return { errors, logs }
}

// 2026-08-14 现场：五个会话在四分钟内接连红出「Claude 运行失败。」，日志与转录里
// 查不到任何原因。根因是 claude 2.1.206 的 result 事件分两套字段——只有
// subtype==='success' 时错误文本在 `result`，error_during_execution /
// error_max_turns **根本不带 result 字段**，真实原因只在 `errors` 数组里
// （官方 CLI 自己就是 `subtype==='success' ? result : errors.join('; ')`）。
// 旧实现只读 `result`，于是把唯一的线索整个丢掉，只剩无信息量的兜底文案。
test('Claude result errors surface the native errors array instead of a generic fallback', () => {
  const duringExecution = runResultLine({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'api_error',
    errors: ['[ede_diagnostic] turn aborted (api_error) stop_reason=null'],
  })

  assert.equal(duringExecution.errors.length, 1)
  assert.match(duringExecution.errors[0] ?? '', /ede_diagnostic/)
  assert.match(duringExecution.errors[0] ?? '', /api_error/)
  assert.doesNotMatch(duringExecution.errors[0] ?? '', /^Claude 运行失败。$/)

  const maxTurns = runResultLine({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    errors: ['Reached maximum number of turns (50)'],
  })
  assert.match(maxTurns.errors[0] ?? '', /Reached maximum number of turns \(50\)/)

  // 多条 errors 要全部带出，不能只报第一条。
  const multi = runResultLine({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['first failure', 'second failure'],
  })
  assert.match(multi.errors[0] ?? '', /first failure/)
  assert.match(multi.errors[0] ?? '', /second failure/)
})

// subtype==='success' 且 is_error 时错误文本仍在 `result` —— 旧行为必须原样保留。
test('Claude result errors keep using the result string when the subtype is success', () => {
  const { errors } = runResultLine({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Credit balance is too low',
  })
  assert.deepEqual(errors, ['Credit balance is too low'])
})

// 没有任何可用字段时才允许退回兜底文案，且要带上 subtype 以便定位。
test('Claude result errors fall back to a labelled message when the CLI reports nothing', () => {
  const { errors } = runResultLine({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /Claude 运行失败/)
  assert.match(errors[0] ?? '', /error_during_execution/)
})

// aborted_streaming / aborted_tools 是 CLI 眼里的良性中止（官方 CLI 自己既不按 error
// 级别记日志，也不渲染错误 UI）。它们不该和 api_error 这类真失败共用同一句文案。
test('Claude result errors distinguish a benign abort from a real failure', () => {
  for (const terminalReason of ['aborted_streaming', 'aborted_tools']) {
    const { errors } = runResultLine({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: terminalReason,
      errors: [`[ede_diagnostic] turn aborted (${terminalReason}) stop_reason=null`],
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0] ?? '', /中止/)
    assert.doesNotMatch(errors[0] ?? '', /运行失败/)
  }
})
