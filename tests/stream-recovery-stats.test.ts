import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  beginLocalRecoveryStatsRun,
  beginOrContinueLocalRecoveryStatsRun,
  continueLocalRecoveryStatsRun,
  noteLocalRecoveryDisconnect,
  settleLocalRecoveryStatsRun,
} from '../src/stream-recovery-stats.js'

describe('stream-recovery-stats', () => {
  it('starting a run records exactly one request', () => {
    const started = beginLocalRecoveryStatsRun()

    assert.deepEqual(started.events, ['request'])
    assert.deepEqual(started.state, { hadRecoverableDisconnect: false })
  })

  it('recoverable disconnects mark the run and emit a disconnect stat', () => {
    const started = beginLocalRecoveryStatsRun()
    const disconnected = noteLocalRecoveryDisconnect(started.state)

    assert.deepEqual(disconnected.events, ['disconnect'])
    assert.deepEqual(disconnected.state, { hadRecoverableDisconnect: true })
  })

  it('successful completion after recovery emits recovery_success once and clears the run state', () => {
    const started = beginLocalRecoveryStatsRun()
    const disconnected = noteLocalRecoveryDisconnect(started.state)
    const settled = settleLocalRecoveryStatsRun(disconnected.state, 'success')

    assert.deepEqual(settled.events, ['recovery_success'])
    assert.equal(settled.state, undefined)
  })

  it('failed completion after recovery emits recovery_fail once and clears the run state', () => {
    const started = beginLocalRecoveryStatsRun()
    const disconnected = noteLocalRecoveryDisconnect(started.state)
    const settled = settleLocalRecoveryStatsRun(disconnected.state, 'failure')

    assert.deepEqual(settled.events, ['recovery_fail'])
    assert.equal(settled.state, undefined)
  })

  it('completion without a recoverable disconnect emits no recovery outcome', () => {
    const started = beginLocalRecoveryStatsRun()
    const settled = settleLocalRecoveryStatsRun(started.state, 'success')

    assert.deepEqual(settled.events, [])
    assert.equal(settled.state, undefined)
  })

  it('abandoned runs clear state without emitting recovery success or failure', () => {
    const started = beginLocalRecoveryStatsRun()
    const disconnected = noteLocalRecoveryDisconnect(started.state)
    const settled = settleLocalRecoveryStatsRun(disconnected.state, 'abandoned')

    assert.deepEqual(settled.events, [])
    assert.equal(settled.state, undefined)
  })


  it('auto recovery retries keep the existing stats run instead of recording another request', () => {
    const started = beginLocalRecoveryStatsRun()
    const disconnected = noteLocalRecoveryDisconnect(started.state)
    const continued = beginOrContinueLocalRecoveryStatsRun(disconnected.state)

    assert.deepEqual(continued.events, [])
    assert.deepEqual(continued.state, { hadRecoverableDisconnect: true })
  })

  it('resume-session retries keep the existing run instead of recording a second request', () => {
    const started = beginLocalRecoveryStatsRun()
    const disconnected = noteLocalRecoveryDisconnect(started.state)
    const continued = continueLocalRecoveryStatsRun(disconnected.state)
    const settled = settleLocalRecoveryStatsRun(continued.state, 'success')

    assert.deepEqual(
      [
        ...started.events,
        ...disconnected.events,
        ...continued.events,
        ...settled.events,
      ],
      ['request', 'disconnect', 'recovery_success'],
    )
    assert.deepEqual(continued.state, { hadRecoverableDisconnect: true })
  })
})
