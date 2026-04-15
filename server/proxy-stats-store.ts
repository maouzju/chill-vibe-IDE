import fs from 'node:fs'
import path from 'node:path'

import type { Provider } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'

const PROXY_STATS_STORE_FILE = 'proxy-stats.json'
const proxyStatsEventValues = ['request', 'disconnect', 'recovery_success', 'recovery_fail'] as const
const maxStatsEntries = 1000

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
}

type ProxyStatsFacade = Pick<ProxyStatsTracker, 'record' | 'getStats' | 'reset'>

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

const normalizeEntry = (input: unknown): ProxyStatsEntry | null => {
  if (!input || typeof input !== 'object') {
    return null
  }

  const record = input as Record<string, unknown>
  const timestamp = Number(record.timestamp)

  if (!Number.isFinite(timestamp) || timestamp <= 0 || !isProvider(record.provider) || !isProxyStatsEvent(record.event)) {
    return null
  }

  const endpoint = typeof record.endpoint === 'string' ? record.endpoint : ''
  if (!endpoint) {
    return null
  }

  const attempt = typeof record.attempt === 'number' && Number.isFinite(record.attempt)
    ? record.attempt
    : undefined
  const errorType = typeof record.errorType === 'string' && record.errorType.trim()
    ? record.errorType
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

const writeStore = (storePath: string, entries: ProxyStatsEntry[]) => {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    const normalized = normalizeStore({ entries })
    fs.writeFileSync(storePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  } catch {
    // Best-effort persistence; stats should never break request handling.
  }
}

export class ProxyStatsTracker {
  private readonly storePath: string
  private readonly now: () => number
  private startedAt: number
  private entries: ProxyStatsEntry[]

  constructor(options: ProxyStatsTrackerOptions = {}) {
    this.storePath = path.resolve(options.storePath ?? path.join(getAppDataDir(), PROXY_STATS_STORE_FILE))
    this.now = options.now ?? Date.now
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
      endpoint,
      ...extra,
    })

    writeStore(this.storePath, this.entries)
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
    writeStore(this.storePath, this.entries)
  }
}

let sharedTracker: ProxyStatsTracker | null = null
let sharedTrackerStorePath: string | null = null

const resolveSharedTrackerStorePath = () => path.resolve(path.join(getAppDataDir(), PROXY_STATS_STORE_FILE))

const getSharedTracker = () => {
  const storePath = resolveSharedTrackerStorePath()
  if (!sharedTracker || sharedTrackerStorePath !== storePath) {
    sharedTracker = new ProxyStatsTracker({ storePath })
    sharedTrackerStorePath = storePath
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
}
