import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeRecoveryStatusAfterRetryScheduled,
  computeRecoveryStatusAfterSuccess,
  computeRecoveryStatusAfterFinalFailure,
  shouldClearRecoveryStatusOnStreamIdle,
  type CardRecoveryStatus,
} from '../src/stream-recovery-feedback.js'

describe('stream-recovery-feedback — pure transitions', () => {
  it('retry scheduled produces reconnecting with attempt = previous + 1', () => {
    const next = computeRecoveryStatusAfterRetryScheduled(0, 6)
    assert.deepEqual(next, { kind: 'reconnecting', attempt: 1, max: 6 })

    const later = computeRecoveryStatusAfterRetryScheduled(3, 6)
    assert.deepEqual(later, { kind: 'reconnecting', attempt: 4, max: 6 })
  })

  it('success after reconnecting flips to resumed', () => {
    const previous: CardRecoveryStatus = { kind: 'reconnecting', attempt: 2, max: 6 }
    assert.deepEqual(computeRecoveryStatusAfterSuccess(previous), { kind: 'resumed' })
  })

  it('success with no prior recovery keeps state undefined', () => {
    assert.equal(computeRecoveryStatusAfterSuccess(undefined), undefined)
  })

  it('success after resumed stays resumed (idempotent while timer clears it)', () => {
    const previous: CardRecoveryStatus = { kind: 'resumed' }
    assert.deepEqual(computeRecoveryStatusAfterSuccess(previous), { kind: 'resumed' })
  })

  it('success after failed does not silently revive the bubble', () => {
    const previous: CardRecoveryStatus = { kind: 'failed' }
    // Final failure state should not be overwritten by a late reset signal.
    assert.deepEqual(computeRecoveryStatusAfterSuccess(previous), { kind: 'failed' })
  })

  it('final failure produces failed regardless of prior state', () => {
    assert.deepEqual(computeRecoveryStatusAfterFinalFailure(), { kind: 'failed' })
  })

  it('stream-idle cleanup clears reconnecting and resumed but preserves failed', () => {
    assert.equal(shouldClearRecoveryStatusOnStreamIdle(undefined), true)
    assert.equal(
      shouldClearRecoveryStatusOnStreamIdle({ kind: 'reconnecting', attempt: 1, max: 6 }),
      true,
    )
    assert.equal(shouldClearRecoveryStatusOnStreamIdle({ kind: 'resumed' }), true)
    assert.equal(shouldClearRecoveryStatusOnStreamIdle({ kind: 'failed' }), false)
  })
})
