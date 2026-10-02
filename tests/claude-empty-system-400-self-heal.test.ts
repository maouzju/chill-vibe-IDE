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
