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

const catalogManifestSchema = z.object({
  version: z.literal(3),
  sourceFingerprint: z.string(),
  knownFileNames: z.array(z.string().min(1)),
  skippedFileNames: z.array(z.string().min(1)).default([]),
  segments: z.array(z.string().min(1)),
})

const catalogSegmentSchema = z.object({
  version: z.literal(1),
  entries: z.array(catalogSummarySchema),
})

type SessionHistoryCatalogManifest = z.infer<typeof catalogManifestSchema>
type SessionHistoryCatalogSegment = z.infer<typeof catalogSegmentSchema>

const emptyCatalogManifest = (): SessionHistoryCatalogManifest => ({
  version: 3,
  sourceFingerprint: '',
  knownFileNames: [],
  skippedFileNames: [],
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

  return {
    id: catalogTaskId,
    version: catalogTaskVersion,
    async shouldRun({ previous }) {
      const names = await listSidecarNames(dataDir)
      const manifest = await readCatalogManifest(dataDir)
      const changed = manifest.sourceFingerprint !== fingerprintNames(names)
      return !previous || previous.phase === 'running' || changed
    },
    async runSlice({ previous }) {
      const names = await listSidecarNames(dataDir)
      const sourceFingerprint = fingerprintNames(names)
      const manifest = await readCatalogManifest(dataDir)
      const knownFileNames = new Set(manifest.knownFileNames)
      const pendingNames = names.filter((name) => !knownFileNames.has(name))
      const newPass = previous?.phase !== 'running'
      const summaries: Array<z.infer<typeof catalogSummarySchema>> = []
      const processedNames: string[] = []
      const skippedNames: string[] = []
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
        try {
          size = (await stat(filePath)).size
        } catch {
          processed += 1
          skipped += 1
          cursor = name
          processedNames.push(name)
          skippedNames.push(name)
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
          skippedNames.push(name)
          continue
        }

        try {
          const summary = parseCatalogSource(await readFile(filePath, 'utf8'), name)
          if (manifest.knownFileNames.length + processed >= maxCatalogEntries) {
            skipped += 1
            skippedNames.push(name)
          } else {
            summaries.push(summary)
          }
        } catch {
          skipped += 1
          skippedNames.push(name)
        }
        bytes += size
        processed += 1
        cursor = name
        processedNames.push(name)
      }

      onSlice(processed)
      const reachedEnd = index >= pendingNames.length
      const currentNames = new Set(names)
      const persistentSkippedNames = [...new Set([
        ...manifest.skippedFileNames.filter((name) => currentNames.has(name)),
        ...skippedNames,
      ])]
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
        knownFileNames: [...manifest.knownFileNames, ...processedNames],
        skippedFileNames: persistentSkippedNames,
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
