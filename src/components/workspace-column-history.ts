import type { ExternalSessionSummary, Provider, SessionHistoryEntry } from '../../shared/schema'

const normalizeHistorySearchQuery = (value: string) => value.trim().toLocaleLowerCase()

const providerSearchLabel = (provider: Provider) => (provider === 'claude' ? 'claude' : 'codex')

const createInternalHistorySearchText = (entry: SessionHistoryEntry) =>
  [
    entry.title,
    entry.sessionId ?? '',
    providerSearchLabel(entry.provider),
    entry.model,
    entry.workspacePath,
    ...entry.messages.map((message) => message.content),
  ]
    .join('\n')
    .toLocaleLowerCase()

const createExternalHistorySearchText = (entry: ExternalSessionSummary) =>
  [entry.title, providerSearchLabel(entry.provider), entry.model, entry.workspacePath].join('\n').toLocaleLowerCase()

export const filterSessionHistoryEntries = (entries: SessionHistoryEntry[], query: string) => {
  const normalizedQuery = normalizeHistorySearchQuery(query)
  if (!normalizedQuery) {
    return entries
  }

  return entries.filter((entry) => createInternalHistorySearchText(entry).includes(normalizedQuery))
}

export const filterExternalSessionHistory = (entries: ExternalSessionSummary[], query: string) => {
  const normalizedQuery = normalizeHistorySearchQuery(query)
  if (!normalizedQuery) {
    return entries
  }

  return entries.filter((entry) => createExternalHistorySearchText(entry).includes(normalizedQuery))
}

export const hasSessionHistorySearch = (query: string) => normalizeHistorySearchQuery(query).length > 0
