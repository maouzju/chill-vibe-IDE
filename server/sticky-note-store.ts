import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getAppDataDir } from './app-paths.js'

export const stickyNoteVersionLimit = 50
export const stickyNoteContentLimit = 64_000

type StickyNoteStoreOptions = {
  dataDir?: string
  now?: () => Date
  createId?: () => string
}

export type StickyNoteStoreRequest = {
  workspacePath: string
  noteId: string
}

export type StickyNoteSaveRequest = StickyNoteStoreRequest & {
  title: string
  content: string
  checkpoint?: boolean
}

export type StickyNoteVersionRequest = StickyNoteStoreRequest & {
  versionId: string
}

export type StickyNoteVersionSummary = {
  id: string
  createdAt: string
  title: string
  preview: string
}

export type StickyNoteSummary = {
  noteId: string
  title: string
  fileName: string
  createdAt: string
  updatedAt: string
  preview: string
}

export type StickyNoteDocument = StickyNoteSummary & {
  content: string
  versions: StickyNoteVersionSummary[]
}

type StickyNoteIndexEntry = Omit<StickyNoteSummary, 'noteId' | 'preview'>

type StickyNoteIndex = {
  version: 1
  workspacePath: string
  notes: Record<string, StickyNoteIndexEntry>
}

type StickyNoteVersionFile = {
  version: 1
  id: string
  createdAt: string
  title: string
  content: string
}

const workspaceQueues = new Map<string, Promise<unknown>>()

const resolveOptions = (options: StickyNoteStoreOptions = {}) => ({
  dataDir: options.dataDir ?? getAppDataDir(),
  now: options.now ?? (() => new Date()),
  createId: options.createId ?? randomUUID,
})

