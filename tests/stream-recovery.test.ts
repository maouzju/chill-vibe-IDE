import assert from 'node:assert/strict'
import test from 'node:test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import {
  getRecoverableStreamRetryLimit,
  getRecoverableStreamErrorSessionId,
  resolveStreamRecoveryMode,
  resolveStreamRecoveryCheckpointTurn,
  shouldFallbackToFreshSessionAfterResumeLoop,
  shouldFallbackToFreshSessionAfterTransientResumeLoop,
  shouldKeepRecoveringResumeWithFreshSession,
  shouldKeepRecoveringTransientResumeWithFreshSession,
  shouldResetStreamRecoveryAttemptsForActivity,
  shouldResetStreamRecoveryAttemptsForText,
} from '../src/stream-recovery.ts'

const recoveryMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  meta?: Record<string, string>,
) => ({ id, role, content, createdAt: '2026-07-15T01:08:29.358Z', meta })

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

test('recoverable resume-session errors expose their fallback session id', () => {
  assert.equal(
    getRecoverableStreamErrorSessionId({
      recoverable: true,
      recoveryMode: 'resume-session',
      sessionId: ' session-1 ',
    }),
    'session-1',
  )

  assert.equal(
    getRecoverableStreamErrorSessionId({
      recoverable: true,
      recoveryMode: 'reattach-stream',
      sessionId: 'session-1',
    }),
    null,
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
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('activity', 'reasoning'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('activity', 'command'), true)
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

test('repeated ordinary stalled resume loops also fall back to a fresh session', () => {
  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      hasSessionId: true,
      resumeAttempt: 1,
      maxResumeAttempts: 2,
    }),
    false,
  )

  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      hasSessionId: true,
      resumeAttempt: 2,
      maxResumeAttempts: 2,
    }),
    true,
  )
})

test('recoverable resume failures without a usable session keep recovering through a fresh session', () => {
  assert.equal(
    shouldKeepRecoveringResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      hasSessionId: false,
      resumeAttempt: 1,
      maxResumeAttempts: 2,
    }),
    true,
  )
})

test('fresh-session fallback ignores unrecoverable and reattach-only failures', () => {
  const base = {
    recoverable: true,
    recoveryMode: 'resume-session' as const,
    hasSessionId: true,
    resumeAttempt: 2,
    maxResumeAttempts: 2,
  }

  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({ ...base, recoverable: false }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({ ...base, recoveryMode: 'reattach-stream' }),
    false,
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

test('checkpoint recovery selects the latest user turn when it is still the visible tail', () => {
  const turn = resolveStreamRecoveryCheckpointTurn({
    messages: [
      recoveryMessage('assistant-old', 'assistant', 'Earlier completed reply'),
      recoveryMessage('user-current', 'user', 'Finish the current repair'),
    ],
    streamId: 'stream-current',
  })

  assert.equal(turn?.message.id, 'user-current')
  assert.equal(turn?.prompt, 'Finish the current repair')
  assert.deepEqual(turn?.attachments, [])
})

test('checkpoint recovery accepts current-stream output after the unfinished user turn', () => {
  const turn = resolveStreamRecoveryCheckpointTurn({
    messages: [
      recoveryMessage('user-current', 'user', 'Finish the current repair'),
      recoveryMessage('reasoning-current', 'assistant', '', {
        kind: 'reasoning',
        streamId: 'stream-current',
      }),
    ],
    streamId: 'stream-current',
  })

  assert.equal(turn?.message.id, 'user-current')
})

test('checkpoint recovery rejects ambiguous old turns and empty continuations', () => {
  assert.equal(
    resolveStreamRecoveryCheckpointTurn({
      messages: [
        recoveryMessage('user-old', 'user', 'Old request'),
        recoveryMessage('assistant-old', 'assistant', 'Already completed'),
      ],
      streamId: 'stream-current',
    }),
    null,
  )

  assert.equal(
    resolveStreamRecoveryCheckpointTurn({
      messages: [recoveryMessage('user-empty', 'user', '   ')],
      streamId: 'stream-current',
    }),
    null,
  )
})

test('checkpoint recovery preserves attachment-only user turns', () => {
  const attachment = {
    id: 'image-current',
    fileName: 'evidence.png',
    mimeType: 'image/png' as const,
    sizeBytes: 2048,
  }
  const turn = resolveStreamRecoveryCheckpointTurn({
    messages: [
      recoveryMessage(
        'user-image',
        'user',
        '',
        attachImagesToMessageMeta([attachment]),
      ),
    ],
    streamId: 'stream-current',
  })

  assert.deepEqual(turn?.attachments, [attachment])
})
