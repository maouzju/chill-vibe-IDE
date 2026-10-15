import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatRequest } from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'
import { classifyProviderStreamErrorRecovery } from '../server/provider-stream-recovery.ts'

// 2026-09-29 现场：v0.20.31 已在 spawn 前摘合成回复（#386），用户仍红出
//   `API Error: 400 messages.1: system content must contain at least one block`，停在终态。
// 存档修复只在新起进程时跑；错误一旦出现，卡片既不续传、常驻进程也不丢，
// 下一条消息仍打到同一个带坏历史的进程上。
const message =
  'API Error: 400 messages.1: system content must contain at least one block (request id: 20260929001655864-338b3663)'

test('empty-system 400 is resumable so a fresh process can repair the transcript', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery({ sessionId: 's-1' }, message),
    { recoverable: true, recoveryMode: 'resume-session' },
  )
})

test('empty-system 400 discards the pooled process instead of reusing its poisoned history', () => {
  const request = {
    provider: 'claude', workspacePath: '.', model: 'claude-opus-5', reasoningEffort: 'max',
    thinkingEnabled: true, planMode: false, language: 'zh-CN', systemPrompt: '', modelPromptRules: [],
    crossProviderSkillReuseEnabled: true, prompt: 'test', attachments: [], sessionId: 's-1',
  } as ChatRequest
  let killed = 0
  const errors: string[] = []
  createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => { killed += 1 },
    sink: {
      onSession: () => {}, onDelta: () => {}, onLog: () => {}, onAssistantMessage: () => {},
      onActivity: () => {}, onDone: () => {}, onError: (m: string) => errors.push(m),
    },
  }).handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: message,
  }))
  assert.equal(errors.length, 1)
  assert.equal(killed, 1)
})

const thinkingMessage =
  'API Error: 400 ...thinking: each thinking block must contain thinking (request id: 20261002111355699-3d98ed78)'

test('empty-thinking 400 is resumable and discards the pooled process', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery({ sessionId: 's-1' }, thinkingMessage),
    { recoverable: true, recoveryMode: 'resume-session' },
  )
  const request = {
    provider: 'claude', workspacePath: '.', model: 'claude-opus-5', reasoningEffort: 'max',
    thinkingEnabled: true, planMode: false, language: 'zh-CN', systemPrompt: '', modelPromptRules: [],
    crossProviderSkillReuseEnabled: true, prompt: 'test', attachments: [], sessionId: 's-1',
  } as ChatRequest
  let killed = 0
  createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => { killed += 1 },
    sink: {
      onSession: () => {}, onDelta: () => {}, onLog: () => {}, onAssistantMessage: () => {},
      onActivity: () => {}, onDone: () => {}, onError: () => {},
    },
  }).handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: thinkingMessage,
  }))
  assert.equal(killed, 1)
})

// 2026-10-14 现场（server.log 2026-10-13T17:31:01Z，sessionId=cabe086e…）：同一条 400 停在终态没续传。
// 中转站 request id 是时间戳，`20261014013102819` 里含子串 `401`，被当成鉴权错 hint=switch-config，
// 分类器见到 switch-config 直接判不可恢复。必须走真实 parser（带 hint）才能复现。
const liveThinkingMessage =
  'API Error: 400 ***.***.***.***.thinking: each thinking block must contain thinking (request id: 20261014013102819-9f987d9b) (request id: 202610131731028054108368268d9d6zeqjffA7) (request id: 202610131731025571881078268d9d6shrlbwm9) (request id: 202610131731018717590168268d9d6CjTj1TwS)'

test('empty-thinking 400 whose relay request ids contain 401/403 is still resumable', () => {
  const request = {
    provider: 'claude', workspacePath: '.', model: 'claude-opus-5', reasoningEffort: 'max',
    thinkingEnabled: true, planMode: false, language: 'zh-CN', systemPrompt: '', modelPromptRules: [],
    crossProviderSkillReuseEnabled: true, prompt: 'test', attachments: [], sessionId: 's-1',
  } as ChatRequest
  const errors: Array<{ hint: unknown; recovery: unknown }> = []
  createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    sink: {
      onSession: () => {}, onDelta: () => {}, onLog: () => {}, onAssistantMessage: () => {},
      onActivity: () => {}, onDone: () => {},
      onError: (_m: string, hint?: unknown, recovery?: unknown) => errors.push({ hint, recovery }),
    },
  }).handleLine(JSON.stringify({
    type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: liveThinkingMessage,
  }))
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.hint, undefined)
  assert.deepEqual(errors[0]!.recovery, { recoverable: true, recoveryMode: 'resume-session' })
})
