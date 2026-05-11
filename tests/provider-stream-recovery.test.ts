import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyProviderStreamErrorRecovery } from '../server/provider-stream-recovery.ts'

test('provider unexpected completion with an existing session becomes resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Claude ended without emitting a terminal completion event.',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})


test('provider zero status exit after a live session is resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Codex exited with status code: 0',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})


test('capacity errors after a live session are resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Selected model is at capacity. Please try a different model.',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('third-party extra-usage 403 after a live session is resumable because credits can be claimed externally', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Failed to authenticate. API Error: 403 {"error":{"message":"Third-party apps now draw from your extra usage, not your plan limits. We\'ve added a $200 credit to get you started. Claim it at ***.ai/settings/usage and keep going.","type":"<nil>"},"type":"error"}',
      'switch-config',
    ),
    {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  )
})

test('setup and routing errors stay non-recoverable even with a session', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: 'session-1',
      },
      'Codex exited with status code: 1',
      'switch-config',
    ),
    {},
  )
})

test('errors without a session id are not resumable', () => {
  assert.deepEqual(
    classifyProviderStreamErrorRecovery(
      {
        sessionId: undefined,
      },
      'Claude ended without emitting a terminal completion event.',
    ),
    {},
  )
})
