import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStreamRecoveryMode } from '../src/stream-recovery.ts'

test('recoverable resume-session errors keep the resume strategy when a session id exists', () => {
  assert.equal(
    resolveStreamRecoveryMode(
      {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
      true,
    ),
    'resume-session',
  )
})

test('recoverable resume-session errors fall back to reattach without a session id', () => {
  assert.equal(
    resolveStreamRecoveryMode(
      {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
      false,
    ),
    'reattach-stream',
  )
})

test('non-recoverable errors do not trigger stream recovery', () => {
  assert.equal(
    resolveStreamRecoveryMode(
      {
        recoverable: false,
      },
      true,
    ),
    null,
  )
})
