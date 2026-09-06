import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeRecoveryStatusAfterRetryScheduled,
  computeRecoveryStatusAfterNativeRetry,
  computeRecoveryStatusAfterSuccess,
  computeRecoveryStatusAfterFinalFailure,
  shouldClearRecoveryStatusOnStreamIdle,
  shouldClearRecoveryStatusForNewStream,
  shouldShowManualStreamRecoveryControl,
  type CardRecoveryStatus,
} from '../src/stream-recovery-feedback.js'

describe('stream-recovery-feedback — pure transitions', () => {
  it('native reconnect feedback is idempotent and separate from the IDE retry budget', () => {
    const native = computeRecoveryStatusAfterNativeRetry(undefined)
    assert.deepEqual(native, { kind: 'native-reconnecting' })
    assert.equal(computeRecoveryStatusAfterNativeRetry(native), native)
    assert.deepEqual(computeRecoveryStatusAfterSuccess(native), { kind: 'resumed' })
    assert.deepEqual(computeRecoveryStatusAfterNativeRetry({ kind: 'resumed' }), native)
    assert.deepEqual(computeRecoveryStatusAfterRetryScheduled(0, 6, native), {
      kind: 'reconnecting', attempt: 1, max: 6,
    })
    const failed = computeRecoveryStatusAfterFinalFailure('dead')
    assert.equal(computeRecoveryStatusAfterNativeRetry(failed), failed)
    assert.equal(shouldShowManualStreamRecoveryControl({ cardStatus: 'streaming', recoveryStatus: native }), true)
  })

  it('retry scheduled produces reconnecting with attempt = previous + 1', () => {
    const next = computeRecoveryStatusAfterRetryScheduled(0, 6)
    assert.deepEqual(next, { kind: 'reconnecting', attempt: 1, max: 6 })

    const later = computeRecoveryStatusAfterRetryScheduled(3, 6)
    assert.deepEqual(later, { kind: 'reconnecting', attempt: 4, max: 6 })


    const unlimited = computeRecoveryStatusAfterRetryScheduled(9, Number.POSITIVE_INFINITY)
    assert.deepEqual(unlimited, { kind: 'reconnecting', attempt: 10, max: 'unlimited' })
  })

  it('unbudgeted retry scheduled still advances the visible reconnect attempt', () => {
    const previous: CardRecoveryStatus = { kind: 'reconnecting', attempt: 1, max: 'unlimited' }
    const next = computeRecoveryStatusAfterRetryScheduled(0, Number.POSITIVE_INFINITY, previous)
    assert.deepEqual(next, { kind: 'reconnecting', attempt: 2, max: 'unlimited' })
  })

  it('native retry feedback preserves the IDE resume counter between unbudgeted attempts', () => {
    const first = computeRecoveryStatusAfterRetryScheduled(0, Number.POSITIVE_INFINITY)
    const native = computeRecoveryStatusAfterNativeRetry(first)
    assert.equal(native, first, 'a native retry must not discard an already scheduled IDE attempt')
    assert.deepEqual(computeRecoveryStatusAfterRetryScheduled(0, Number.POSITIVE_INFINITY, native), {
      kind: 'reconnecting', attempt: 2, max: 'unlimited',
    })
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

  it('final failure records the stream it belongs to', () => {
    assert.deepEqual(computeRecoveryStatusAfterFinalFailure('stream-a'), {
      kind: 'failed',
      streamId: 'stream-a',
    })
  })

  // A Claude keepalive pool process survives a mid-response relay disconnect, so
  // the card can be woken again by an unsolicited turn on a BRAND NEW streamId
  // while the sticky `failed` banner from the dead stream is still on screen —
  // "重连失败" over a card that is visibly still working (2026-07-31 实测：卡片
  // 03:44 判失败后 03:47/03:52 又各结算一轮，一路输出到 03:59 仍在跑).
  it('a brand-new stream clears the sticky failed banner', () => {
    assert.equal(
      shouldClearRecoveryStatusForNewStream({ kind: 'failed', streamId: 'dead' }, 'fresh'),
      true,
    )
  })

  it('re-attaching the SAME stream keeps failed (a late signal must not revive it)', () => {
    assert.equal(
      shouldClearRecoveryStatusForNewStream({ kind: 'failed', streamId: 'dead' }, 'dead'),
      false,
    )
  })

  it('new-stream cleanup ignores non-failed states (their own timers own them)', () => {
    assert.equal(shouldClearRecoveryStatusForNewStream(undefined, 'fresh'), false)
    assert.equal(
      shouldClearRecoveryStatusForNewStream({ kind: 'reconnecting', attempt: 1, max: 6 }, 'fresh'),
      false,
    )
    assert.equal(shouldClearRecoveryStatusForNewStream({ kind: 'resumed' }, 'fresh'), false)
  })

  it('a failed state with no recorded stream is cleared by any new stream', () => {
    assert.equal(shouldClearRecoveryStatusForNewStream({ kind: 'failed' }, 'fresh'), true)
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

  it('shows manual recovery only for stuck reconnect states or reconnect placeholders', () => {
    assert.equal(
      shouldShowManualStreamRecoveryControl({
        cardStatus: 'streaming',
        latestAssistantContent: 'Reconnecting… 1/5',
      }),
      true,
    )
    assert.equal(
      shouldShowManualStreamRecoveryControl({
        cardStatus: 'streaming',
        recoveryStatus: { kind: 'reconnecting', attempt: 1, max: 6 },
        latestAssistantContent: '',
      }),
      true,
    )
    assert.equal(
      shouldShowManualStreamRecoveryControl({
        cardStatus: 'error',
        recoveryStatus: { kind: 'failed' },
        latestAssistantContent: 'Final error',
      }),
      true,
    )
    assert.equal(
      shouldShowManualStreamRecoveryControl({
        cardStatus: 'streaming',
        recoveryStatus: { kind: 'resumed' },
        latestAssistantContent: 'Real assistant output resumed.',
      }),
      false,
    )
    assert.equal(
      shouldShowManualStreamRecoveryControl({
        cardStatus: 'idle',
        latestAssistantContent: 'Reconnecting… 1/5',
      }),
      false,
    )
  })

})
