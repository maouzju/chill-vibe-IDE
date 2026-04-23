import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

describe('provider proxy stats bridge', () => {
  let tmpDir: string
  let previousDataDir: string | undefined

  beforeEach(async () => {
    previousDataDir = process.env.CHILL_VIBE_DATA_DIR
    tmpDir = path.join(os.tmpdir(), `chill-vibe-provider-proxy-stats-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    if (previousDataDir === undefined) {
      delete process.env.CHILL_VIBE_DATA_DIR
    } else {
      process.env.CHILL_VIBE_DATA_DIR = previousDataDir
    }

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('records local provider recovery events into the shared proxy stats store', async () => {
    const providersModuleHref = `${pathToFileURL(path.resolve('server/providers.ts')).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    const providersModule = await import(providersModuleHref)
    const { proxyStats } = await import('../server/proxy-stats-store.ts')

    proxyStats.reset()

    assert.equal(typeof providersModule.recordProviderProxyStatsEvent, 'function')

    providersModule.recordProviderProxyStatsEvent({
      provider: 'codex',
      event: 'request',
      endpoint: '/cli/local-stream',
    })
    providersModule.recordProviderProxyStatsEvent({
      provider: 'codex',
      event: 'disconnect',
      endpoint: '/cli/local-stream',
      attempt: 1,
      errorType: 'local-provider-recoverable',
    })
    providersModule.recordProviderProxyStatsEvent({
      provider: 'codex',
      event: 'recovery_fail',
      endpoint: '/cli/local-stream',
      errorType: 'local-provider-final',
    })

    const summary = proxyStats.getStats()
    assert.deepEqual(summary.history, {
      requests: 1,
      disconnects: 1,
      recoverySuccesses: 0,
      recoveryFailures: 1,
    })
    assert.deepEqual(summary.currentSession, summary.history)
    assert.deepEqual(
      summary.entries.map((entry) => entry.event),
      ['request', 'disconnect', 'recovery_fail'],
    )
    assert.equal(summary.entries[1]?.attempt, 1)
    assert.equal(summary.entries[1]?.errorType, 'local-provider-recoverable')
    assert.equal(summary.entries[2]?.errorType, 'local-provider-final')
  })

  it('rejects invalid proxy stats payloads', async () => {
    const providersModuleHref = `${pathToFileURL(path.resolve('server/providers.ts')).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    const providersModule = await import(providersModuleHref)

    assert.equal(typeof providersModule.recordProviderProxyStatsEvent, 'function')
    assert.throws(
      () => providersModule.recordProviderProxyStatsEvent({
        provider: 'codex',
        event: 'bogus',
        endpoint: '/cli/local-stream',
      }),
      /Invalid proxy stats event\./,
    )
  })
})
