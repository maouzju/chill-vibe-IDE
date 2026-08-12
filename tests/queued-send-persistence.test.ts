import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { appStateSchema } from '../shared/schema'
import { createDefaultState } from '../shared/default-state'
import { shouldQueueWakeTimerSend } from '../src/components/wake-timer'

// Real crash, 2026-07-26 21:10:56 onwards. A wake-timer queue entry with an
// empty prompt and no attachments reached state.json. Every subsequent save
// re-validated it, threw a ZodError out of the synchronous
// `ipcMain.on('desktop:queue-state-save')` listener, and took the whole main
// process down — the app vanished with no shutdown log at all. It then repeated
// every ~20s because the bad entry stayed on disk.
//
// Three independent defects lined up, so all three are pinned here:
//   1. an empty send was allowed into the queue,
//   2. one invalid entry made the entire app state unparseable,
//   3. a validation error in a fire-and-forget IPC listener killed the process.

const stateWithQueuedSend = (queued: unknown[]) => {
  const state = createDefaultState()
  const column = state.columns[0]
  const cardId = Object.keys(column.cards)[0]
  return {
    ...state,
    columns: [
      {
        ...column,
        cards: {
          ...column.cards,
          [cardId]: { ...column.cards[cardId], wakeTimerQueuedSends: queued },
        },
      },
      ...state.columns.slice(1),
    ],
  }
}

const queuedSendsOf = (parsed: ReturnType<typeof appStateSchema.parse>) => {
  const column = parsed.columns[0]
  const cardId = Object.keys(column.cards)[0]
  return column.cards[cardId].wakeTimerQueuedSends ?? []
}

test('only an explicit empty continuation enters the wake-timer queue', () => {
  const base = { featureEnabled: true, cardActive: true, origin: 'user' as const }
  // A plain empty entry is still invalid. An empty continuation is a real user
  // action ("continue from here") and must wait when the card timer is active.
  assert.equal(shouldQueueWakeTimerSend({ ...base, hasContent: false }), false)
  assert.equal(
    shouldQueueWakeTimerSend({ ...base, hasContent: false, isContinuation: true }),
    true,
  )
  assert.equal(shouldQueueWakeTimerSend({ ...base, hasContent: true }), true)
  // Whitespace is not content.
  assert.equal(shouldQueueWakeTimerSend({ ...base, hasContent: false }), false)
})

test('an explicit empty continuation is valid and survives persistence', () => {
  const parsed = appStateSchema.parse(
    stateWithQueuedSend([
      { id: 'continue-later', prompt: '', attachments: [], isContinuation: true },
    ]),
  )

  assert.deepEqual(queuedSendsOf(parsed), [
    { id: 'continue-later', prompt: '', attachments: [], isContinuation: true },
  ])
})

test('an already-persisted invalid queue entry is dropped, not fatal', () => {
  // This is the exact shape found in the user's state.json.
  const parsed = appStateSchema.parse(
    stateWithQueuedSend([
      { id: 'broken', prompt: '   ', attachments: [] },
      { id: 'good', prompt: 'real message', attachments: [] },
    ]),
  )
  const queued = queuedSendsOf(parsed)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].id, 'good')
})

test('a queue of only invalid entries parses to an empty queue', () => {
  const parsed = appStateSchema.parse(
    stateWithQueuedSend([{ id: 'broken', prompt: '', attachments: [] }]),
  )
  assert.deepEqual(queuedSendsOf(parsed), [])
})

test('valid queue entries are still preserved untouched', () => {
  const parsed = appStateSchema.parse(
    stateWithQueuedSend([{ id: 'keep', prompt: 'hello', attachments: [] }]),
  )
  const queued = queuedSendsOf(parsed)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].prompt, 'hello')
})

test('the fire-and-forget state-save IPC listener cannot kill the main process', () => {
  const main = readFileSync(path.join(process.cwd(), 'electron/main.ts'), 'utf8')
  const listener = main.slice(main.indexOf("ipcMain.on('desktop:queue-state-save'"))
  const body = listener.slice(0, listener.indexOf('\n  })') + 5)
  // 这条守卫原本查的是一圈同步 `try/catch`。后端搬进 utilityProcess 之后
  // `queueStateSave` 从**同步抛**变成 **rejected Promise**，那圈 try/catch 一行都
  // 命中不到 —— 守卫会继续变绿，而 2026-07-26 的崩溃形态原样复发。所以断言必须跟着
  // 实现走：现在唯一正确的形状是 `runBackendSideEffect`，它把同步抛和 rejected
  // Promise 收进同一个出口（行为级覆盖在 tests/backend-call-guards.test.ts，
  // 本条只钉"调用点确实走了那个出口"）。
  assert.match(
    body,
    /runBackendSideEffect\(/,
    'ipcMain.on has no reply channel, so an escaping throw OR an unhandled rejection here terminates the app',
  )
  assert.doesNotMatch(
    body,
    /try\s*\{/,
    'a bare synchronous try/catch is dead code against a cross-process rejection — it must not come back',
  )
})
