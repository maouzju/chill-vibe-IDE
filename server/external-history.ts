import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'

import type {
  ChatMessage,
  ExternalHistoryListRequest,
  ExternalHistoryListResponse,
  ExternalSessionLoadRequest,
  ExternalSessionLoadResponse,
  ExternalSessionSummary,
  Provider,
} from '../shared/schema.js'
import { stripXmlTags } from '../shared/default-state.js'
import { getAppDataDir } from './app-paths.js'

type CachedEntry = { mtimeMs: number; size: number; summary: ExternalSessionSummary | null }
type FileStatSnapshot = { mtimeMs: number; size: number }
type WatchedFileStatSnapshot = FileStatSnapshot & { path: string }
type CodexPersistentIndexEntry = {
  baseName: string
  sessionId: string
  filePath: string
  fileStat: FileStatSnapshot
  summary: ExternalSessionSummary
}
type CodexPersistentIndex = {
  version: 2
  generatedAt: string
  scanRoots: string[]
  sessionIndexStats: WatchedFileStatSnapshot[]
  sessions: CodexPersistentIndexEntry[]
}
type CodexSessionMeta = {
  id?: string
  cwd?: string
  model?: string
  timestamp?: string
}

const externalHistoryHomeEnvKey = 'CHILL_VIBE_EXTERNAL_HISTORY_HOME'
const codexPersistentIndexVersion = 2
const summaryCache = new Map<string, CachedEntry>()

let codexSessionIndex:
  | {
      stats: WatchedFileStatSnapshot[]
      titles: Map<string, string>
    }
  | null = null
let codexPersistentIndex: CodexPersistentIndex | null = null
let codexPersistentIndexRefresh: Promise<CodexPersistentIndex> | null = null

const resolveConfiguredPath = (value: string | undefined) => {
  const normalized = value?.trim()
  return normalized ? path.resolve(normalized) : null
}

const resolveExternalHistoryHomeDirs = () => {
  const configured = process.env[externalHistoryHomeEnvKey]?.trim()
  if (configured) {
    return [path.resolve(configured)]
  }

  const candidates = [
    resolveConfiguredPath(process.env.HOME),
    resolveConfiguredPath(process.env.USERPROFILE),
    resolveConfiguredPath(
      process.env.HOMEDRIVE && process.env.HOMEPATH
        ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
        : undefined,
    ),
    resolveConfiguredPath(os.homedir()),
  ]

  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (candidate) {
      unique.add(candidate)
    }
  }

  return Array.from(unique)
}

const getClaudeProjectsDirs = () =>
  resolveExternalHistoryHomeDirs().map((homeDir) => path.join(homeDir, '.claude', 'projects'))
const getCodexBaseDirs = () =>
  resolveExternalHistoryHomeDirs().map((homeDir) => path.join(homeDir, '.codex'))
const getCodexSessionsDirs = () => getCodexBaseDirs().map((baseDir) => path.join(baseDir, 'sessions'))
const getCodexArchivedDirs = () =>
  getCodexBaseDirs().map((baseDir) => path.join(baseDir, 'archived_sessions'))
const getCodexSessionIndexPaths = () =>
  getCodexBaseDirs().map((baseDir) => path.join(baseDir, 'session_index.jsonl'))
const getCodexPersistentIndexPath = () => path.join(getAppDataDir(), 'external-history-codex-index.json')

const createId = () => crypto.randomUUID()

const getFileStatSnapshot = (filePath: string): FileStatSnapshot | null => {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
}

const getWatchedFileStatSnapshot = (filePath: string): WatchedFileStatSnapshot | null => {
  const stat = getFileStatSnapshot(filePath)
  return stat ? { path: filePath, ...stat } : null
}

const areSameWatchedFileStats = (
  left: WatchedFileStatSnapshot[],
  right: WatchedFileStatSnapshot[],
) =>
  left.length === right.length
  && left.every(
    (entry, index) =>
      entry.path === right[index]?.path
      && entry.mtimeMs === right[index]?.mtimeMs
      && entry.size === right[index]?.size,
  )

const areSamePaths = (left: string[], right: string[]) =>
  left.length === right.length && left.every((entry, index) => entry === right[index])

