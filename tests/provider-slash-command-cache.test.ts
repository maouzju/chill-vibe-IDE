import assert from 'node:assert/strict'
import test from 'node:test'

import { createAsyncTtlCache } from '../server/provider-slash-command-cache.ts'

test('async TTL cache reuses completed and in-flight slash discovery without evicting other workspaces', async () => {
  let now = 1_000
  const loads: string[] = []
  const cache = createAsyncTtlCache<string>({
    ttlMs: 60_000,
    now: () => now,
  })
  const load = (key: string) => async () => {
    loads.push(key)
    return `${key}-${loads.length}`
  }

  const firstPromise = cache.get('one', load('one'))
  const sameInFlightPromise = cache.get('one', load('one'))
  assert.equal(firstPromise, sameInFlightPromise)
  assert.equal(await firstPromise, 'one-1')

  assert.equal(await cache.get('two', load('two')), 'two-2')
  assert.equal(await cache.get('one', load('one')), 'one-1')
  assert.deepEqual(loads, ['one', 'two'])

  now += 60_001
  assert.equal(await cache.get('one', load('one')), 'one-3')
  assert.deepEqual(loads, ['one', 'two', 'one'])
})

test('async TTL cache drops rejected slash discovery so the next request can retry', async () => {
  const cache = createAsyncTtlCache<string>({ ttlMs: 60_000 })
  let attempts = 0

  await assert.rejects(cache.get('claude', async () => {
    attempts += 1
    throw new Error('temporary failure')
  }))

  assert.equal(await cache.get('claude', async () => {
    attempts += 1
    return 'ready'
  }), 'ready')
  assert.equal(attempts, 2)
})
