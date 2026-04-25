import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRecoverableStreamRetryLimit,
  resolveStreamRecoveryMode,
  shouldFallbackToFreshSessionAfterTransientResumeLoop,
  shouldKeepRecoveringTransientResumeWithFreshSession,
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
  assert.equal(shouldResetStreamRecoveryAttemptsForText('Reconnecting... 1/5Reconnecting... 2/5'), false)
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

test('repeated transient resume loops fall back to a fresh session escape hatch', () => {
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: true,
      transientResumeAttempt: 2,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )

  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: true,
      transientResumeAttempt: 3,
      maxTransientResumeAttempts: 3,
    }),
    true,
  )
})

test('fresh-session fallback only applies to recoverable placeholder-only session resumes', () => {
  const base = {
    recoverable: true,
    recoveryMode: 'resume-session' as const,
    transientOnly: true,
    hasSessionId: true,
    transientResumeAttempt: 4,
    maxTransientResumeAttempts: 3,
  }

  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      recoverable: false,
    }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      recoveryMode: 'reattach-stream',
    }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      transientOnly: false,
    }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      hasSessionId: false,
    }),
    false,
  )
})

test('transient-only resume recovery keeps using fresh-session recovery after the session id is gone', () => {
  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: false,
      transientResumeAttempt: 1,
      maxTransientResumeAttempts: 3,
    }),
    true,
  )

  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: true,
      transientResumeAttempt: 3,
      maxTransientResumeAttempts: 3,
    }),
    true,
  )
})

test('fresh-session transient recovery does not apply to non-transient or non-resume failures', () => {
  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'reattach-stream',
      transientOnly: true,
      hasSessionId: false,
      transientResumeAttempt: 5,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )

  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: false,
      hasSessionId: false,
      transientResumeAttempt: 5,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )

  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: false,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: false,
      transientResumeAttempt: 5,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )
})

test('recoverable stream retry limit accepts unlimited and clamps invalid configured values', () => {
  assert.equal(getRecoverableStreamRetryLimit(6), 6)
  assert.equal(getRecoverableStreamRetryLimit(-1), Number.POSITIVE_INFINITY)
  assert.equal(getRecoverableStreamRetryLimit(0), 0)
  assert.equal(getRecoverableStreamRetryLimit(51), 6)
  assert.equal(getRecoverableStreamRetryLimit(undefined), 6)
})
