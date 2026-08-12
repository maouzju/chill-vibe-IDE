import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { Provider } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'

const PROXY_STATS_STORE_FILE = 'proxy-stats.json'
const proxyStatsEventValues = ['request', 'disconnect', 'recovery_success', 'recovery_fail'] as const
const maxStatsEntries = 1000

// 症状: 主进程主线程被同步工作占住 10~19s，窗口消息泵停摆，Windows 判定无响应后杀掉进程
//       (退出码 0xCFFFFFFF)，用户感知为"闪退"。
// 根因: 2026-08-12 实测 —— 用户 proxy-stats.json 已 168345 字节/1000 条(正好顶到条数上限)，
//       而每个 proxy 请求与每个 stream 事件都会 record() 一次并整文件同步重写；空载单次
//       mkdirSync+stringify(null,2)+writeFileSync 就要 0.737ms(p95 1.03ms，其中 stringify 占 0.33ms)，
//       磁盘/杀软争用时远不止。这些同步 I/O 全部落在主线程。
// 为什么不能换写法: 不能只把 writeFileSync 换成 writeFile —— 那样每个事件仍产生一次写，只是把
//       阻塞换成了 I/O 风暴；必须"内存累积 + 节流合并"才能把 N 次写降成每窗口 1 次。也不能干脆
//       不落盘：统计要跨重启累计。缩进从 2 改为紧凑省下 46545 字节(168345→121800)与那 0.33ms。
const flushIntervalMs = 2_000
// endpoint / errorType 经 IPC 从渲染进程传入且长度无界(providers.ts 只校验类型不校验长度)，
// 条数上限挡不住单条膨胀，这里按字段截断把文件字节数真正钉死。
const maxEntryFieldLength = 256

export type ProxyStatsEvent = (typeof proxyStatsEventValues)[number]

export type ProxyStatsEntry = {
  timestamp: number
  provider: Provider
  event: ProxyStatsEvent
  endpoint: string
  attempt?: number
  errorType?: string
}

export type ProxyStatsCounts = {
  requests: number
  disconnects: number
  recoverySuccesses: number
  recoveryFailures: number
}

export type ProxyStatsSummary = {
  history: ProxyStatsCounts
  currentSession: ProxyStatsCounts
  startedAt: number
  entries: ProxyStatsEntry[]
}

type ProxyStatsStore = {
  entries: ProxyStatsEntry[]
}

type ProxyStatsTrackerOptions = {
  storePath?: string
  now?: () => number
  sessionStartedAt?: number
  flushIntervalMs?: number
}

type ProxyStatsFacade = Pick<ProxyStatsTracker, 'record' | 'getStats' | 'reset' | 'flush' | 'flushSync'>

const createEmptyCounts = (): ProxyStatsCounts => ({
  requests: 0,
  disconnects: 0,
  recoverySuccesses: 0,
  recoveryFailures: 0,
})

const isProvider = (value: unknown): value is Provider =>
  value === 'codex' || value === 'claude'

const isProxyStatsEvent = (value: unknown): value is ProxyStatsEvent =>
  typeof value === 'string' && proxyStatsEventValues.includes(value as ProxyStatsEvent)

const clampField = (value: string) =>
  value.length > maxEntryFieldLength ? value.slice(0, maxEntryFieldLength) : value

const normalizeEntry = (input: unknown): ProxyStatsEntry | null => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const record = input as Record<string, unknown>
  const timestamp = Number(record.timestamp)

  if (!Number.isFinite(timestamp) || timestamp <= 0 || !isProvider(record.provider) || !isProxyStatsEvent(record.event)) {
    return null
  }

  const endpoint = typeof record.endpoint === 'string' ? clampField(record.endpoint) : ''
  if (!endpoint) {
    return null
  }

  const attempt = typeof record.attempt === 'number' && Number.isFinite(record.attempt)
    ? record.attempt
    : undefined
  const errorType = typeof record.errorType === 'string' && record.errorType.trim()
    ? clampField(record.errorType)
    : undefined

  return {
    timestamp,
    provider: record.provider,
    event: record.event,
    endpoint,
    attempt,
    errorType,
  }
}