const normalizeWorkspacePath = (workspacePath: string) => workspacePath.replace(/\//g, '\\').toLowerCase()

const getCachedSummary = (
  cacheKey: string,
  filePath: string,
): ExternalSessionSummary | null | undefined => {
  const cached = summaryCache.get(cacheKey)
  if (!cached) {
    return undefined
  }

  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  if (!stat || stat.mtimeMs !== cached.mtimeMs || stat.size !== cached.size) {
    summaryCache.delete(cacheKey)
    return undefined
  }

  return cached.summary
}

const setCachedSummary = (
  cacheKey: string,
  filePath: string,
  summary: ExternalSessionSummary | null,
): void => {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  if (stat) {
    summaryCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, summary })
  }
}

export const clearSummaryCache = (): void => {
  summaryCache.clear()
  codexSessionIndex = null
  codexPersistentIndex = null
  codexPersistentIndexRefresh = null
}

const toClaudeProjectDir = (workspacePath: string): string => {
  const normalized = workspacePath.replace(/\//g, '\\')
  const match = normalized.match(/^([A-Za-z]):\\(.*)$/)

  if (!match) {
    return normalized.replace(/[\\/]/g, '-')
  }

  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/[\\/]/g, '-')
  return `${drive}--${rest}`
}

const tryParseJson = (line: string): unknown | null => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const createLineReader = (filePath: string) =>
  readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

const extractClaudeTextContent = (msg: {
  role: string
  content: unknown
}): string | null => {
  if (typeof msg.content === 'string') {
    return msg.content
  }

  if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter(
        (block: { type?: string }) =>
          typeof block === 'object' && block !== null && block.type === 'text',
      )
      .map((block: { text?: string }) => block.text ?? '')
      .filter((text: string) => text.length > 0)

    return textParts.length > 0 ? textParts.join('\n') : null
  }

  return null
}

const summarizeClaudeSession = async (
  filePath: string,
  workspacePath: string,
): Promise<ExternalSessionSummary | null> => {
  const fileName = path.basename(filePath, '.jsonl')
  const reader = createLineReader(filePath)

  let firstUserText: string | null = null
  let firstTimestamp: string | null = null
  let lastTimestamp: string | null = null
  let model = ''
  let messageCount = 0

  for await (const line of reader) {
    const parsed = tryParseJson(line) as {
      type?: string
      timestamp?: string
      message?: { role?: string; content?: unknown; model?: string }
      isMeta?: boolean
    } | null

    if (!parsed || !parsed.type) {
      continue
    }

    if (parsed.type === 'user' && !parsed.isMeta) {
      const text = parsed.message?.content
      if (typeof text === 'string' && text.trim().length > 0) {
        messageCount++
        if (!firstTimestamp && parsed.timestamp) {
          firstTimestamp = parsed.timestamp
        }
        if (parsed.timestamp) {
          lastTimestamp = parsed.timestamp
        }
        if (!firstUserText) {
          firstUserText = stripXmlTags(text).trim().slice(0, 100)
        }
      }
    }

    if (parsed.type === 'assistant') {
      messageCount++
      if (!firstTimestamp && parsed.timestamp) {
        firstTimestamp = parsed.timestamp
      }
      if (parsed.timestamp) {
        lastTimestamp = parsed.timestamp
      }
      if (!model && parsed.message?.model) {
        model = parsed.message.model
      }
    }
  }

  if (messageCount === 0) {
    return null
  }

  return {
    id: fileName,
    provider: 'claude',
    title: firstUserText || 'Claude Code session',
    model,
    workspacePath,
    messageCount,
    startedAt: firstTimestamp ?? new Date().toISOString(),
    updatedAt: lastTimestamp ?? firstTimestamp ?? new Date().toISOString(),
  }
}

const loadClaudeMessages = async (filePath: string): Promise<ChatMessage[]> => {
  const reader = createLineReader(filePath)
  const messages: ChatMessage[] = []

  for await (const line of reader) {
    const parsed = tryParseJson(line) as {
      type?: string
      uuid?: string
      timestamp?: string
      message?: { role?: string; content?: unknown; model?: string }
      isMeta?: boolean
    } | null

    if (!parsed || !parsed.type) {
      continue
    }

    if (parsed.type === 'user' && !parsed.isMeta && parsed.message) {
      const text = extractClaudeTextContent(
        parsed.message as { role: string; content: unknown },
      )
      if (text && text.trim().length > 0) {
        messages.push({
          id: parsed.uuid ?? createId(),
          role: 'user',
          content: text.trim(),
          createdAt: parsed.timestamp ?? new Date().toISOString(),
        })
      }
    }

    if (parsed.type === 'assistant' && parsed.message) {
      const text = extractClaudeTextContent(
        parsed.message as { role: string; content: unknown },
      )
      if (text && text.trim().length > 0) {
        messages.push({
          id: parsed.uuid ?? createId(),
          role: 'assistant',
          content: text.trim(),
          createdAt: parsed.timestamp ?? new Date().toISOString(),
          meta: parsed.message.model
            ? { provider: 'claude', model: parsed.message.model }
            : { provider: 'claude' },
        })
      }
    }
  }

  return messages
}

