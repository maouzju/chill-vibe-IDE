import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import {
  chatMessageSchema,
  contextTransferSchema,
  sessionHistoryEntrySchema,
  type Provider,
  type SessionHistoryEntry,
} from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'
import {
  readDataMaintenanceLedger,
  runDataMaintenanceSlice,
  type DataMaintenancePhase,
  type DataMaintenanceTask,
} from './data-maintenance.js'

const historyDirectoryName = 'session-history'
const catalogFileName = 'catalog.json'
const catalogSegmentPrefix = 'catalog-segment-'
const hiddenFileName = 'catalog-hidden.json'
const catalogTaskId = 'session-history-catalog'
const catalogTaskVersion = 3
const maxResults = 100
const maxCatalogEntries = 20_000
const maxSkippedRecheckPerSlice = 64

const defaultLimits = {
  maxFilesPerSlice: 64,
  maxFileBytes: 4 * 1024 * 1024,
  maxBytesPerSlice: 8 * 1024 * 1024,
  maxElapsedMs: 35,
}

export type SessionHistoryCatalogMaintenanceStatus = {
  phase: 'idle' | DataMaintenancePhase
  processed: number
  skipped: number
  total?: number
  lastSliceProcessed: number
  lastError?: string
}

type CatalogLimits = Partial<typeof defaultLimits>
type CatalogFileOps = {
  rename?: typeof rename
}

type HiddenCatalog = { entryIds: string[]; sessionKeys: string[] }

const catalogSummarySchema = z.object({
  sourceFileName: z.string().min(1),
  entry: sessionHistoryEntrySchema,
})

// 症状：一个既超限又被频繁重写的 sidecar 让 catalog 切片在每一次 /api/session-history 前都空转重跑
//   （2 次 readdir + 最多 128 次 stat + 2 次原子 JSON 重写），phase 永远出不了 degraded。
// 根因：把可变的 size/mtime 当「已修好」信号，使「文件被重写」与「文件真被修好」不可区分；而
//   server/state-store.ts 每次保存都无条件重写已存在的 sidecar，legacy archive 又可达几十 MB
//   （2026-08-02 复现：4 MiB 上限外的 sidecar 每 tick 都重新进 pendingNames 再被 skip）。
// 为什么不改成「同一 stamp 只重试 N 次」：那还是拿字节指纹当信号，只是把死循环换成慢泄漏；
//   按跳过原因分流才能让「体积」这种单调条件用体积本身判定，同时保住 parse-error 的重试语义。
const catalogSkipReasonSchema = z.enum(['oversize', 'unreadable', 'parse-error', 'capacity'])

const catalogSkipStampSchema = z.object({
  name: z.string().min(1),
  size: z.number(),
  mtimeMs: z.number(),
  // 沿用 skippedFileStamps 自己的向后兼容思路：新增可缺省字段而不是换形状。旧 catalog.json（无
  // reason、甚至无 skippedFileStamps）照常解析，不触发整表重建；缺省成 parse-error 保留旧的
  // 「戳变了就重试一次」语义，超限文件最多多跑一轮就会带上 oversize 落定。
  reason: catalogSkipReasonSchema.default('parse-error'),
})

// 症状：一个 sidecar 首次索引失败后即使内容被修好也永不重试，phase 永远卡 degraded。
// 根因：全量指纹只含文件名集合，坏文件又被写进 knownFileNames 排除出待办队列（2026-08-02 实测：修好文件后 shouldRun 恒 false）。
// 为什么不把 size/mtime 塞进 sourceFingerprint：那条路径每次 GET /api/session-history 都跑，会给全部 N 个 sidecar 新增 N 次 stat；
// 改为只给「已跳过」这份小集合存字节指纹（stat 在切片里本来就做了，零额外 syscall），下一轮只重新 stat 它。
const catalogManifestSchema = z.object({
  version: z.literal(3),
  sourceFingerprint: z.string(),
  knownFileNames: z.array(z.string().min(1)),
  skippedFileNames: z.array(z.string().min(1)).default([]),
  // 新增字段而不是把 skippedFileNames 改成对象数组：旧版 catalog.json 照常解析（不触发整表重建），
  // 且旧版代码读到新 manifest 时 zod 只会剥掉这个未知键，降级安装同样不会重建。
  skippedFileStamps: z.array(catalogSkipStampSchema).default([]),
  segments: z.array(z.string().min(1)),
})

