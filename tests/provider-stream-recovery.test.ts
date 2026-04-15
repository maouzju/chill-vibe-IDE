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