const listClaudeSessions = async (
  workspacePath: string,
): Promise<ExternalSessionSummary[]> => {
  const projectDirs = getClaudeProjectsDirs().map((projectsDir) =>
    path.join(projectsDir, toClaudeProjectDir(workspacePath)),
  )
  const files = projectDirs.flatMap((projectDir) =>
    fs.existsSync(projectDir)
      ? fs.readdirSync(projectDir)
          .filter((entry) => entry.endsWith('.jsonl'))
          .map((fileName) => path.join(projectDir, fileName))
      : [],
  )

  const results = await Promise.all(
    files.map(async (filePath) => {
      const cached = getCachedSummary(filePath, filePath)
      if (cached !== undefined) {
        return cached
      }

      try {
        const summary = await summarizeClaudeSession(filePath, workspacePath)
        setCachedSummary(filePath, filePath, summary)
        return summary
      } catch {
        return null
      }
    }),
  )

  return results.filter((summary): summary is ExternalSessionSummary => summary !== null)
}

const findClaudeSessionFile = (
  workspacePath: string,
  sessionId: string,
): string | null => {
  const projectName = toClaudeProjectDir(workspacePath)

  for (const projectsDir of getClaudeProjectsDirs()) {
    const filePath = path.join(projectsDir, projectName, `${sessionId}.jsonl`)
    if (fs.existsSync(filePath)) {
      return filePath
    }
  }

  return null
}

const findCodexSessionFiles = (): string[] => {
  const files: string[] = []

  const walkDir = (dir: string) => {
    if (!fs.existsSync(dir)) {
      return
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walkDir(fullPath)
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath)
      }
    }
  }

  for (const sessionsDir of getCodexSessionsDirs()) {
    walkDir(sessionsDir)
  }
  for (const archivedDir of getCodexArchivedDirs()) {
    walkDir(archivedDir)
  }
  return files
}

const getCodexSessionIndexStats = () =>
  getCodexSessionIndexPaths()
    .map((indexPath) => getWatchedFileStatSnapshot(indexPath))
    .filter((stat): stat is WatchedFileStatSnapshot => stat !== null)

const loadCodexSessionIndex = () => {
  const stats = getCodexSessionIndexStats()

  if (codexSessionIndex && areSameWatchedFileStats(codexSessionIndex.stats, stats)) {
    return codexSessionIndex.titles
  }

  const titles = new Map<string, string>()

  for (const indexPath of getCodexSessionIndexPaths()) {
    if (!fs.existsSync(indexPath)) {
      continue
    }

    const content = fs.readFileSync(indexPath, 'utf-8')
    for (const line of content.split('\n')) {
      const parsed = tryParseJson(line.trim()) as {
        id?: string
        thread_name?: string
      } | null

      if (parsed?.id && parsed.thread_name) {
        titles.set(parsed.id, parsed.thread_name)
      }
    }
  }

  codexSessionIndex = { stats, titles }
  return titles
}

const getCodexSessionTitle = (sessionId: string): string | null => loadCodexSessionIndex().get(sessionId) ?? null