const normalizeWorkspacePath = (workspacePath: string) => {
  const resolved = path.resolve(workspacePath.trim())
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const getWorkspaceKey = (workspacePath: string) =>
  createHash('sha256').update(normalizeWorkspacePath(workspacePath), 'utf8').digest('hex')

export const getStickyNoteWorkspaceDirectory = (
  workspacePath: string,
  dataDir = getAppDataDir(),
) => path.join(dataDir, 'sticky-notes', getWorkspaceKey(workspacePath))

const getIndexPath = (directory: string) => path.join(directory, 'workspace.json')
const getHistoryDirectory = (directory: string, noteId: string) =>
  path.join(directory, '.history', normalizeNoteId(noteId))

const normalizeNoteId = (noteId: string) => {
  const trimmed = noteId.trim()
  if (!trimmed) {
    throw new Error('Sticky note id is required.')
  }

  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return safe === trimmed
    ? safe
    : `${safe}-${createHash('sha1').update(trimmed, 'utf8').digest('hex').slice(0, 10)}`
}

const normalizeTitle = (title: string) => title.trim() || 'Sticky Note'

const sanitizeFileStem = (title: string) => {
  const forbidden = '<>:"/\\|?*'
  const normalized = Array.from(normalizeTitle(title), (character) =>
    character.charCodeAt(0) < 32 || forbidden.includes(character) ? ' ' : character,
  ).join('')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (normalized || 'Sticky Note').slice(0, 80)
}

const buildFileName = (title: string, noteId: string) =>
  `${sanitizeFileStem(title)}--${normalizeNoteId(noteId)}.md`

const previewContent = (content: string) =>
  content.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ?? ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const emptyIndex = (workspacePath: string): StickyNoteIndex => ({
  version: 1,
  workspacePath,
  notes: {},
})

const normalizeIndexEntry = (value: unknown): StickyNoteIndexEntry | null => {
  if (!isRecord(value)) return null
  if (
    typeof value.title !== 'string' ||
    typeof value.fileName !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return null
  }
  return {
    title: value.title,
    fileName: value.fileName,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const readIndex = async (directory: string, workspacePath: string): Promise<StickyNoteIndex> => {
  try {
    const parsed = JSON.parse(await readFile(getIndexPath(directory), 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.notes)) {
      return emptyIndex(workspacePath)
    }
    const notes = Object.fromEntries(
      Object.entries(parsed.notes).flatMap(([noteId, value]) => {
        const entry = normalizeIndexEntry(value)
        return entry ? [[noteId, entry] as const] : []
      }),
    )
    return {
      version: 1,
      workspacePath:
        typeof parsed.workspacePath === 'string' ? parsed.workspacePath : workspacePath,
      notes,
    }
  } catch {
    return emptyIndex(workspacePath)
  }
}

export const writeStickyNoteFileAtomically = async (
  target: string,
  content: string,
  fileOps: { renameFile?: typeof rename } = {},
) => {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const renameFile = fileOps.renameFile ?? rename
  try {
    await writeFile(temporary, content, 'utf8')
    try {
      await renameFile(temporary, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EPERM' && code !== 'EACCES') throw error

      // 症状：Windows 实机保存便签时偶发 EPERM，界面内容无法落盘。
      // 根因（2026-07-27 实测）：扫描器/文件管理器可短暂拒绝 replace-rename，但普通覆盖写仍可用。
      // 否决“先删目标再 rename”：中途崩溃会丢当前文件；这里保留旧文件直到覆盖写成功。
      await writeFile(target, content, 'utf8')
      await unlink(temporary).catch(() => undefined)
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const atomicWrite = writeStickyNoteFileAtomically

const writeIndex = async (directory: string, index: StickyNoteIndex) => {
  await atomicWrite(getIndexPath(directory), `${JSON.stringify(index, null, 2)}\n`)
}

const readVersionFile = async (filePath: string): Promise<StickyNoteVersionFile | null> => {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.id !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.title !== 'string' ||
      typeof parsed.content !== 'string'
    ) {
      return null
    }
    return {
      version: 1,
      id: parsed.id,
      createdAt: parsed.createdAt,
      title: parsed.title,
      content: parsed.content.slice(0, stickyNoteContentLimit),
    }
  } catch {
    return null
  }
}

const listVersionFiles = async (directory: string, noteId: string) => {
  const historyDirectory = getHistoryDirectory(directory, noteId)
  const names = await readdir(historyDirectory).catch(() => [] as string[])
  const versions = (
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => readVersionFile(path.join(historyDirectory, name))),
    )
  ).filter((version): version is StickyNoteVersionFile => version !== null)
  versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  return versions
}

const toVersionSummary = (version: StickyNoteVersionFile): StickyNoteVersionSummary => ({
  id: version.id,
  createdAt: version.createdAt,
  title: version.title,
  preview: previewContent(version.content),
})

const addCheckpoint = async (
  directory: string,
  noteId: string,
  title: string,
  content: string,
  options: ReturnType<typeof resolveOptions>,
) => {
  const versions = await listVersionFiles(directory, noteId)
  const latest = versions[0]
  if (latest?.title === title && latest.content === content) {
    return versions
  }

  const version: StickyNoteVersionFile = {
    version: 1,
    id: options.createId(),
    createdAt: options.now().toISOString(),
    title,
    content: content.slice(0, stickyNoteContentLimit),
  }
  const historyDirectory = getHistoryDirectory(directory, noteId)
  await atomicWrite(
    path.join(historyDirectory, `${normalizeNoteId(version.id)}.json`),
    `${JSON.stringify(version, null, 2)}\n`,
  )

  const nextVersions = [version, ...versions]
  for (const stale of nextVersions.slice(stickyNoteVersionLimit)) {
    await rm(path.join(historyDirectory, `${normalizeNoteId(stale.id)}.json`), { force: true })
  }
  return nextVersions.slice(0, stickyNoteVersionLimit)
}

const withWorkspaceQueue = async <T>(workspacePath: string, task: () => Promise<T>): Promise<T> => {
  const key = normalizeWorkspacePath(workspacePath)
  const previous = workspaceQueues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(task)
  workspaceQueues.set(key, current)
  try {
    return await current
  } finally {
    if (workspaceQueues.get(key) === current) {
      workspaceQueues.delete(key)
    }
  }
}

const loadStickyNoteInternal = async (
  workspacePath: string,
  noteId: string,
  options: ReturnType<typeof resolveOptions>,
): Promise<StickyNoteDocument> => {
  const directory = getStickyNoteWorkspaceDirectory(workspacePath, options.dataDir)
  const index = await readIndex(directory, workspacePath)
  const entry = index.notes[noteId]
  if (!entry) {
    throw new Error(`Sticky note not found: ${noteId}`)
  }
  const filePath = path.join(directory, entry.fileName)
  const fileStats = await stat(filePath).catch(() => null)
  if (!fileStats?.isFile()) {
    throw new Error(`Sticky note not found: ${noteId}`)
  }
  const content = (await readFile(filePath, 'utf8')).slice(0, stickyNoteContentLimit)
  const versions = await listVersionFiles(directory, noteId)
  return {
    noteId,
    ...entry,
    content,
    preview: previewContent(content),
    versions: versions.map(toVersionSummary),
  }
}

export const ensureStickyNoteWorkspaceDirectory = async (
  workspacePath: string,
  options: StickyNoteStoreOptions = {},
) => {
  const resolved = resolveOptions(options)
  const directory = getStickyNoteWorkspaceDirectory(workspacePath, resolved.dataDir)
  await mkdir(directory, { recursive: true })
  const index = await readIndex(directory, workspacePath)
  if (!(await stat(getIndexPath(directory)).catch(() => null))) {
    await writeIndex(directory, index)
  }
  return directory
}

export const listStickyNotes = async (
  request: Pick<StickyNoteStoreRequest, 'workspacePath'>,
  options: StickyNoteStoreOptions = {},
) => {
  const resolved = resolveOptions(options)
  const directory = getStickyNoteWorkspaceDirectory(request.workspacePath, resolved.dataDir)
  const index = await readIndex(directory, request.workspacePath)
  const notes = (
    await Promise.all(
      Object.entries(index.notes).map(async ([noteId, entry]) => {
        const filePath = path.join(directory, entry.fileName)
        const fileStats = await stat(filePath).catch(() => null)
        if (!fileStats?.isFile()) return null
        const content = (await readFile(filePath, 'utf8')).slice(0, stickyNoteContentLimit)
        return {
          noteId,
          ...entry,
          preview: previewContent(content),
        } satisfies StickyNoteSummary
      }),
    )
  ).filter((note): note is StickyNoteSummary => note !== null)
  notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.noteId.localeCompare(b.noteId))
  return { notes }
}

export const searchStickyNotes = async (
  request: { workspacePath: string; query: string },
  options: StickyNoteStoreOptions = {},
) => {
  const query = request.query.trim().toLocaleLowerCase()
  if (!query) return listStickyNotes({ workspacePath: request.workspacePath }, options)

  const resolved = resolveOptions(options)
  const directory = getStickyNoteWorkspaceDirectory(request.workspacePath, resolved.dataDir)
  const index = await readIndex(directory, request.workspacePath)
  const matches = (
    await Promise.all(
      Object.entries(index.notes).map(async ([noteId, entry]) => {
        const filePath = path.join(directory, entry.fileName)
        const fileStats = await stat(filePath).catch(() => null)
        if (!fileStats?.isFile()) return null
        const content = (await readFile(filePath, 'utf8')).slice(0, stickyNoteContentLimit)
        const normalizedTitle = entry.title.toLocaleLowerCase()
        const normalizedContent = content.toLocaleLowerCase()
        const titleIndex = normalizedTitle.indexOf(query)
        const contentIndex = normalizedContent.indexOf(query)
        if (titleIndex < 0 && contentIndex < 0) return null

        return {
          note: {
            noteId,
            ...entry,
            preview: previewContent(content),
          } satisfies StickyNoteSummary,
          score: titleIndex === 0 ? 0 : titleIndex > 0 ? 1 : 2,
        }
      }),
    )
  ).filter((match): match is { note: StickyNoteSummary; score: number } => match !== null)

  matches.sort((left, right) =>
    left.score - right.score ||
    right.note.updatedAt.localeCompare(left.note.updatedAt) ||
    left.note.noteId.localeCompare(right.note.noteId),
  )
  return { notes: matches.map((match) => match.note) }
}

export const loadStickyNote = async (
  request: StickyNoteStoreRequest,
  options: StickyNoteStoreOptions = {},
) => loadStickyNoteInternal(request.workspacePath, request.noteId, resolveOptions(options))

export const saveStickyNote = async (
  request: StickyNoteSaveRequest,
  options: StickyNoteStoreOptions = {},
) => withWorkspaceQueue(request.workspacePath, async () => {
  const resolved = resolveOptions(options)
  const directory = getStickyNoteWorkspaceDirectory(request.workspacePath, resolved.dataDir)
  await mkdir(directory, { recursive: true })
  const index = await readIndex(directory, request.workspacePath)
  const title = normalizeTitle(request.title)
  const content = request.content.slice(0, stickyNoteContentLimit)
  const now = resolved.now().toISOString()
  const existing = index.notes[request.noteId]
  const fileName = buildFileName(title, request.noteId)
  const targetPath = path.join(directory, fileName)

  if (existing?.fileName && existing.fileName !== fileName) {
    const previousPath = path.join(directory, existing.fileName)
    const previousStats = await stat(previousPath).catch(() => null)
    if (previousStats?.isFile()) {
      await rename(previousPath, targetPath)
    }
  }

  await atomicWrite(targetPath, content)
  index.notes[request.noteId] = {
    title,
    fileName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await writeIndex(directory, index)

  if (request.checkpoint) {
    await addCheckpoint(directory, request.noteId, title, content, resolved)
  }

  return loadStickyNoteInternal(request.workspacePath, request.noteId, resolved)
})

export const loadStickyNoteVersion = async (
  request: StickyNoteVersionRequest,
  options: StickyNoteStoreOptions = {},
) => {
  const resolved = resolveOptions(options)
  const directory = getStickyNoteWorkspaceDirectory(request.workspacePath, resolved.dataDir)
  const version = await readVersionFile(
    path.join(getHistoryDirectory(directory, request.noteId), `${normalizeNoteId(request.versionId)}.json`),
  )
  if (!version) {
    throw new Error(`Sticky note version not found: ${request.versionId}`)
  }
  return version
}

export const restoreStickyNoteVersion = async (
  request: StickyNoteVersionRequest,
  options: StickyNoteStoreOptions = {},
) => withWorkspaceQueue(request.workspacePath, async () => {
  const resolved = resolveOptions(options)
  const directory = getStickyNoteWorkspaceDirectory(request.workspacePath, resolved.dataDir)
  const current = await loadStickyNoteInternal(request.workspacePath, request.noteId, resolved)
  const target = await readVersionFile(
    path.join(getHistoryDirectory(directory, request.noteId), `${normalizeNoteId(request.versionId)}.json`),
  )
  if (!target) {
    throw new Error(`Sticky note version not found: ${request.versionId}`)
  }

  await addCheckpoint(directory, request.noteId, current.title, current.content, resolved)
  const index = await readIndex(directory, request.workspacePath)
  const entry = index.notes[request.noteId]
  if (!entry) {
    throw new Error(`Sticky note not found: ${request.noteId}`)
  }
  const nextTitle = target.title
  const nextFileName = buildFileName(nextTitle, request.noteId)
  const currentPath = path.join(directory, entry.fileName)
  const nextPath = path.join(directory, nextFileName)
  if (currentPath !== nextPath) {
    await rename(currentPath, nextPath)
  }
  await atomicWrite(nextPath, target.content)
  index.notes[request.noteId] = {
    ...entry,
    title: nextTitle,
    fileName: nextFileName,
    updatedAt: resolved.now().toISOString(),
  }
  await writeIndex(directory, index)
  return loadStickyNoteInternal(request.workspacePath, request.noteId, resolved)
})