const catalogSegmentSchema = z.object({
  version: z.literal(1),
  entries: z.array(catalogSummarySchema),
})

type SessionHistoryCatalogManifest = z.infer<typeof catalogManifestSchema>
type SessionHistoryCatalogSegment = z.infer<typeof catalogSegmentSchema>
type CatalogSkipStamp = z.infer<typeof catalogSkipStampSchema>
type CatalogSkipReason = z.infer<typeof catalogSkipReasonSchema>
type ResolvedCatalogLimits = typeof defaultLimits

const emptyCatalogManifest = (): SessionHistoryCatalogManifest => ({
  version: 3,
  sourceFingerprint: '',
  knownFileNames: [],
  skippedFileNames: [],
  skippedFileStamps: [],
  segments: [],
})

type CatalogCacheEntry = {
  segments: string[]
  entriesById: Map<string, z.infer<typeof catalogSummarySchema>>
}

const catalogCache = new Map<string, CatalogCacheEntry>()

const normalizePath = (value: string) => path.resolve(value).toLocaleLowerCase()
const sessionKey = (provider: Provider, sessionId: string | undefined) =>
  sessionId?.trim() ? `${provider}:${sessionId.trim()}` : ''

const getHistoryDirectory = (dataDir = getAppDataDir()) => path.join(dataDir, historyDirectoryName)
const getCatalogPath = (dataDir = getAppDataDir()) => path.join(getHistoryDirectory(dataDir), catalogFileName)
const getCatalogSegmentDirectory = (dataDir = getAppDataDir()) =>
  path.join(dataDir, 'maintenance', 'session-history-catalog')

const listSidecarNames = async (dataDir: string) => {
  try {
    return (await readdir(getHistoryDirectory(dataDir)))
      .filter((name) =>
        name.endsWith('.json') &&
        ![catalogFileName, hiddenFileName].includes(name) &&
        !name.startsWith(catalogSegmentPrefix),
      )
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

const fingerprintNames = (names: string[]) => createHash('sha256').update(names.join('\0')).digest('hex')

// A sidecar that cannot be stat'ed still needs a stable stamp, otherwise it would look "changed"
// on every slice and turn each history request into a manifest rewrite.
const unreadableSkipStamp = { size: -1, mtimeMs: -1 }

const readSkipStamp = async (directory: string, name: string) => {
  try {
    const stats = await stat(path.join(directory, name))
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return unreadableSkipStamp
  }
}

// 每个 skip 原因用它自己的「消失条件」判定，而不是统一看字节指纹是否变化。
const isSkipRepaired = (
  previous: CatalogSkipStamp | undefined,
  current: { size: number; mtimeMs: number },
  limits: ResolvedCatalogLimits,
) => {
  // A legacy manifest has no stamps at all, so the first new run retries those names once and
  // records their stamp; a still-broken file then settles back into "unchanged" instead of looping.
  if (!previous) return true
  // 体积超限只由体积决定：重写/继续增长都不算修好，只有真的降到预算以内才重试。stat 失败
  // （size 为 -1）刻意不算修好，否则一个间歇性锁住的文件会在 oversize/unreadable 之间来回抖。
  if (previous.reason === 'oversize') {
    return current.size >= 0 && current.size <= limits.maxFileBytes && current.size <= limits.maxBytesPerSlice
  }
  // 目录已经装满 maxCatalogEntries，重写单个文件不会腾出位置；knownFileNames 只增不减，所以这
  // 条只能靠 catalogTaskVersion 提升后的整表重建来解，不该每 tick 重试。
  if (previous.reason === 'capacity') return false
  return previous.size !== current.size || previous.mtimeMs !== current.mtimeMs
}

// 轮转游标刻意只存在内存里：写进 manifest 就意味着每个维护 tick 都要重写 catalog.json，而这一轮
// 修的就是这种写放大。进程内连续几次 tick 就能扫完整个 skip 集合，重启后从头开始也无损。
const skippedRecheckCursors = new Map<string, string>()

// Only previously skipped sidecars are re-stat'ed, never the full directory. The window is capped so a
// pathological catalog (e.g. everything past `maxCatalogEntries`) cannot turn one list request into
// thousands of syscalls; a skip set larger than the cap is swept in rotating windows across
// consecutive slices instead of rechecking the same fixed prefix forever.
const findRepairedSkippedNames = async (
  dataDir: string,
  manifest: SessionHistoryCatalogManifest,
  currentNames: Set<string>,
  limits: ResolvedCatalogLimits,
) => {
  const candidates = manifest.skippedFileNames
    .filter((name) => currentNames.has(name))
    .sort((left, right) => left.localeCompare(right))
  if (candidates.length === 0) return []

  const stamps = new Map(manifest.skippedFileStamps.map((stamp) => [stamp.name, stamp]))
  const cursorKey = normalizePath(dataDir)
  const cursor = skippedRecheckCursors.get(cursorKey) ?? ''
  const startIndex = Math.max(0, candidates.findIndex((name) => name.localeCompare(cursor) > 0))
  const windowSize = Math.min(candidates.length, maxSkippedRecheckPerSlice)
  const directory = getHistoryDirectory(dataDir)
  const repaired: string[] = []
  let lastChecked = ''

  for (let offset = 0; offset < windowSize; offset += 1) {
    const name = candidates[(startIndex + offset) % candidates.length]
    if (!name) continue
    lastChecked = name
    if (isSkipRepaired(stamps.get(name), await readSkipStamp(directory, name), limits)) {
      repaired.push(name)
    }
  }

  // A window that already covered every candidate restarts from the beginning, so the common
  // small-skip-set case keeps a stable, cursor-independent order.
  skippedRecheckCursors.set(cursorKey, windowSize < candidates.length ? lastChecked : '')
  return repaired
}

const readHiddenCatalog = async (directory: string): Promise<HiddenCatalog> => {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, hiddenFileName), 'utf8')) as Partial<HiddenCatalog>
    return {
      entryIds: Array.isArray(parsed.entryIds) ? parsed.entryIds.filter((value): value is string => typeof value === 'string') : [],
      sessionKeys: Array.isArray(parsed.sessionKeys) ? parsed.sessionKeys.filter((value): value is string => typeof value === 'string') : [],
    }
  } catch {
    return { entryIds: [], sessionKeys: [] }
  }
}

