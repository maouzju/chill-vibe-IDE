import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveStreamRecoveryMode,
  shouldResetStreamRecoveryAttemptsForActivity,
  shouldResetStreamRecoveryAttemptsForText,
} from '../src/stream-recovery.ts'

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

test('transport reconnect placeholders do not reset the recovery retry budget', () => {
  assert.equal(shouldResetStreamRecoveryAttemptsForText('Reconnecting... 1/5'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForText('Reconnecting 1/5'), false)
})

test('real assistant output still resets the recovery retry budget', () => {
  assert.equal(shouldResetStreamRecoveryAttemptsForText('我已经恢复并继续处理了。'), true)
  assert.equal(shouldResetStreamRecoveryAttemptsForText(''), false)
})

test('only meaningful activity resets the recovery retry budget', () => {
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('session'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('log'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('activity'), true)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('assistant_message'), true)
})
