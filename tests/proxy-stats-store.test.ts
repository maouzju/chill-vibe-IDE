import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

describe('proxy stats store', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-proxy-stats-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('persists history across restarts while keeping current-session counts scoped to the active launch', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let firstNow = 1_000
    const firstTracker = new ProxyStatsTracker({
      storePath,
      now: () => firstNow,
      sessionStartedAt: 1_000,
    })

    firstNow = 1_100
    firstTracker.record('codex', 'request', '/v1/responses')
    firstNow = 1_200
    firstTracker.record('codex', 'disconnect', '/v1/responses')

    const firstSummary = firstTracker.getStats()
    assert.deepEqual(firstSummary.history, {
      requests: 1,
      disconnects: 1,
      recoverySuccesses: 0,
      recoveryFailures: 0,
    })
    assert.deepEqual(firstSummary.currentSession, firstSummary.history)

    let secondNow = 5_000
    const secondTracker = new ProxyStatsTracker({
      storePath,
      now: () => secondNow,
      sessionStartedAt: 5_000,
    })

    secondNow = 5_100
    secondTracker.record('claude', 'request', '/v1/messages')
    secondNow = 5_200
    secondTracker.record('claude', 'recovery_success', '/v1/messages')

    const secondSummary = secondTracker.getStats()
    assert.deepEqual(secondSummary.history, {
      requests: 2,
      disconnects: 1,
      recoverySuccesses: 1,
      recoveryFailures: 0,
    })
    assert.deepEqual(secondSummary.currentSession, {
      requests: 1,
      disconnects: 0,
      recoverySuccesses: 1,
      recoveryFailures: 0,
    })
    assert.equal(secondSummary.startedAt, 5_000)
  })

  it('applies time filters to history without shrinking current-session totals', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let now = 10_000
    const tracker = new ProxyStatsTracker({
      storePath,
      now: () => now,
      sessionStartedAt: 10_000,
    })

    now = 10_100
    tracker.record('codex', 'request', '/v1/responses')
    now = 10_200
    tracker.record('codex', 'disconnect', '/v1/responses')
    now = 10_300
    tracker.record('codex', 'recovery_fail', '/v1/responses')

    const filtered = tracker.getStats(10_250)
    assert.deepEqual(filtered.history, {
      requests: 0,
      disconnects: 0,
      recoverySuccesses: 0,
      recoveryFailures: 1,
    })
    assert.deepEqual(filtered.currentSession, {
      requests: 1,
      disconnects: 1,
      recoverySuccesses: 0,
      recoveryFailures: 1,
    })
  })

  it('lets the shared proxyStats singleton pick up the final data dir when Electron configures it after import', async () => {
    const storePath = path.join(tmpDir, 'proxy-stats.json')
    const previousDataDir = process.env.CHILL_VIBE_DATA_DIR

    delete process.env.CHILL_VIBE_DATA_DIR

    const moduleHref = `${pathToFileURL(path.resolve('server/proxy-stats-store.ts')).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { proxyStats } = await import(moduleHref)

    process.env.CHILL_VIBE_DATA_DIR = tmpDir

    try {
      proxyStats.record('codex', 'request', '/v1/responses')

      const summary = proxyStats.getStats()
      assert.deepEqual(summary.history, {
        requests: 1,
        disconnects: 0,
        recoverySuccesses: 0,
        recoveryFailures: 0,
      })

      const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(storePath, 'utf8')) as {
        entries: Array<{ event: string }>
      }
      assert.equal(persisted.entries.length, 1)
      assert.equal(persisted.entries[0]?.event, 'request')
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CHILL_VIBE_DATA_DIR
      } else {
        process.env.CHILL_VIBE_DATA_DIR = previousDataDir
      }
    }
  })
})