const writeHiddenCatalog = async (directory: string, catalog: HiddenCatalog) => {
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, hiddenFileName)
  const temporary = `${target}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    JSON.parse(await readFile(temporary, 'utf8'))
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const readCatalogManifest = async (dataDir: string): Promise<SessionHistoryCatalogManifest> => {
  try {
    return catalogManifestSchema.parse(JSON.parse(await readFile(getCatalogPath(dataDir), 'utf8')))
  } catch {
    return emptyCatalogManifest()
  }
}

const writeValidatedJson = async <T>(
  target: string,
  value: T,
  schema: { parse: (input: unknown) => T },
  fileOps: CatalogFileOps = {},
) => {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  const renameFile = fileOps.rename ?? rename
  try {
    const validated = schema.parse(value)
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
    schema.parse(JSON.parse(await readFile(temporary, 'utf8')))
    await renameFile(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const writeCatalogManifest = async (
  dataDir: string,
  manifest: SessionHistoryCatalogManifest,
  fileOps: CatalogFileOps = {},
) => writeValidatedJson(getCatalogPath(dataDir), manifest, catalogManifestSchema, fileOps)

const writeCatalogSegment = async (
  dataDir: string,
  fileName: string,
  segment: SessionHistoryCatalogSegment,
  fileOps: CatalogFileOps = {},
) => writeValidatedJson(
  path.join(getCatalogSegmentDirectory(dataDir), fileName),
  segment,
  catalogSegmentSchema,
  fileOps,
)

const readCatalogEntries = async (
  dataDir: string,
  manifest: SessionHistoryCatalogManifest,
) => {
  const key = path.resolve(dataDir).toLocaleLowerCase()
  let cached = catalogCache.get(key)
  const cacheIsPrefix = cached && cached.segments.every((segment, index) => manifest.segments[index] === segment)
  if (!cached || !cacheIsPrefix) {
    cached = { segments: [], entriesById: new Map() }
  }

  for (const segmentName of manifest.segments.slice(cached.segments.length)) {
    try {
      const segment = catalogSegmentSchema.parse(JSON.parse(
        await readFile(path.join(getCatalogSegmentDirectory(dataDir), segmentName), 'utf8'),
      ))
      for (const summary of segment.entries) {
        cached.entriesById.set(summary.entry.id, summary)
      }
      cached.segments.push(segmentName)
    } catch {
      // A missing/damaged derived segment is ignored. Source sidecars stay safe,
      // and a future task version can rebuild the derived catalog.
    }
  }

  catalogCache.set(key, cached)
  return [...cached.entriesById.values()]
}

const parseCatalogSource = (content: string, sourceFileName: string) => {
  const raw = JSON.parse(content) as Record<string, unknown>
  const messages = Array.isArray(raw.messages) ? raw.messages : null
  if (
    typeof raw.id !== 'string' || !raw.id.trim() ||
    typeof raw.title !== 'string' || !raw.title.trim() ||
    !['codex', 'claude'].includes(String(raw.provider)) ||
    typeof raw.workspacePath !== 'string' || !raw.workspacePath.trim() ||
    typeof raw.archivedAt !== 'string' || Number.isNaN(Date.parse(raw.archivedAt)) ||
    !messages
  ) {
    throw new Error('Invalid session history sidecar metadata')
  }

  const lastMessageResult = chatMessageSchema.safeParse(messages.at(-1))
  const lastMessage = lastMessageResult.success ? lastMessageResult.data : undefined
  const lifecycleMessages =
    lastMessage?.meta?.kind === 'run-stopped' && ['manual', 'user-interrupt'].includes(lastMessage.meta.stopReason ?? '')
      ? [{ ...lastMessage, content: '' }]
      : []
  const contextTransferResult = contextTransferSchema.safeParse(raw.contextTransfer)
  const storedMessageCount = typeof raw.messageCount === 'number' && Number.isFinite(raw.messageCount)
    ? Math.max(0, Math.trunc(raw.messageCount))
    : 0

  return catalogSummarySchema.parse({
    sourceFileName,
    entry: {
      id: raw.id,
      title: raw.title,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
      sessionModel: typeof raw.sessionModel === 'string' ? raw.sessionModel : undefined,
      contextTransfer: contextTransferResult.success ? contextTransferResult.data : undefined,
      provider: raw.provider,
      model: typeof raw.model === 'string' ? raw.model : '',
      workspacePath: raw.workspacePath,
      archivedAt: raw.archivedAt,
      messageCount: Math.max(storedMessageCount, messages.length),
      messages: lifecycleMessages,
      messagesPreview: true,
    },
  })
}

const resolveLimits = (limits: CatalogLimits | undefined) => ({
  maxFilesPerSlice: Math.max(1, Math.trunc(limits?.maxFilesPerSlice ?? defaultLimits.maxFilesPerSlice)),
  maxFileBytes: Math.max(1, Math.trunc(limits?.maxFileBytes ?? defaultLimits.maxFileBytes)),
  maxBytesPerSlice: Math.max(1, Math.trunc(limits?.maxBytesPerSlice ?? defaultLimits.maxBytesPerSlice)),
  maxElapsedMs: Math.max(1, Math.trunc(limits?.maxElapsedMs ?? defaultLimits.maxElapsedMs)),
})

const createSessionHistoryCatalogTask = ({
  dataDir,
  limits,
  fileOps,
  onSlice,
}: {
  dataDir: string
  limits?: CatalogLimits
  fileOps?: CatalogFileOps
  onSlice: (processed: number) => void
}): DataMaintenanceTask => {
  const safeLimits = resolveLimits(limits)
  // `shouldRun` 和 `runSlice` 在同一个切片里各读一次 manifest，原来会把同一批文件 stat 两遍
  // （最多 128 次串行 syscall）。memo 挂在这个任务实例的闭包上，实例只服务一次切片，跨 tick 不会
  // 复用，所以不存在缓存过期问题；键不匹配就照常重算。
  let repairedMemo: { key: string; names: string[] } | undefined
  const repairedSkippedNames = async (
    manifest: SessionHistoryCatalogManifest,
    currentNames: Set<string>,
    sourceFingerprint: string,
  ) => {
    const key = [
      sourceFingerprint,
      String(manifest.skippedFileStamps.length),
      ...manifest.skippedFileNames,
    ].join('\0')
    if (repairedMemo?.key === key) return repairedMemo.names
    const names = await findRepairedSkippedNames(dataDir, manifest, currentNames, safeLimits)
    repairedMemo = { key, names }
    return names
  }

  return {
    id: catalogTaskId,
    version: catalogTaskVersion,
    async shouldRun({ previous }) {
      const names = await listSidecarNames(dataDir)
      const manifest = await readCatalogManifest(dataDir)
      const sourceFingerprint = fingerprintNames(names)
      const changed = manifest.sourceFingerprint !== sourceFingerprint
      if (!previous || previous.phase === 'running' || changed) return true
      // Healthy catalogs have no skipped names, so the common path still ends here without extra IO.
      return (await repairedSkippedNames(manifest, new Set(names), sourceFingerprint)).length > 0
    },
    async runSlice({ previous }) {
      const names = await listSidecarNames(dataDir)
      const currentNames = new Set(names)
      const sourceFingerprint = fingerprintNames(names)
      const manifest = await readCatalogManifest(dataDir)
      const knownFileNames = new Set(manifest.knownFileNames)
      const repairedNames = new Set(await repairedSkippedNames(manifest, currentNames, sourceFingerprint))
      const pendingNames = names.filter((name) => !knownFileNames.has(name) || repairedNames.has(name))
      const newPass = previous?.phase !== 'running'
      const summaries: Array<z.infer<typeof catalogSummarySchema>> = []
      const processedNames: string[] = []
      const skippedNames: string[] = []
      const skipStamps = new Map<string, CatalogSkipStamp>()
      const recordSkip = (name: string, stamp: { size: number; mtimeMs: number }, reason: CatalogSkipReason) => {
        skippedNames.push(name)
        skipStamps.set(name, { name, size: stamp.size, mtimeMs: stamp.mtimeMs, reason })
      }
      let processed = 0
      let skipped = 0
      let bytes = 0
      let cursor = previous?.cursor
      let index = 0
      const startedAt = Date.now()

      for (; index < pendingNames.length; index += 1) {
        if (processed >= safeLimits.maxFilesPerSlice || Date.now() - startedAt >= safeLimits.maxElapsedMs) {
          break
        }
        const name = pendingNames[index]
        if (!name) continue
        const filePath = path.join(getHistoryDirectory(dataDir), name)
        let size = 0
        let stamp = unreadableSkipStamp
        try {
          const stats = await stat(filePath)
          size = stats.size
          stamp = { size: stats.size, mtimeMs: stats.mtimeMs }
        } catch {
          processed += 1
          skipped += 1
          cursor = name
          processedNames.push(name)
          recordSkip(name, unreadableSkipStamp, 'unreadable')
          continue
        }

        if (
          size > safeLimits.maxFileBytes ||
          size > safeLimits.maxBytesPerSlice ||
          (processed > 0 && bytes + size > safeLimits.maxBytesPerSlice)
        ) {
          if (processed > 0 && size <= safeLimits.maxFileBytes && size <= safeLimits.maxBytesPerSlice) {
            break
          }
          processed += 1
          skipped += 1
          cursor = name
          processedNames.push(name)
          recordSkip(name, stamp, 'oversize')
          continue
        }

        try {
          const summary = parseCatalogSource(await readFile(filePath, 'utf8'), name)
          if (manifest.knownFileNames.length + processed >= maxCatalogEntries) {
            skipped += 1
            recordSkip(name, stamp, 'capacity')
          } else {
            summaries.push(summary)
          }
        } catch {
          skipped += 1
          recordSkip(name, stamp, 'parse-error')
        }
        bytes += size
        processed += 1
        cursor = name
        processedNames.push(name)
      }

      onSlice(processed)
      const reachedEnd = index >= pendingNames.length
      const skippedThisSlice = new Set(skippedNames)
      // A retried sidecar that finally parses has to leave the skip list, or the catalog would stay
      // degraded forever even though its entry is already back in the index.
      const reindexedNames = new Set(processedNames.filter((name) => !skippedThisSlice.has(name)))
      const persistentSkippedNames = [...new Set([
        ...manifest.skippedFileNames.filter((name) => currentNames.has(name) && !reindexedNames.has(name)),
        ...skippedNames,
      ])]
      const previousSkipStamps = new Map(manifest.skippedFileStamps.map((entry) => [entry.name, entry]))
      const persistentSkippedStamps = persistentSkippedNames.flatMap((name) => {
        const stamp = skipStamps.get(name) ?? previousSkipStamps.get(name)
        return stamp ? [stamp] : []
      })
      const phase: DataMaintenancePhase = reachedEnd
        ? persistentSkippedNames.length > 0 ? 'degraded' : 'complete'
        : 'running'

      let segmentName: string | undefined
      if (summaries.length > 0) {
        segmentName = `${catalogSegmentPrefix}${createHash('sha256')
          .update(processedNames.join('\0'))
          .digest('hex')
          .slice(0, 24)}.json`
        await writeCatalogSegment(dataDir, segmentName, {
          version: 1,
          entries: summaries,
        }, fileOps)
      }

      await writeCatalogManifest(dataDir, {
        version: 3,
        sourceFingerprint,
        // Retried names are already known, so the union keeps the list from growing on every repair.
        knownFileNames: [...new Set([...manifest.knownFileNames, ...processedNames])],
        skippedFileNames: persistentSkippedNames,
        skippedFileStamps: persistentSkippedStamps,
        segments: segmentName ? [...manifest.segments, segmentName] : manifest.segments,
      }, fileOps)

      return {
        phase,
        cursor,
        processedDelta: processed,
        skippedDelta: newPass ? persistentSkippedNames.length : skipped,
        total: newPass ? pendingNames.length : previous?.total ?? pendingNames.length,
        replaceProgress: newPass,
      }
    },
  }
}

export const resetSessionHistoryCatalogCacheForTests = () => {
  // 刻意不清 `skippedRecheckCursors`：它按 dataDir 分键，测试各自用独立临时目录不会串味，而清掉
  // 会让「连续切片轮转扫完整个 skip 集合」这条覆盖在测试里退化成永远重扫同一个前缀。
  catalogCache.clear()
}

export const runSessionHistoryCatalogMaintenanceSlice = async ({
  dataDir = getAppDataDir(),
  limits,
  fileOps,
}: {
  dataDir?: string
  limits?: CatalogLimits
  fileOps?: CatalogFileOps
} = {}): Promise<SessionHistoryCatalogMaintenanceStatus> => {
  const before = (await readDataMaintenanceLedger(dataDir)).tasks[catalogTaskId]
  let lastSliceProcessed = 0
  const ledger = await runDataMaintenanceSlice({
    dataDir,
    tasks: [createSessionHistoryCatalogTask({
      dataDir,
      limits,
      fileOps,
      onSlice: (processed) => {
        lastSliceProcessed = processed
      },
    })],
  })
  const state = ledger.tasks[catalogTaskId]
  if (!state) {
    return { phase: 'idle', processed: 0, skipped: 0, lastSliceProcessed: 0 }
  }
  if (lastSliceProcessed === 0 && before && state.processed > before.processed) {
    lastSliceProcessed = state.processed - before.processed
  }
  return {
    phase: state.phase,
    processed: state.processed,
    skipped: state.skipped,
    total: state.total,
    lastSliceProcessed,
    lastError: state.lastError,
  }
}

const getMaintenanceStatus = async (dataDir: string): Promise<SessionHistoryCatalogMaintenanceStatus> => {
  const state = (await readDataMaintenanceLedger(dataDir)).tasks[catalogTaskId]
  return state
    ? {
        phase: state.phase,
        processed: state.processed,
        skipped: state.skipped,
        total: state.total,
        lastSliceProcessed: 0,
        lastError: state.lastError,
      }
    : { phase: 'idle', processed: 0, skipped: 0, lastSliceProcessed: 0 }
}

const metadataSearchText = (entry: SessionHistoryEntry) => [
  entry.title,
  entry.sessionId ?? '',
  entry.provider,
  entry.model,
  entry.workspacePath,
].join('\n').toLocaleLowerCase()

export const listInternalSessionHistory = async ({
  workspacePath,
  query,
  dataDir = getAppDataDir(),
}: {
  workspacePath: string
  query: string
  dataDir?: string
}): Promise<{
  entries: SessionHistoryEntry[]
  total: number
  maintenance: SessionHistoryCatalogMaintenanceStatus
}> => {
  const manifest = await readCatalogManifest(dataDir)
  const catalogEntries = await readCatalogEntries(dataDir, manifest)
  const hidden = await readHiddenCatalog(getHistoryDirectory(dataDir))
  const hiddenIds = new Set(hidden.entryIds)
  const hiddenSessions = new Set(hidden.sessionKeys)
  const normalizedWorkspace = normalizePath(workspacePath)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const candidates = catalogEntries
    .map((summary) => summary.entry)
    .filter((entry) => {
      const key = sessionKey(entry.provider, entry.sessionId)
      return (
        normalizePath(entry.workspacePath) === normalizedWorkspace &&
        !hiddenIds.has(entry.id) &&
        !(key && hiddenSessions.has(key)) &&
        (!normalizedQuery || metadataSearchText(entry).includes(normalizedQuery))
      )
    })
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))

  const seenSessions = new Set<string>()
  const unique = candidates.filter((entry) => {
    const key = sessionKey(entry.provider, entry.sessionId)
    if (!key) return true
    if (seenSessions.has(key)) return false
    seenSessions.add(key)
    return true
  })

  return {
    total: unique.length,
    entries: unique.slice(0, maxResults),
    maintenance: await getMaintenanceStatus(dataDir),
  }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export const searchInternalSessionHistory = async (options: {
  workspacePath: string
  query: string
}): Promise<{ entries: SessionHistoryEntry[]; total: number }> => {
  const query = options.query.trim().toLocaleLowerCase()
  if (!query) return { entries: [], total: 0 }

  const dataDir = getAppDataDir()
  const directory = getHistoryDirectory(dataDir)
  const names = (await listSidecarNames(dataDir)).slice(0, 500)
  const hidden = await readHiddenCatalog(directory)
  const hiddenIds = new Set(hidden.entryIds)
  const hiddenSessions = new Set(hidden.sessionKeys)
  const candidates: SessionHistoryEntry[] = []
  const startedAt = Date.now()

  for (const name of names) {
    if (Date.now() - startedAt >= 1_000) break
    try {
      const filePath = path.join(directory, name)
      if ((await stat(filePath)).size > defaultLimits.maxFileBytes) continue
      const content = await readFile(filePath, 'utf8')
      const summary = parseCatalogSource(content, name)
      const raw = JSON.parse(content) as { messages?: unknown[] }
      const entry = summary.entry
      const key = sessionKey(entry.provider, entry.sessionId)
      if (
        normalizePath(entry.workspacePath) !== normalizePath(options.workspacePath) ||
        hiddenIds.has(entry.id) ||
        (key && hiddenSessions.has(key))
      ) continue
      const searchText = [
        metadataSearchText(entry),
        ...(Array.isArray(raw.messages)
          ? raw.messages.flatMap((message) => {
              if (!message || typeof message !== 'object') return []
              const contentValue = (message as { content?: unknown }).content
              return typeof contentValue === 'string' ? [contentValue] : []
            })
          : []),
      ].join('\n').toLocaleLowerCase()
      if (searchText.includes(query)) candidates.push(entry)
    } catch {
      // A damaged sidecar must not make the whole history search unavailable.
    }
    await yieldToEventLoop()
  }

  candidates.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
  const seenSessions = new Set<string>()
  const unique = candidates.filter((entry) => {
    const key = sessionKey(entry.provider, entry.sessionId)
    if (!key) return true
    if (seenSessions.has(key)) return false
    seenSessions.add(key)
    return true
  })
  const total = unique.length
  return {
    total,
    entries: unique.slice(0, maxResults).map((entry) => ({
      ...entry,
      messageCount: entry.messageCount ?? entry.messages.length,
      messages: [],
      messagesPreview: true,
    })),
  }
}

export const hideInternalSessionHistoryEntries = async (options: {
  entryId: string
  provider: Provider
  sessionId?: string
}) => {
  const directory = getHistoryDirectory()
  const hidden = await readHiddenCatalog(directory)
  hidden.entryIds = [...new Set([...hidden.entryIds, options.entryId])]
  const key = sessionKey(options.provider, options.sessionId)
  if (key) hidden.sessionKeys = [...new Set([...hidden.sessionKeys, key])]
  await writeHiddenCatalog(directory, hidden)
}

export const revealInternalSessionHistorySession = async (options: {
  provider: Provider
  sessionId?: string
  dataDir?: string
}) => {
  const key = sessionKey(options.provider, options.sessionId)
  if (!key) return
  const directory = getHistoryDirectory(options.dataDir)
  const hidden = await readHiddenCatalog(directory)
  if (!hidden.sessionKeys.includes(key)) return
  hidden.sessionKeys = hidden.sessionKeys.filter((current) => current !== key)
  await writeHiddenCatalog(directory, hidden)
}
