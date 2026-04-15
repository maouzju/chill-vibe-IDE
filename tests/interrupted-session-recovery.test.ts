import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getInterruptedSessionResumeRequest,
  hasInterruptedSessionRetryPayload,
  isInterruptedSessionRecoverable,
} from '../shared/interrupted-session-recovery.ts'

test('retry-last-user-message payloads stay recoverable without a session id', () => {
  const entry = {
    sessionId: undefined,
    resumeMode: 'retry-last-user-message' as const,
    resumePrompt: 'Retry the last step',
    resumeAttachments: [
      {
        id: 'image-1',
        fileName: 'repro.png',
        mimeType: 'image/png' as const,
        sizeBytes: 2048,
      },
    ],
  }

  assert.equal(hasInterruptedSessionRetryPayload(entry), true)
  assert.equal(isInterruptedSessionRecoverable(entry), true)
  assert.deepEqual(getInterruptedSessionResumeRequest(entry), {
    sessionId: undefined,
    prompt: 'Retry the last step',
    attachments: entry.resumeAttachments,
  })
})

test('empty retry payloads without a session id do not claim to be recoverable', () => {
  const entry = {
    sessionId: undefined,
    resumeMode: 'retry-last-user-message' as const,
    resumePrompt: '   ',
    resumeAttachments: [],
  }

  assert.equal(hasInterruptedSessionRetryPayload(entry), false)
  assert.equal(isInterruptedSessionRecoverable(entry), false)
  assert.equal(getInterruptedSessionResumeRequest(entry), null)
})