const summarizeCodexSession = async (
  filePath: string,
  sessionTitles: Map<string, string>,
  expectedWorkspacePath?: string,
): Promise<CodexPersistentIndexEntry | null> => {
  const reader = createLineReader(filePath)
  const targetWorkspace = expectedWorkspacePath ? normalizeWorkspacePath(expectedWorkspacePath) : null
  const baseName = path.basename(filePath, '.jsonl')

  let meta: CodexSessionMeta | null = null
  let firstUserText: string | null = null
  let firstTimestamp: string | null = null
  let lastTimestamp: string | null = null
  let messageCount = 0

  for await (const line of reader) {
    const parsed = tryParseJson(line) as {
      type?: string
      timestamp?: string
      payload?: Record<string, unknown>
    } | null

    if (!parsed || !parsed.type) {
      continue
    }

    if (parsed.timestamp) {
      if (!firstTimestamp) {
        firstTimestamp = parsed.timestamp
      }
      lastTimestamp = parsed.timestamp
    }

    if (parsed.type === 'session_meta' && parsed.payload) {
      meta = parsed.payload as CodexSessionMeta
      const metaWorkspace = normalizeWorkspacePath(meta.cwd ?? '')
      if (targetWorkspace !== null && metaWorkspace !== targetWorkspace) {
        reader.close()
        return null
      }
    }

    if (parsed.type === 'event_msg') {
      const payload = parsed.payload as { type?: string; message?: string } | null
      if (payload?.type === 'user_message' && payload.message) {
        messageCount++
        if (!firstUserText) {
          const trimmed = stripXmlTags(payload.message).trim().slice(0, 100)
          if (trimmed.length > 0) {
            firstUserText = trimmed
          }
        }
      }
    }

    if (parsed.type === 'response_item') {
      const payload = parsed.payload as { role?: string; type?: string } | null
      if (payload?.role === 'assistant' || payload?.type === 'message') {
        messageCount++
      }
    }
  }

  if (!meta || messageCount === 0) {
    return null
  }

  const sessionId = meta.id ?? baseName
  const workspacePath = typeof meta.cwd === 'string' ? meta.cwd : expectedWorkspacePath ?? ''
  const fileStat = getFileStatSnapshot(filePath)

  if (!workspacePath || !fileStat) {
    return null
  }

  let title = firstUserText || 'Codex session'
  const indexedTitle = sessionTitles.get(sessionId)
  if (indexedTitle?.trim()) {
    title = indexedTitle
  }

  return {
    baseName,
    sessionId,
    filePath,
    fileStat,
    summary: {
      id: `codex:${baseName}`,
      provider: 'codex',
      title,
      model: typeof meta.model === 'string' ? meta.model : '',
      workspacePath,
      messageCount,
      startedAt: meta.timestamp ?? firstTimestamp ?? new Date().toISOString(),
      updatedAt: lastTimestamp ?? firstTimestamp ?? new Date().toISOString(),
    },
  }
}

const parseCodexPersistentIndex = (raw: unknown): CodexPersistentIndex | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const parseStat = (value: unknown): FileStatSnapshot | null => {
    if (!value || typeof value !== 'object') {
      return null
    }

    const stat = value as { mtimeMs?: unknown; size?: unknown }
    return typeof stat.mtimeMs === 'number' && typeof stat.size === 'number'
      ? { mtimeMs: stat.mtimeMs, size: stat.size }
      : null
  }

  const parseWatchedStat = (value: unknown): WatchedFileStatSnapshot | null => {
    if (!value || typeof value !== 'object') {
      return null
    }

    const record = value as { path?: unknown; mtimeMs?: unknown; size?: unknown }
    return typeof record.path === 'string'
      && typeof record.mtimeMs === 'number'
      && typeof record.size === 'number'
      ? { path: record.path, mtimeMs: record.mtimeMs, size: record.size }
      : null
  }

  const record = raw as {
    version?: unknown
    generatedAt?: unknown
    scanRoots?: unknown
    sessionIndexStats?: unknown
    sessions?: unknown
  }

  if (
    record.version !== codexPersistentIndexVersion ||
    typeof record.generatedAt !== 'string' ||
    !Array.isArray(record.scanRoots) ||
    !Array.isArray(record.sessionIndexStats) ||
    !Array.isArray(record.sessions)
  ) {
    return null
  }

  const scanRoots = record.scanRoots.filter((value): value is string => typeof value === 'string')
  if (scanRoots.length !== record.scanRoots.length) {
    return null
  }

  const sessionIndexStats = record.sessionIndexStats.flatMap((value) => {
    const stat = parseWatchedStat(value)
    return stat ? [stat] : []
  })
  if (sessionIndexStats.length !== record.sessionIndexStats.length) {
    return null
  }

  const sessions = record.sessions.flatMap((value): CodexPersistentIndexEntry[] => {
    if (!value || typeof value !== 'object') {
      return []
    }

    const entry = value as {
      baseName?: unknown
      sessionId?: unknown
      filePath?: unknown
      fileStat?: unknown
      summary?: unknown
    }
    const fileStat = parseStat(entry.fileStat)
    const summary = entry.summary as ExternalSessionSummary | undefined

    if (
      typeof entry.baseName !== 'string' ||
      typeof entry.sessionId !== 'string' ||
      typeof entry.filePath !== 'string' ||
      !fileStat ||
      !summary ||
      typeof summary.id !== 'string' ||
      summary.provider !== 'codex' ||
      typeof summary.title !== 'string' ||
      typeof summary.model !== 'string' ||
      typeof summary.workspacePath !== 'string' ||
      typeof summary.messageCount !== 'number' ||
      typeof summary.startedAt !== 'string' ||
      typeof summary.updatedAt !== 'string'
    ) {
      return []
    }

    return [{
      baseName: entry.baseName,
      sessionId: entry.sessionId,
      filePath: entry.filePath,
      fileStat,
      summary,
    }]
  })

  return {
    version: codexPersistentIndexVersion,
    generatedAt: record.generatedAt,
    scanRoots,
    sessionIndexStats,
    sessions,
  }
}

