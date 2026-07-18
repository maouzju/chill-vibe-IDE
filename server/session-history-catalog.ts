import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Provider, SessionHistoryEntry } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'

const historyDirectoryName = 'session-history'
const hiddenFileName = 'catalog-hidden.json'
const maxResults = 100

type HiddenCatalog = { entryIds: string[]; sessionKeys: string[] }

const normalizePath = (value: string) => path.resolve(value).toLocaleLowerCase()
const sessionKey = (provider: Provider, sessionId: string | undefined) =>
  sessionId?.trim() ? `${provider}:${sessionId.trim()}` : ''

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
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

export const resetSessionHistoryCatalogCacheForTests = () => {
  // The initial implementation intentionally scans on demand. Keep this hook so
  // callers do not depend on whether a lightweight catalog cache is enabled.
}

export const searchInternalSessionHistory = async (options: {
  workspacePath: string
  query: string
}): Promise<{ entries: SessionHistoryEntry[]; total: number }> => {
  const query = options.query.trim().toLocaleLowerCase()
  if (!query) return { entries: [], total: 0 }

  const directory = path.join(getAppDataDir(), historyDirectoryName)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return { entries: [], total: 0 }
  }
  const hidden = await readHiddenCatalog(directory)
  const hiddenIds = new Set(hidden.entryIds)
  const hiddenSessions = new Set(hidden.sessionKeys)
  const candidates: SessionHistoryEntry[] = []

  for (const name of names) {
    if (!name.endsWith('.json') || name === hiddenFileName) continue
    try {
      const entry = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as SessionHistoryEntry
      const key = sessionKey(entry.provider, entry.sessionId)
      if (
        !entry?.id ||
        normalizePath(entry.workspacePath) !== normalizePath(options.workspacePath) ||
        hiddenIds.has(entry.id) ||
        (key && hiddenSessions.has(key))
      ) continue
      const searchText = [
        entry.title,
        entry.sessionId ?? '',
        entry.provider,
        entry.model,
        entry.workspacePath,
        ...entry.messages.map((message) => message.content),
      ].join('\n').toLocaleLowerCase()
      if (searchText.includes(query)) candidates.push(entry)
    } catch {
      // A damaged sidecar must not make the whole history search unavailable.
    }
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
  const directory = path.join(getAppDataDir(), historyDirectoryName)
  const hidden = await readHiddenCatalog(directory)
  hidden.entryIds = [...new Set([...hidden.entryIds, options.entryId])]
  const key = sessionKey(options.provider, options.sessionId)
  if (key) hidden.sessionKeys = [...new Set([...hidden.sessionKeys, key])]
  await writeHiddenCatalog(directory, hidden)
}
