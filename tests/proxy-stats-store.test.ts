import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
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

    // Model the real restart boundary: the first launch persists through its
    // process-exit flush, not through a write on every record().
    firstTracker.flushSync()

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

      await proxyStats.flush()

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

  it('keeps record() off the disk so the stream hot path never blocks the main thread', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let now = 1_000
    const tracker = new ProxyStatsTracker({
      storePath,
      now: () => now,
      sessionStartedAt: 1_000,
      flushIntervalMs: 60_000,
    })

    for (let index = 0; index < 50; index += 1) {
      now += 1
      tracker.record('codex', 'request', '/v1/responses')
    }

    assert.equal(
      existsSync(storePath),
      false,
      'record() must not touch the disk synchronously; it is called once per proxy/stream event',
    )

    // The reader contract is unchanged: callers see the newest in-memory state,
    // not whatever happens to be on disk.
    assert.equal(tracker.getStats().history.requests, 50)

    await tracker.flush()

    const persisted = JSON.parse(await readFile(storePath, 'utf8')) as {
      entries: Array<{ event: string }>
    }
    assert.equal(persisted.entries.length, 50, 'flush() must persist every buffered entry')
  })

  it('coalesces a burst of records into a single write and keeps the last one', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let now = 2_000
    const tracker = new ProxyStatsTracker({
      storePath,
      now: () => now,
      sessionStartedAt: 2_000,
      flushIntervalMs: 5,
    })

    for (let index = 0; index < 200; index += 1) {
      now += 1
      tracker.record('claude', 'request', '/v1/messages')
    }

    await tracker.flush()

    const firstWriteMtime = statSync(storePath).mtimeMs
    assert.equal(
      (JSON.parse(await readFile(storePath, 'utf8')) as { entries: unknown[] }).entries.length,
      200,
    )

    // A flush with nothing new must not rewrite the file at all.
    await tracker.flush()
    assert.equal(statSync(storePath).mtimeMs, firstWriteMtime)
  })

  // 症状 — 关机/换数据目录之后，统计里少掉最后那一段（最多一个节流窗口）的事件。
  // 根因 — 2026-08-12：节流改造把落盘拆成了"异步 flush" + "退出路径 flushSync"两条，
  //   但它们各自持有**自己那一刻的整份快照**、且不共用顺序。异步写还在 libuv 线程池里
  //   飞的时候 flushSync 抢先把更新的快照同步写完，随后那次异步写落地，用**更旧**的
  //   内容把文件覆盖回去。`getSharedTracker()` 重绑 dataDir 时正是这条路径。
  // 为什么不能靠 writeChain 解决 — writeChain 只串行化异步写之间的顺序，flushSync 走的
  //   是完全独立的同步 I/O，根本不在那条链上。必须给每次写一个序号，让过期的那次跳过。
  it('never lets an in-flight async write overwrite a newer synchronous flush', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let now = 6_000
    const tracker = new ProxyStatsTracker({
      storePath,
      now: () => now,
      sessionStartedAt: 6_000,
      flushIntervalMs: 60_000,
    })

    now = 6_100
    tracker.record('codex', 'request', '/v1/responses')

    // 故意不 await：这一次写还在飞。
    const pendingFlush = tracker.flush()

    now = 6_200
    tracker.record('codex', 'disconnect', '/v1/responses')
    tracker.flushSync()

    await pendingFlush

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      entries: Array<{ event: string }>
    }
    assert.deepEqual(
      persisted.entries.map((entry) => entry.event),
      ['request', 'disconnect'],
      'a stale async write must not resurrect the pre-flushSync snapshot',
    )
  })

  it('flushes synchronously for the process-exit path so a normal shutdown never loses stats', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let now = 3_000
    const tracker = new ProxyStatsTracker({
      storePath,
      now: () => now,
      sessionStartedAt: 3_000,
      flushIntervalMs: 60_000,
    })

    now = 3_100
    tracker.record('codex', 'request', '/v1/responses')
    now = 3_200
    tracker.record('codex', 'disconnect', '/v1/responses')

    tracker.flushSync()

    const persisted = JSON.parse(readFileSync(storePath, 'utf8')) as {
      entries: Array<{ event: string }>
    }
    assert.deepEqual(persisted.entries.map((entry) => entry.event), ['request', 'disconnect'])

    // Reloading from that file must reproduce the same history.
    const reloaded = new ProxyStatsTracker({
      storePath,
      now: () => 4_000,
      sessionStartedAt: 4_000,
    })
    assert.deepEqual(reloaded.getStats().history, {
      requests: 1,
      disconnects: 1,
      recoverySuccesses: 0,
      recoveryFailures: 0,
    })
  })

  it('bounds each entry field so the store file cannot grow past its entry cap', async () => {
    const { ProxyStatsTracker } = await import('../server/proxy-stats-store.ts')
    const storePath = path.join(tmpDir, 'proxy-stats.json')

    let now = 5_000
    const tracker = new ProxyStatsTracker({
      storePath,
      now: () => now,
      sessionStartedAt: 5_000,
      flushIntervalMs: 60_000,
    })

    now = 5_100
    tracker.record('codex', 'disconnect', `/v1/responses?${'x'.repeat(20_000)}`, {
      errorType: 'y'.repeat(20_000),
    })

    await tracker.flush()

    const raw = await readFile(storePath, 'utf8')
    assert.ok(
      raw.length < 2_000,
      `endpoint/errorType arrive unbounded over IPC; the persisted entry must be clamped (got ${raw.length} bytes)`,
    )

    const persisted = JSON.parse(raw) as {
      entries: Array<{ endpoint: string; errorType?: string }>
    }
    assert.ok((persisted.entries[0]?.endpoint.length ?? 0) <= 256)
    assert.ok((persisted.entries[0]?.errorType?.length ?? 0) <= 256)
  })
})
