import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRendererWithRetry } from '../electron/renderer-load-retry.ts'

const noWait = async () => {}

test('a first-try success loads once and reports success', async () => {
  let calls = 0
  const result = await loadRendererWithRetry({
    load: async () => {
      calls += 1
    },
    wait: noWait,
  })

  assert.equal(result.loaded, true)
  assert.equal(calls, 1)
  assert.equal(result.attempts, 1)
})

test('a transient failure is retried until it succeeds', async () => {
  let calls = 0
  const failures: number[] = []
  const result = await loadRendererWithRetry({
    load: async () => {
      calls += 1
      if (calls < 3) {
        throw new Error('ERR_FAILED (-2)')
      }
    },
    onAttemptFailed: (attempt) => failures.push(attempt),
    wait: noWait,
  })

  assert.equal(result.loaded, true)
  assert.equal(calls, 3)
  assert.deepEqual(failures, [1, 2])
})

// The packaged path used to be a bare `void win.loadFile(...).then(...)` with no
// catch at all, so a rejected load surfaced as an unhandledRejection in main.log
// (observed 2026-08-11 22:24:13) instead of being retried like the dev path.
test('an always-failing load never rejects and never throws', async () => {
  const result = await loadRendererWithRetry({
    load: async () => {
      throw new Error('ERR_FAILED (-2)')
    },
    maxAttempts: 4,
    wait: noWait,
  })

  assert.equal(result.loaded, false)
  assert.equal(result.attempts, 4)
})

test('a synchronously throwing load is caught too', async () => {
  const result = await loadRendererWithRetry({
    load: () => {
      throw new Error('boom')
    },
    maxAttempts: 2,
    wait: noWait,
  })

  assert.equal(result.loaded, false)
  assert.equal(result.attempts, 2)
})

// Single-instance handoff: the second instance calls app.quit(), which destroys
// the window mid-load. Retrying 40 times against a destroyed window is pure
// noise, so an abandoned window must stop the loop immediately.
test('an abandoned window stops retrying at once', async () => {
  let calls = 0
  let destroyed = false
  const result = await loadRendererWithRetry({
    load: async () => {
      calls += 1
      destroyed = true
      throw new Error('ERR_FAILED (-2)')
    },
    isAbandoned: () => destroyed,
    maxAttempts: 40,
    wait: noWait,
  })

  assert.equal(result.loaded, false)
  assert.equal(result.abandoned, true)
  assert.equal(calls, 1)
})

test('a window abandoned before the first attempt never loads at all', async () => {
  let calls = 0
  const result = await loadRendererWithRetry({
    load: async () => {
      calls += 1
    },
    isAbandoned: () => true,
    wait: noWait,
  })

  assert.equal(calls, 0)
  assert.equal(result.loaded, false)
  assert.equal(result.abandoned, true)
})

test('retry delays are requested between attempts, not before the first', async () => {
  const waited: number[] = []
  await loadRendererWithRetry({
    load: async () => {
      throw new Error('nope')
    },
    maxAttempts: 3,
    delayMs: 500,
    wait: async (ms) => {
      waited.push(ms)
    },
  })

  assert.deepEqual(waited, [500, 500])
})
