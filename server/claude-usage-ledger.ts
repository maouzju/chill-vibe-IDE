import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  estimateClaudeCostUsd,
  resolveClaudeModelFamily,
  resolveClaudePriceKey,
} from '../shared/claude-pricing.js'
import { stripChillVibePromptShell } from '../shared/claude-prompt-shell.js'
import type {
  ClaudeUsageModelFamily,
  ClaudeUsageProject,
  ClaudeUsageRequest,
  ClaudeUsageResponse,
} from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'
import { getClaudeProjectsDirs, getExternalHistoryHomeDirs } from './external-history.js'

/**
 * Claude 用量账本：增量扫描 ~/.claude/projects/**\/*.jsonl，按日 / 会话 / 价格键 / cwd 聚合，
 * 查询时再按项目归属与定价折算。SPEC：docs/specs/claude-usage-ledger/。
 *
 * 症状（要防的）：2026-10-28 实测本机 17,621 个 jsonl 共 21.5 GB、两个月 386,769 条回复。
 *   逐条消息落盘（token-dashboard 的 sqlite 做法）换成 JSON 缓存就是几十 MB、启动即吃掉
 *   主进程上百 MB 堆——pitfall 55 的形状。
 * 根因：去重需要"见过哪些消息"，但费用只需要聚合值。
 * 所以：缓存只存聚合桶（实测 6,076 个）+ 一份按日期分桶、定宽哈希拼接的「已见键」集合，
 *   后者只保留最近 seenRetentionDays 天（体积有上界）。被否决的替代：永久保留全部键。
 */

export const ledgerCacheFileName = 'claude-usage-ledger.json'
/** 口径变了就改这个数：旧缓存整份作废重扫。 */
export const ledgerCacheVersion = 1
export const seenRetentionDays = 120

const READ_CHUNK_BYTES = 1024 * 1024
const CACHE_FLUSH_INTERVAL_MS = 10_000
const OTHER_PROJECTS_IN_COLOR_ORDER = 7

/** [input, output, cacheWrite, cacheWrite1h, cacheRead, replies, lastTsMs] */
type UsageBucket = [number, number, number, number, number, number, number]
/** [prompts, chars] */
type PromptBucket = [number, number]

type PendingRun = {
  key: string
  bucketKey: string
  vals: [number, number, number, number, number]
  model: string
  day: string
  sessionId: string
  cwd: string
  tsMs: number
}

type FileEntry = { size: number; offset: number; pending?: PendingRun }

type LedgerCache = {
  version: number
  lastScanAt: string | null
  files: Record<string, FileEntry>
  buckets: Record<string, UsageBucket>
  prompts: Record<string, PromptBucket>
  /** day → 定宽 11 位 base36 哈希拼接 */
  seen: Record<string, string>
  urgeMessages: string[]
}

const HASH_WIDTH = 11

const createEmptyCache = (): LedgerCache => ({
  version: ledgerCacheVersion,
  lastScanAt: null,
  files: {},
  buckets: {},
  prompts: {},
  seen: {},
  urgeMessages: [],
})

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value))

/** 本地日期：用户看的是自己的作息，UTC 会把晚上八点以后的活推到第二天（与 stats-card 同口径）。 */
const toLocalDayKey = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

const parseTimestamp = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** FNV-1a 52 bit → 11 位 base36。键集合只用于去重，碰撞概率在百万键量级上可忽略。 */
const hashKey = (key: string) => {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < key.length; index += 1) {
    hash ^= BigInt(key.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xfffffffffffffn
  }
  return hash.toString(36).padStart(HASH_WIDTH, '0').slice(-HASH_WIDTH)
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
      .map((block) => block.text ?? '')
      .join(' ')
  }
  return ''
}

const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const normalizePathForCompare = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

const normalizePathDisplay = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '')

export type ClaudeProjectAttribution = { id: string; path: string | null }

/**
 * cwd → 项目（docs/specs/claude-usage-ledger FR-4）。纯函数，查询时调用；归属不烙进缓存，
 * 工作区列表一变立刻生效。
 */
