import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraftSyncScheduler, draftSyncIdleMs } from '../src/components/chat-draft-sync.ts'

test('draft sync waits for 3 seconds of idle time before flushing', () => {
  const synced: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimerId = 1

  const scheduler = createDraftSyncScheduler({
    onSync: (draft) => {
      synced.push(draft)
    },
    setTimeoutFn: (callback, delayMs) => {
      assert.equal(delayMs, draftSyncIdleMs)
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, callback)
      return timerId
    },
    clearTimeoutFn: (handle) => {
      timers.delete(handle as number)
    },
  })

  scheduler.schedule('hello')
  assert.deepEqual(synced, [])
  assert.equal(timers.size, 1)

  timers.values().next().value?.()
  assert.deepEqual(synced, ['hello'])
  assert.equal(scheduler.hasPending(), false)
})

test('draft sync keeps the latest value when typing resumes before idle timeout', () => {
  const synced: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimerId = 1

  const scheduler = createDraftSyncScheduler({
    onSync: (draft) => {
      synced.push(draft)
    },
    setTimeoutFn: (callback) => {
      const timerId = nextTimerId
      nextTimerId += 1
      timers.set(timerId, callback)
      return timerId
    },
    clearTimeoutFn: (handle) => {
      timers.delete(handle as number)
    },
  })

  scheduler.schedule('hel')
  scheduler.schedule('hello')

  assert.equal(timers.size, 1)
  timers.values().next().value?.()
  assert.deepEqual(synced, ['hello'])
})

test('draft sync can flush immediately on a non-input action without waiting for idle timeout', () => {
  const synced: string[] = []

  const scheduler = createDraftSyncScheduler({
    onSync: (draft) => {
      synced.push(draft)
    },
  })

  scheduler.markPending('draft to keep')
  assert.equal(scheduler.flush(), true)
  assert.deepEqual(synced, ['draft to keep'])
  assert.equal(scheduler.hasPending(), false)
})

test('draft sync can keep edits pending without scheduling an idle flush', () => {
  const synced: string[] = []
  let scheduled = false

  const scheduler = createDraftSyncScheduler({
    idleMs: 0,
    onSync: (draft) => {
      synced.push(draft)
    },
    setTimeoutFn: () => {
      scheduled = true
      return 1
    },
    clearTimeoutFn: () => undefined,
  })

  scheduler.schedule('hold until blur')

  assert.equal(scheduled, false)
  assert.equal(scheduler.hasPending(), true)
  assert.deepEqual(synced, [])

  assert.equal(scheduler.flush(), true)
  assert.deepEqual(synced, ['hold until blur'])
  assert.equal(scheduler.hasPending(), false)
})
