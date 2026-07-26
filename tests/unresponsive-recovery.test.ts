import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createUnresponsiveRecoveryController,
  resolveUnresponsiveRecoveryDelayMs,
} from '../electron/unresponsive-recovery'

type ScheduledTimer = {
  callback: () => void
  delayMs: number
}

const createFakeTimers = () => {
  let nextId = 1
  const timers = new Map<number, ScheduledTimer>()

  return {
    timers,
    setTimer(callback: () => void, delayMs: number) {
      const id = nextId++
      timers.set(id, { callback, delayMs })
      return id
    },
    clearTimer(id: number) {
      timers.delete(id)
    },
    fire(id: number) {
      const timer = timers.get(id)
      assert.ok(timer, `timer ${id} should exist`)
      timers.delete(id)
      timer.callback()
    },
  }
}

test('persistent unresponsive recovery uses an eight-second default and supports an escape hatch', () => {
  assert.equal(resolveUnresponsiveRecoveryDelayMs(undefined), 8_000)
  assert.equal(resolveUnresponsiveRecoveryDelayMs('12000'), 12_000)
  assert.equal(resolveUnresponsiveRecoveryDelayMs('0'), 0)
  assert.equal(resolveUnresponsiveRecoveryDelayMs('-1'), 8_000)
  assert.equal(resolveUnresponsiveRecoveryDelayMs('not-a-number'), 8_000)
})

test('persistent unresponsive recovery reloads once only when the window stays stuck', () => {
  const fake = createFakeTimers()
  const recoveries: Array<{ startedAtMs: number; recoveredAtMs: number; durationMs: number }> = []
  let nowMs = 1_000
  const controller = createUnresponsiveRecoveryController({
    delayMs: 8_000,
    now: () => nowMs,
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
    onRecover: (event) => recoveries.push(event),
  })

  controller.markUnresponsive()
  controller.markUnresponsive()

  assert.equal(fake.timers.size, 1, 'repeat unresponsive events must not stack reload timers')
  const [timerId, timer] = [...fake.timers.entries()][0]
  assert.equal(timer.delayMs, 8_000)

  nowMs = 9_000
  fake.fire(timerId)

  assert.deepEqual(recoveries, [{ startedAtMs: 1_000, recoveredAtMs: 9_000, durationMs: 8_000 }])
  assert.equal(controller.isArmed(), false)
})

test('responsive and disposed windows cancel a pending renderer reload', () => {
  for (const cancel of ['responsive', 'dispose'] as const) {
    const fake = createFakeTimers()
    let recoveryCount = 0
    const controller = createUnresponsiveRecoveryController({
      delayMs: 8_000,
      now: () => 10,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
      onRecover: () => {
        recoveryCount += 1
      },
    })

    controller.markUnresponsive()
    assert.equal(fake.timers.size, 1)

    if (cancel === 'responsive') {
      controller.markResponsive()
    } else {
      controller.dispose()
    }

    assert.equal(fake.timers.size, 0)
    assert.equal(recoveryCount, 0)
    assert.equal(controller.isArmed(), false)
  }
})

test('disabled recovery never arms a timer', () => {
  const fake = createFakeTimers()
  let recoveryCount = 0
  const controller = createUnresponsiveRecoveryController({
    delayMs: 0,
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
    onRecover: () => {
      recoveryCount += 1
    },
  })

  controller.markUnresponsive()

  assert.equal(fake.timers.size, 0)
  assert.equal(recoveryCount, 0)
})