export const attributeClaudeProject = (
  cwd: string,
  { workspaces, home, tmp }: { workspaces: readonly string[]; home: string | readonly string[]; tmp: string },
): ClaudeProjectAttribution => {
  if (!cwd) return { id: '(unknown)', path: null }
  const display = normalizePathDisplay(cwd)
  const lower = normalizePathForCompare(cwd)

  for (const workspace of workspaces) {
    const workspaceLower = normalizePathForCompare(workspace)
    if (!workspaceLower) continue
    if (lower === workspaceLower || lower.startsWith(`${workspaceLower}\\`)) {
      const name = workspaceLower.split('\\').filter(Boolean).pop() ?? workspace
      // 名字取用户自己路径里的大小写
      const original = normalizePathDisplay(workspace).split('\\').filter(Boolean).pop() ?? name
      return { id: original, path: workspace }
    }
  }

  const tmpLower = normalizePathForCompare(tmp)
  if (lower.includes('\\appdata\\local\\temp\\') || lower.endsWith('\\appdata\\local\\temp')
    || (tmpLower && (lower === tmpLower || lower.startsWith(`${tmpLower}\\`)))) {
    return { id: '(temp)', path: null }
  }

  const gitMatch = /^([a-z]:\\git)\\([^\\]+)/.exec(lower)
  if (gitMatch) {
    const name = display.split('\\')[2] ?? gitMatch[2]!
    return { id: name, path: display.split('\\').slice(0, 3).join('\\') }
  }
  if (/^[a-z]:\\git$/.test(lower)) {
    return { id: '(git-root)', path: null }
  }

  for (const homeDir of Array.isArray(home) ? home : [home as string]) {
    const homeLower = normalizePathForCompare(homeDir)
    if (!homeLower) continue
    if (lower === `${homeLower}\\.claude` || lower.startsWith(`${homeLower}\\.claude\\`)) {
      return { id: '(claude-config)', path: null }
    }
    if (lower === homeLower) {
      return { id: '(home)', path: null }
    }
  }

  const leaf = display.split('\\').filter(Boolean).pop()
  return { id: leaf || display, path: display }
}

type LedgerOptions = {
  dataDir?: string
  /** 测试注入；默认 ~/.claude/projects 候选目录（pitfall 32）。 */
  projectsDirs?: () => string[]
  homeDirs?: () => string[]
  tmpDir?: string
  now?: () => Date
}

export type ClaudeUsageScanState = ClaudeUsageResponse['scan']

const listJsonlFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(full)
      }
    }
  }
  await walk(root)
  return files
}

