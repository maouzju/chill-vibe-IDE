import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraftEchoTracker, createDraftSyncScheduler, draftSyncIdleMs } from '../src/components/chat-draft-sync.ts'

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

// 2026-11-20 审查：空闲 3 秒同步出去的旧值 v 经 App 回到 card.draft 时，用户已经又敲了字，
// 回写 effect 把输入框改回 v，吞掉刚敲的字、光标跳到末尾。
test('draft echo tracker recognises the value this composer just synced out', () => {
  const tracker = createDraftEchoTracker()
  assert.equal(tracker.consumeIncoming(''), false)

  tracker.noteOutgoing('hello')
  assert.equal(tracker.consumeIncoming('hello'), true)
  // 同一个值回来过一次之后，再出现就是外部改动。
  assert.equal(tracker.consumeIncoming('hello'), false)
})

test('draft echo tracker lets external draft changes through', () => {
  const tracker = createDraftEchoTracker()
  tracker.consumeIncoming('')
  tracker.noteOutgoing('typed')
  assert.equal(tracker.consumeIncoming('restored from elsewhere'), false)
  // 外部改动之后，旧的回声不再被认领。
  assert.equal(tracker.consumeIncoming('typed'), false)
})

test('draft echo tracker handles several syncs landing one by one', () => {
  const tracker = createDraftEchoTracker()
  tracker.consumeIncoming('')
  tracker.noteOutgoing('a')
  tracker.noteOutgoing('ab')
  assert.equal(tracker.consumeIncoming('a'), true)
  assert.equal(tracker.consumeIncoming('ab'), true)
})

test('draft echo tracker ignores syncs that do not change the card draft', () => {
  const tracker = createDraftEchoTracker()
  tracker.consumeIncoming('same')
  // card.draft 已经是这个值，不会触发回写，不能留下一条等不到的回声。
  tracker.noteOutgoing('same')
  tracker.consumeIncoming('other')
  assert.equal(tracker.consumeIncoming('same'), false)
})