const readCodexPersistentIndex = (): CodexPersistentIndex | null => {
  if (codexPersistentIndex) {
    return codexPersistentIndex
  }

  try {
    const content = fs.readFileSync(getCodexPersistentIndexPath(), 'utf-8')
    const parsed = parseCodexPersistentIndex(JSON.parse(content))
    if (!parsed) {
      return null
    }

    codexPersistentIndex = parsed
    return parsed
  } catch {
    return null
  }
}

const writeCodexPersistentIndex = (index: CodexPersistentIndex) => {
  fs.mkdirSync(getAppDataDir(), { recursive: true })
  fs.writeFileSync(getCodexPersistentIndexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  codexPersistentIndex = index
}

const buildCodexPersistentIndex = async (): Promise<CodexPersistentIndex> => {
  const scanRoots = resolveExternalHistoryHomeDirs()
  const sessionIndexStats = getCodexSessionIndexStats()
  const sessionTitles = loadCodexSessionIndex()
  const files = findCodexSessionFiles()

  const sessions = (
    await Promise.all(
      files.map(async (filePath) => {
        try {
          return await summarizeCodexSession(filePath, sessionTitles)
        } catch {
          return null
        }
      }),
    )
  ).filter((entry): entry is CodexPersistentIndexEntry => entry !== null)

  const index: CodexPersistentIndex = {
    version: codexPersistentIndexVersion,
    generatedAt: new Date().toISOString(),
    scanRoots,
    sessionIndexStats,
    sessions,
  }

  writeCodexPersistentIndex(index)
  return index
}

const refreshCodexPersistentIndex = () => {
  if (!codexPersistentIndexRefresh) {
    codexPersistentIndexRefresh = buildCodexPersistentIndex().finally(() => {
      codexPersistentIndexRefresh = null
    })
  }

  return codexPersistentIndexRefresh
}

const ensureCodexPersistentIndex = async () => readCodexPersistentIndex() ?? refreshCodexPersistentIndex()

const scheduleCodexPersistentIndexRefresh = () => {
  void refreshCodexPersistentIndex().catch(() => undefined)
}

const materializeCodexSessions = (
  index: CodexPersistentIndex,
  workspacePath: string,
): ExternalSessionSummary[] => {
  const targetWorkspace = normalizeWorkspacePath(workspacePath)

  return index.sessions
    .filter((entry) => normalizeWorkspacePath(entry.summary.workspacePath) === targetWorkspace)
    .map((entry) => {
      const latestTitle = getCodexSessionTitle(entry.sessionId)
      return latestTitle?.trim() && latestTitle !== entry.summary.title
        ? {
            ...entry.summary,
            title: latestTitle,
          }
        : entry.summary
    })
}

const findCodexIndexedSession = async (baseName: string): Promise<CodexPersistentIndexEntry | null> => {
  const index = await ensureCodexPersistentIndex()
  return index.sessions.find((entry) => entry.baseName === baseName) ?? null
}

const findCodexSessionFile = (sessionBaseName: string): string | null => {
  const fileName = `${sessionBaseName}.jsonl`

  const tryFind = (dir: string): string | null => {
    if (!fs.existsSync(dir)) {
      return null
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = tryFind(fullPath)
        if (found) {
          return found
        }
      } else if (entry.name === fileName) {
        return fullPath
      }
    }

    return null
  }

  for (const sessionsDir of getCodexSessionsDirs()) {
    const found = tryFind(sessionsDir)
    if (found) {
      return found
    }
  }

  for (const archivedDir of getCodexArchivedDirs()) {
    const found = tryFind(archivedDir)
    if (found) {
      return found
    }
  }

  return null
}