const normalizeStore = (input: unknown): ProxyStatsStore => {
  if (!input || typeof input !== 'object') {
    return { entries: [] }
  }

  const rawEntries = Array.isArray((input as Record<string, unknown>).entries)
    ? ((input as Record<string, unknown>).entries as unknown[])
    : []

  const entries = rawEntries
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is ProxyStatsEntry => Boolean(entry))
    .slice(-maxStatsEntries)

  return { entries }
}

const summarizeEntries = (entries: ProxyStatsEntry[]): ProxyStatsCounts => {
  const counts = createEmptyCounts()

  for (const entry of entries) {
    switch (entry.event) {
      case 'request':
        counts.requests += 1
        break
      case 'disconnect':
        counts.disconnects += 1
        break
      case 'recovery_success':
        counts.recoverySuccesses += 1
        break
      case 'recovery_fail':
        counts.recoveryFailures += 1
        break
    }
  }

  return counts
}

const readStore = (storePath: string): ProxyStatsStore => {
  try {
    if (!fs.existsSync(storePath)) {
      return { entries: [] }
    }

    return normalizeStore(JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown)
  } catch {
    return { entries: [] }
  }
}

// Entries are already normalized and clamped when they enter `entries`, so the
// serializer only has to trim to the cap — no second full re-normalize pass.
const serializeStore = (entries: ProxyStatsEntry[]) =>
  `${JSON.stringify({ entries: entries.slice(-maxStatsEntries) })}\n`

const writeStoreSync = (storePath: string, payload: string) => {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, payload, 'utf8')
  } catch {
    // Best-effort persistence; stats should never break request handling.
  }
}

const writeStoreAsync = async (storePath: string, payload: string) => {
  try {
    await fsp.mkdir(path.dirname(storePath), { recursive: true })
    await fsp.writeFile(storePath, payload, 'utf8')
  } catch {
    // Best-effort persistence; stats should never break request handling.
  }
}

export class ProxyStatsTracker {
  private readonly storePath: string
  private readonly now: () => number
  private readonly flushIntervalMs: number
  private startedAt: number
  private entries: ProxyStatsEntry[]
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  // 症状: 关机或换数据目录之后统计里少掉最后一个节流窗口的事件。
  // 根因: 2026-08-12 —— 落盘有两条互不相干的路：异步 flush() 走 writeChain，退出路径的
  //       flushSync() 走同步 I/O。writeChain 只排定异步写彼此的顺序，管不到同步写；
  //       于是"异步写还在飞 → flushSync 写下更新的快照 → 那次异步写落地"就用更旧的
  //       整份快照把文件覆盖回去（每次写的都是全量快照，不是增量）。
  // 为什么不能靠 writeChain 解决: 同步写根本不在链上，也没法让同步函数去 await 它。
  //       只能给每次写发一个单调序号，让落地时发现自己已经过期的那次直接跳过。
  private writeSeq = 0
  private lastWrittenSeq = 0

  constructor(options: ProxyStatsTrackerOptions = {}) {
    this.storePath = path.resolve(options.storePath ?? path.join(getAppDataDir(), PROXY_STATS_STORE_FILE))
    this.now = options.now ?? Date.now
    this.flushIntervalMs = options.flushIntervalMs ?? flushIntervalMs
    this.startedAt = options.sessionStartedAt ?? this.now()
    this.entries = readStore(this.storePath).entries
  }

  record(provider: Provider, event: ProxyStatsEvent, endpoint: string, extra?: { attempt?: number; errorType?: string }) {
    if (this.entries.length >= maxStatsEntries) {
      this.entries.splice(0, this.entries.length - maxStatsEntries + 1)
    }

    this.entries.push({
      timestamp: this.now(),
      provider,
      event,
      endpoint: clampField(endpoint),
      ...extra,
      ...(extra?.errorType === undefined ? {} : { errorType: clampField(extra.errorType) }),
    })

    this.markDirty()
  }