export const createClaudeUsageLedger = (options: LedgerOptions = {}) => {
  const dataDir = options.dataDir ?? getAppDataDir()
  const projectsDirs = options.projectsDirs ?? getClaudeProjectsDirs
  const homeDirs = options.homeDirs ?? getExternalHistoryHomeDirs
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const now = options.now ?? (() => new Date())
  const cachePath = path.join(dataDir, ledgerCacheFileName)

  let cache: LedgerCache | null = null
  let loadPromise: Promise<LedgerCache> | null = null
  let dirty = false
  let writeChain: Promise<void> = Promise.resolve()
  let scanPromise: Promise<void> | null = null
  const scan: ClaudeUsageScanState = { scanning: false, done: 0, total: 0, lastScanAt: null, error: null }

  const loadCache = async (): Promise<LedgerCache> => {
    if (cache) return cache
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const raw = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<LedgerCache>
          if (raw && raw.version === ledgerCacheVersion && raw.files && raw.buckets && raw.prompts && raw.seen) {
            cache = {
              version: ledgerCacheVersion,
              lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : null,
              files: raw.files,
              buckets: raw.buckets,
              prompts: raw.prompts,
              seen: raw.seen,
              urgeMessages: Array.isArray(raw.urgeMessages) ? raw.urgeMessages.filter((v): v is string => typeof v === 'string') : [],
            }
            scan.lastScanAt = cache.lastScanAt
          }
        } catch {
          // 没有缓存或读不出来：从头扫
        }
        cache ??= createEmptyCache()
        return cache
      })()
    }
    return loadPromise
  }

  /** tmp + rename、串行化；不借 state-store 的 atomicWriteFile（它的 WAL 与 state.json 共用，pitfall 15/58）。 */
  const flush = () => {
    if (!cache || !dirty) return writeChain
    const snapshot = JSON.stringify(cache)
    dirty = false
    writeChain = writeChain
      .then(async () => {
        await mkdir(dataDir, { recursive: true })
        const tmpPath = `${cachePath}.${process.pid}.tmp`
        await writeFile(tmpPath, snapshot, 'utf8')
        await rename(tmpPath, cachePath)
      })
      .catch((error) => {
        console.warn('[claude-usage-ledger] cache write failed', error)
      })
    return writeChain
  }

  const seenHas = (store: LedgerCache, day: string, hash: string) => {
    const bucket = store.seen[day]
    if (!bucket) return false
    for (let index = 0; index < bucket.length; index += HASH_WIDTH) {
      if (bucket.startsWith(hash, index)) return true
    }
    return false
  }

  const seenAdd = (store: LedgerCache, day: string, hash: string) => {
    store.seen[day] = (store.seen[day] ?? '') + hash
  }

  const pruneSeen = (store: LedgerCache) => {
    const cutoff = new Date(now())
    cutoff.setDate(cutoff.getDate() - seenRetentionDays)
    const cutoffKey = toLocalDayKey(cutoff)
    for (const day of Object.keys(store.seen)) {
      if (day < cutoffKey) delete store.seen[day]
    }
  }

  const applyBucket = (store: LedgerCache, bucketKey: string, vals: PendingRun['vals'], sign: 1 | -1, tsMs: number) => {
    const bucket = store.buckets[bucketKey] ?? [0, 0, 0, 0, 0, 0, 0]
    for (let index = 0; index < 5; index += 1) {
      bucket[index] = Math.max(0, bucket[index]! + sign * vals[index]!)
    }
    bucket[5] = Math.max(0, bucket[5] + sign)
    if (sign > 0 && tsMs > bucket[6]) bucket[6] = tsMs
    if (bucket[5] === 0 && bucket.slice(0, 5).every((value) => value === 0)) {
      delete store.buckets[bucketKey]
    } else {
      store.buckets[bucketKey] = bucket
    }
  }

  const bucketKeyFor = (run: Pick<PendingRun, 'day' | 'sessionId' | 'model' | 'cwd' | 'vals'>) =>
    `${run.day}|${run.sessionId}|${resolveClaudePriceKey(run.model, run.vals[0] + run.vals[2] + run.vals[4])}|${run.cwd}`

  /** 处理一行；返回更新后的 pending（流式同键行横跨两次读取时靠它续上）。 */
  const ingestLine = (store: LedgerCache, line: string, pending: PendingRun | undefined): PendingRun | undefined => {
    if (!line.includes('"usage"') && !line.includes('"type":"user"')) return pending
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      return pending
    }
    const message = (row.message ?? {}) as Record<string, unknown>
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    const timestamp = parseTimestamp(row.timestamp)
    if (!timestamp) return pending
    const day = toLocalDayKey(timestamp)

    if (row.type === 'user') {
      if (row.isMeta || row.isSidechain || row.isCompactSummary) return pending
      const text = stripChillVibePromptShell(textOf(message.content), { urgeMessages: store.urgeMessages })
      if (!text) return pending
      const key = typeof row.uuid === 'string' && row.uuid ? `u:${row.uuid}` : `u:${String(row.sessionId)}|${String(row.timestamp)}`
      const hash = hashKey(key)
      if (seenHas(store, day, hash)) return pending
      seenAdd(store, day, hash)
      const promptKey = `${day}|${cwd}`
      const bucket = store.prompts[promptKey] ?? [0, 0]
      bucket[0] += 1
      bucket[1] += text.length
      store.prompts[promptKey] = bucket
      return pending
    }

    if (row.type !== 'assistant') return pending
    const usage = message.usage as Record<string, unknown> | undefined
    const messageId = message.id
    if (!usage || typeof messageId !== 'string' || !messageId) return pending
    const model = typeof message.model === 'string' ? message.model : ''
    if (!resolveClaudeModelFamily(model)) return pending

    const cacheCreation = (usage.cache_creation ?? {}) as Record<string, unknown>
    const vals: PendingRun['vals'] = [
      numberOf(usage.input_tokens),
      numberOf(usage.output_tokens),
      numberOf(usage.cache_creation_input_tokens),
      numberOf(cacheCreation.ephemeral_1h_input_tokens),
      numberOf(usage.cache_read_input_tokens),
    ]
    const key = `${messageId}|${String(row.requestId ?? '')}`

    if (pending && pending.key === key) {
      // 同一条回复的下一块：各字段取最大，桶里补差值；priceKey 变了就换桶
      const merged: PendingRun['vals'] = [0, 0, 0, 0, 0]
      let changed = false
      for (let index = 0; index < 5; index += 1) {
        merged[index] = Math.max(pending.vals[index]!, vals[index]!)
        if (merged[index] !== pending.vals[index]) changed = true
      }
      if (!changed) return pending
      const next: PendingRun = { ...pending, vals: merged }
      const nextBucketKey = bucketKeyFor(next)
      applyBucket(store, pending.bucketKey, pending.vals, -1, pending.tsMs)
      applyBucket(store, nextBucketKey, merged, 1, pending.tsMs)
      next.bucketKey = nextBucketKey
      return next
    }

    const hash = hashKey(key)
    if (seenHas(store, day, hash)) {
      // fork / 续跑 / 子 agent 文件抄来的旧回复：整条忽略，但它结束了上一段 pending
      return undefined
    }
    seenAdd(store, day, hash)
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
    const run: PendingRun = {
      key,
      bucketKey: '',
      vals,
      model,
      day,
      sessionId,
      cwd,
      tsMs: timestamp.getTime(),
    }
    run.bucketKey = bucketKeyFor(run)
    applyBucket(store, run.bucketKey, vals, 1, run.tsMs)
    return run
  }

  /**
   * 只读 [offset, size) 里完整的行（pitfall 240：不整读）。块尾的半行拼到下一块；
   * 文件末尾没有换行的尾巴留给下次。
   */
  const ingestFile = async (store: LedgerCache, filePath: string, size: number) => {
    const entry = store.files[filePath]
    let offset = entry && entry.size <= size ? entry.offset : 0
    let pending = offset > 0 ? entry?.pending : undefined
    if (offset > size) offset = 0

    const handle = await open(filePath, 'r')
    let consumed = offset
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      let carry = ''
      let position = offset
      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, size - position), position)
        if (bytesRead <= 0) break
        position += bytesRead
        const chunk = carry + buffer.toString('utf8', 0, bytesRead)
        const lastNewline = chunk.lastIndexOf('\n')
        if (lastNewline < 0) {
          carry = chunk
          continue
        }
        const complete = chunk.slice(0, lastNewline)
        carry = chunk.slice(lastNewline + 1)
        for (const line of complete.split('\n')) {
          const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
          if (trimmed) pending = ingestLine(store, trimmed, pending)
        }
        consumed = position - Buffer.byteLength(carry, 'utf8')
      }
    } finally {
      await handle.close()
    }

    store.files[filePath] = pending ? { size, offset: consumed, pending } : { size, offset: consumed }
    dirty = true
  }

  const runScan = async () => {
    const store = await loadCache()
    scan.scanning = true
    scan.error = null
    scan.done = 0
    scan.total = 0
    let lastFlushAt = Date.now()
    try {
      const todo: Array<{ filePath: string; size: number }> = []
      for (const root of projectsDirs()) {
        for (const filePath of await listJsonlFiles(root)) {
          let fileStat
          try {
            fileStat = await stat(filePath)
          } catch {
            continue
          }
          const known = store.files[filePath]
          if (!known || known.size !== fileStat.size) {
            todo.push({ filePath, size: fileStat.size })
          }
        }
      }
      scan.total = todo.length
      for (const item of todo) {
        try {
          await ingestFile(store, item.filePath, item.size)
        } catch (error) {
          console.warn('[claude-usage-ledger] skip unreadable file', item.filePath, error)
        }
        scan.done += 1
        if (Date.now() - lastFlushAt > CACHE_FLUSH_INTERVAL_MS) {
          lastFlushAt = Date.now()
          void flush()
        }
        // 让出事件循环：扫描跑在后台，不能把主进程占死
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      pruneSeen(store)
      store.lastScanAt = now().toISOString()
      scan.lastScanAt = store.lastScanAt
      dirty = true
    } catch (error) {
      scan.error = error instanceof Error ? error.message : String(error)
    } finally {
      scan.scanning = false
      await flush()
    }
  }

  const ensureScan = ({ force }: { force: boolean }) => {
    if (scanPromise) return scanPromise
    if (!force && scan.lastScanAt) return null
    scanPromise = runScan().finally(() => {
      scanPromise = null
    })
    return scanPromise
  }

  const setUrgeMessages = (messages: readonly string[]) => {
    const next = Array.from(new Set(messages.map((value) => value.trim()).filter(Boolean))).sort()
    void loadCache().then((store) => {
      if (JSON.stringify(store.urgeMessages) !== JSON.stringify(next)) {
        store.urgeMessages = next
        dirty = true
      }
    })
  }

  const query = async (request: ClaudeUsageRequest): Promise<ClaudeUsageResponse> => {
    const store = await loadCache()
    const homes = homeDirs()
    const attributionCache = new Map<string, ClaudeProjectAttribution>()
    const attribute = (cwd: string) => {
      let hit = attributionCache.get(cwd)
      if (!hit) {
        hit = attributeClaudeProject(cwd, { workspaces: request.workspaces, home: homes, tmp: tmpDir })
        attributionCache.set(cwd, hit)
      }
      return hit
    }

    type ProjectAccumulator = {
      id: string
      path: string | null
      costUsd: number
      tokens: number
      outputTokens: number
      costByFamily: Partial<Record<ClaudeUsageModelFamily, number>>
      sessions: Set<string>
      prompts: number
      promptChars: number
      lastUsedMs: number
    }
    const projects = new Map<string, ProjectAccumulator>()
    const allTimeCost = new Map<string, number>()
    const daily: ClaudeUsageResponse['daily'] = { cost: {}, tokens: {}, prompts: {}, promptChars: {} }
    const addDaily = (metric: keyof typeof daily, day: string, project: string, value: number) => {
      const dayBucket = (daily[metric][day] ??= {})
      dayBucket[project] = (dayBucket[project] ?? 0) + value
    }
    const sessionsInRange = new Set<string>()
    let spanFrom: string | null = null
    let spanTo: string | null = null

    const getProject = (attribution: ClaudeProjectAttribution) => {
      let project = projects.get(attribution.id)
      if (!project) {
        project = {
          id: attribution.id,
          path: attribution.path,
          costUsd: 0,
          tokens: 0,
          outputTokens: 0,
          costByFamily: {},
          sessions: new Set(),
          prompts: 0,
          promptChars: 0,
          lastUsedMs: 0,
        }
        projects.set(attribution.id, project)
      }
      return project
    }

    for (const [bucketKey, bucket] of Object.entries(store.buckets)) {
      const firstSep = bucketKey.indexOf('|')
      const secondSep = bucketKey.indexOf('|', firstSep + 1)
      const thirdSep = bucketKey.indexOf('|', secondSep + 1)
      if (firstSep < 0 || secondSep < 0 || thirdSep < 0) continue
      const day = bucketKey.slice(0, firstSep)
      const sessionId = bucketKey.slice(firstSep + 1, secondSep)
      const priceKey = bucketKey.slice(secondSep + 1, thirdSep)
      const cwd = bucketKey.slice(thirdSep + 1)
      const cost = estimateClaudeCostUsd(priceKey, {
        input: bucket[0],
        output: bucket[1],
        cacheWrite: bucket[2],
        cacheWrite1h: bucket[3],
        cacheRead: bucket[4],
      })
      const attribution = attribute(cwd)
      allTimeCost.set(attribution.id, (allTimeCost.get(attribution.id) ?? 0) + cost)
      if (spanFrom === null || day < spanFrom) spanFrom = day
      if (spanTo === null || day > spanTo) spanTo = day
      if (day < request.from || day > request.to) continue

      const project = getProject(attribution)
      const tokens = bucket[0] + bucket[1] + bucket[2] + bucket[4]
      project.costUsd += cost
      project.tokens += tokens
      project.outputTokens += bucket[1]
      const family: ClaudeUsageModelFamily = resolveClaudeModelFamily(priceKey) ?? 'opus'
      project.costByFamily[family] = (project.costByFamily[family] ?? 0) + cost
      project.sessions.add(sessionId)
      sessionsInRange.add(sessionId)
      if (bucket[6] > project.lastUsedMs) project.lastUsedMs = bucket[6]
      addDaily('cost', day, attribution.id, cost)
      addDaily('tokens', day, attribution.id, tokens)
    }

    for (const [promptKey, bucket] of Object.entries(store.prompts)) {
      const sep = promptKey.indexOf('|')
      if (sep < 0) continue
      const day = promptKey.slice(0, sep)
      if (day < request.from || day > request.to) continue
      const attribution = attribute(promptKey.slice(sep + 1))
      const project = getProject(attribution)
      project.prompts += bucket[0]
      project.promptChars += bucket[1]
      addDaily('prompts', day, attribution.id, bucket[0])
      addDaily('promptChars', day, attribution.id, bucket[1])
    }

    const totalCostUsd = Array.from(projects.values()).reduce((sum, project) => sum + project.costUsd, 0)
    const rows: ClaudeUsageProject[] = Array.from(projects.values())
      .map((project) => ({
        id: project.id,
        path: project.path,
        costUsd: project.costUsd,
        share: totalCostUsd > 0 ? project.costUsd / totalCostUsd : 0,
        tokens: project.tokens,
        outputTokens: project.outputTokens,
        costByFamily: project.costByFamily,
        sessions: project.sessions.size,
        prompts: project.prompts,
        promptChars: project.promptChars,
        lastUsedAt: project.lastUsedMs > 0 ? new Date(project.lastUsedMs).toISOString() : null,
      }))
      .sort((left, right) => right.costUsd - left.costUsd || left.id.localeCompare(right.id))

    const activeDays = Object.values(daily.cost).filter((bucket) => Object.values(bucket).some((value) => value > 0)).length
    const top = rows[0]
    return {
      from: request.from,
      to: request.to,
      kpi: {
        totalCostUsd,
        activeDays,
        dailyAverageCostUsd: activeDays > 0 ? totalCostUsd / activeDays : 0,
        totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
        outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
        sessions: sessionsInRange.size,
        projects: rows.length,
        topProject: top?.id ?? null,
        topProjectShare: top ? top.share : 0,
      },
      daily,
      projects: rows,
      colorOrder: Array.from(allTimeCost.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, OTHER_PROJECTS_IN_COLOR_ORDER)
        .map(([id]) => id),
      span: spanFrom && spanTo ? { from: spanFrom, to: spanTo } : null,
      scan: { ...scan },
    }
  }

  return {
    /** 请求入口：登记鞭策名单、按需在后台启动扫描，立刻用已有数据作答（FR-6）。 */
    async getUsage(request: ClaudeUsageRequest) {
      await loadCache()
      setUrgeMessages(request.urgeMessages)
      void ensureScan({ force: request.refresh })
      return query(request)
    },
    /** 等一次完整扫描结束（测试与手动刷新用）。 */
    async scan() {
      await loadCache()
      await (ensureScan({ force: true }) ?? Promise.resolve())
    },
    query,
    setUrgeMessages,
    flush,
    getScanState: () => ({ ...scan }),
  }
}

export type ClaudeUsageLedger = ReturnType<typeof createClaudeUsageLedger>

let sharedLedger: ClaudeUsageLedger | null = null

/**
 * 懒建：数据目录在 Electron 配好 CHILL_VIBE_DATA_DIR 之后才算数（pitfall 77 / 79），
 * import 时就 new 会落到错误目录。
 */
export const getClaudeUsageLedger = () => {
  sharedLedger ??= createClaudeUsageLedger()
  return sharedLedger
}

export const getClaudeUsage = (request: ClaudeUsageRequest) => getClaudeUsageLedger().getUsage(request)