const loadCodexMessages = async (filePath: string): Promise<ChatMessage[]> => {
  const reader = createLineReader(filePath)
  const messages: ChatMessage[] = []

  for await (const line of reader) {
    const parsed = tryParseJson(line) as {
      type?: string
      timestamp?: string
      payload?: Record<string, unknown>
    } | null

    if (!parsed || !parsed.type) {
      continue
    }

    if (parsed.type === 'event_msg') {
      const payload = parsed.payload as { type?: string; message?: string } | null
      if (payload?.type === 'user_message' && payload.message) {
        let userText = payload.message
        const requestMatch = userText.match(/## My request for Codex:\n([\s\S]+?)$/)
        if (requestMatch) {
          userText = requestMatch[1].trim()
        }

        if (userText.trim().length > 0) {
          messages.push({
            id: createId(),
            role: 'user',
            content: userText.trim(),
            createdAt: parsed.timestamp ?? new Date().toISOString(),
          })
        }
      }
    }

    if (parsed.type === 'response_item') {
      const payload = parsed.payload as {
        role?: string
        type?: string
        content?: Array<{ type?: string; text?: string }>
      } | null

      if (payload?.role === 'assistant' && Array.isArray(payload.content)) {
        const textParts = payload.content
          .filter((block) => block.type === 'output_text' || block.type === 'text')
          .map((block) => block.text ?? '')
          .filter((text) => text.length > 0)

        if (textParts.length > 0) {
          messages.push({
            id: createId(),
            role: 'assistant',
            content: textParts.join('\n'),
            createdAt: parsed.timestamp ?? new Date().toISOString(),
            meta: { provider: 'codex' },
          })
        }
      }
    }
  }

  return messages
}

const listCodexSessions = async (
  workspacePath: string,
): Promise<ExternalSessionSummary[]> => {
  const index = await ensureCodexPersistentIndex()
  if (
    !areSamePaths(index.scanRoots, resolveExternalHistoryHomeDirs())
    || !areSameWatchedFileStats(index.sessionIndexStats, getCodexSessionIndexStats())
  ) {
    scheduleCodexPersistentIndexRefresh()
  }

  return materializeCodexSessions(index, workspacePath)
}

export const listExternalSessions = async (
  request: ExternalHistoryListRequest,
): Promise<ExternalHistoryListResponse> => {
  const { workspacePath } = request

  const [claudeSessions, codexSessions] = await Promise.all([
    listClaudeSessions(workspacePath).catch(() => [] as ExternalSessionSummary[]),
    listCodexSessions(workspacePath).catch(() => [] as ExternalSessionSummary[]),
  ])

  const sessions = [...claudeSessions, ...codexSessions].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )

  return { sessions }
}

export const loadExternalSession = async (
  request: ExternalSessionLoadRequest,
): Promise<ExternalSessionLoadResponse> => {
  const { provider, sessionId, workspacePath } = request

  let messages: ChatMessage[]
  let title = ''
  let model = ''

  if (provider === 'claude') {
    const filePath = findClaudeSessionFile(workspacePath, sessionId)

    if (!filePath) {
      throw new Error(`Claude Code session not found: ${sessionId}`)
    }

    messages = await loadClaudeMessages(filePath)
    title =
      stripXmlTags(messages.find((message) => message.role === 'user')?.content ?? '').trim().slice(0, 100) ||
      'Claude Code session'
    model = messages.find((message) => message.role === 'assistant')?.meta?.model ?? ''
  } else {
    const baseName = sessionId.startsWith('codex:') ? sessionId.slice(6) : sessionId
    const indexed = await findCodexIndexedSession(baseName)
    const filePath =
      indexed && fs.existsSync(indexed.filePath)
        ? indexed.filePath
        : findCodexSessionFile(baseName)

    if (!filePath) {
      throw new Error(`Codex session not found: ${sessionId}`)
    }

    messages = await loadCodexMessages(filePath)
    title =
      stripXmlTags(messages.find((message) => message.role === 'user')?.content ?? '').trim().slice(0, 100) ||
      'Codex session'
  }

  return {
    entry: {
      id: createId(),
      title,
      provider: provider as Provider,
      model,
      workspacePath,
      messages,
      archivedAt: new Date().toISOString(),
    },
  }
}