  private markDirty() {
    this.dirty = true

    if (this.flushTimer) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.flushIntervalMs)
    // Telemetry must never be the reason a process stays alive; the exit hook
    // below is what guarantees the pending window still reaches disk.
    this.flushTimer.unref?.()
  }

  /** Persist any buffered entries. Safe to call when nothing is pending. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (!this.dirty) {
      return this.writeChain
    }

    this.dirty = false
    const payload = serializeStore(this.entries)
    const seq = ++this.writeSeq
    // Serialize writes against each other so a slow write can never be
    // overtaken by a newer one and leave stale content as the final state.
    // The sequence check covers the other half: a `flushSync()` that lands
    // while this write is still in the threadpool must not be undone by it.
    this.writeChain = this.writeChain.then(async () => {
      if (seq < this.lastWrittenSeq) {
        return
      }

      await writeStoreAsync(this.storePath, payload)
      this.lastWrittenSeq = Math.max(this.lastWrittenSeq, seq)
    })
    return this.writeChain
  }

  /**
   * Synchronous last-resort flush for `process.on('exit')`, where the event loop
   * is already gone and only sync I/O can still run. This is the one place a
   * blocking write is correct: it happens once per shutdown, not per event.
   */
  flushSync() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (!this.dirty) {
      return
    }

    this.dirty = false
    this.lastWrittenSeq = ++this.writeSeq
    writeStoreSync(this.storePath, serializeStore(this.entries))
  }

  getStats(since?: number): ProxyStatsSummary {
    const historyEntries = since
      ? this.entries.filter((entry) => entry.timestamp >= since)
      : [...this.entries]
    const currentSessionEntries = this.entries.filter((entry) => entry.timestamp >= this.startedAt)

    return {
      history: summarizeEntries(historyEntries),
      currentSession: summarizeEntries(currentSessionEntries),
      startedAt: this.startedAt,
      entries: historyEntries,
    }
  }

  reset() {
    this.entries = []
    this.startedAt = this.now()
    // A user-initiated wipe is rare and must not linger in the buffer, but it
    // still goes out asynchronously — the hot path is what we are protecting.
    this.dirty = true
    void this.flush()
  }
}

let sharedTracker: ProxyStatsTracker | null = null
let sharedTrackerStorePath: string | null = null
let exitFlushRegistered = false

const resolveSharedTrackerStorePath = () => path.resolve(path.join(getAppDataDir(), PROXY_STATS_STORE_FILE))

const getSharedTracker = () => {
  const storePath = resolveSharedTrackerStorePath()
  if (!sharedTracker || sharedTrackerStorePath !== storePath) {
    // Rebinding to a new data dir must not strand the previous buffer.
    sharedTracker?.flushSync()
    sharedTracker = new ProxyStatsTracker({ storePath })
    sharedTrackerStorePath = storePath
  }

  if (!exitFlushRegistered) {
    exitFlushRegistered = true
    // 症状（要防的）：进程退出时丢掉最后一个节流窗口里的统计。
    // 边界（别再当成全覆盖）：这条只对**纯 web server host** 成立。后端搬进
    //   utilityProcess 之后，backend-host 收尾走的是 `child.kill()`（Windows 上
    //   即 TerminateProcess），子进程根本跑不到 'exit' 钩子。Electron 下真正的
    //   保证来自 backend.ts `dispose()` 里的 `await proxyStats.flush()`。
    // 为什么还留着：web server host 仍然只有这一条兜底，且一次进程只跑一次。
    //   One listener total, not one per tracker instance.
    process.on('exit', () => {
      sharedTracker?.flushSync()
    })
  }

  return sharedTracker
}

export const proxyStats: ProxyStatsFacade = {
  record(provider, event, endpoint, extra) {
    getSharedTracker().record(provider, event, endpoint, extra)
  },
  getStats(since) {
    return getSharedTracker().getStats(since)
  },
  reset() {
    getSharedTracker().reset()
  },
  flush() {
    return getSharedTracker().flush()
  },
  flushSync() {
    getSharedTracker().flushSync()
  },
}
