import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyProviderStreamErrorRecovery } from '../server/provider-stream-recovery.ts'
import { isRelaySessionBlockedMessage } from '../shared/relay-session-blocked.ts'
import { resolveRelayBlockedSessionRecoveryOptions } from '../src/stream-recovery.ts'

// 2026-11-26 server.log 原文（request id 已改成占位）。CLI 给 403 统一加 "Failed to authenticate." 前缀。
const aiResearchBlock =
  'Failed to authenticate. API Error: 403 该会话因触发上游 AI 研究类拒答已被暂时屏蔽，请开启新会话 / This session is temporarily blocked after an upstream AI-research refusal, please start a new session (request id: 20260000000000000-00000000)'
const securityPolicyBlock =
  'Failed to authenticate. API Error: 403 该会话已被网络安全策略屏蔽，请开启新会话 (request id: 20260000000000000-00000000)'

test('relay "session blocked, start a new session" 403s are recognised in both wordings', () => {
  assert.equal(isRelaySessionBlockedMessage(aiResearchBlock), true)
  assert.equal(isRelaySessionBlockedMessage(securityPolicyBlock), true)
  assert.equal(
    isRelaySessionBlockedMessage('API Error: 403 This session is temporarily blocked, please start a new session'),
    true,
  )
})

test('ordinary auth / quota 403s and plain prose are not treated as a blocked session', () => {
  assert.equal(
    isRelaySessionBlockedMessage('Failed to authenticate. API Error: 403 预扣费额度失败, 用户剩余额度不足'),
    false,
  )
  assert.equal(isRelaySessionBlockedMessage('Failed to authenticate. API Error: 401 invalid api key'), false)
  assert.equal(isRelaySessionBlockedMessage('API Error: 503 No accounts are currently available.'), false)
  // 模型自己说的话里出现「开启新会话」不算。
  assert.equal(isRelaySessionBlockedMessage('建议你开启新会话再试一次'), false)
})

test('a blocked session is recoverable even though the CLI tags it as an auth (switch-config) failure', () => {
  const recoverable = { recoverable: true, recoveryMode: 'resume-session' }
  assert.deepEqual(classifyProviderStreamErrorRecovery({ sessionId: 's-1' }, aiResearchBlock), recoverable)
  assert.deepEqual(
    classifyProviderStreamErrorRecovery({ sessionId: 's-1' }, aiResearchBlock, 'switch-config'),
    recoverable,
  )
  assert.deepEqual(
    classifyProviderStreamErrorRecovery({ sessionId: 's-1' }, securityPolicyBlock, 'switch-config'),
    recoverable,
  )
  // 真正的鉴权失败仍然不续传。
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      { sessionId: 's-1' },
      'Failed to authenticate. API Error: 403 预扣费额度失败',
      'switch-config',
    ),
    {},
  )
})

test('recovering a relay-blocked session never forks or resumes it: it restarts from visible history', () => {
  // 自动续传（无选项）、手动「重连」与兜底续传（清会话 + 原生检查点）都必须落到「清会话、不分叉」。
  for (const options of [
    undefined,
    {},
    { clearSessionId: true, preferNativeCheckpoint: true },
    { preferNativeCheckpoint: true },
  ]) {
    assert.deepEqual(
      resolveRelayBlockedSessionRecoveryOptions({
        options,
        sessionId: 'blocked-1',
        blockedSessionId: 'blocked-1',
      }),
      { clearSessionId: true, preferNativeCheckpoint: false, freshSessionOnly: false },
    )
  }
})

test('recovery options are untouched when the card has moved on to a different session', () => {
  assert.deepEqual(
    resolveRelayBlockedSessionRecoveryOptions({
      options: { clearSessionId: true, preferNativeCheckpoint: true },
      sessionId: 'healthy-2',
      blockedSessionId: 'blocked-1',
    }),
    { clearSessionId: true, preferNativeCheckpoint: true, freshSessionOnly: false },
  )
  assert.deepEqual(
    resolveRelayBlockedSessionRecoveryOptions({
      options: undefined,
      sessionId: 'healthy-2',
      blockedSessionId: undefined,
    }),
    { clearSessionId: false, preferNativeCheckpoint: false, freshSessionOnly: false },
  )
  assert.deepEqual(
    resolveRelayBlockedSessionRecoveryOptions({
      options: { freshSessionOnly: true },
      sessionId: undefined,
      blockedSessionId: 'blocked-1',
    }),
    { clearSessionId: false, preferNativeCheckpoint: false, freshSessionOnly: true },
  )
})
