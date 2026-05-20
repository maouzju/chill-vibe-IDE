import type { AppLanguage, ExternalSessionSummary, Provider, SessionHistoryEntry } from '../../shared/schema'

const normalizeHistorySearchQuery = (value: string) => value.trim().toLocaleLowerCase()

const providerSearchLabel = (provider: Provider) => (provider === 'claude' ? 'claude' : 'codex')

type SessionHistoryLifecycle = 'ended' | 'interrupted'

export const getSessionHistoryLifecycle = (entry: SessionHistoryEntry): SessionHistoryLifecycle => {
  const lastMessage = entry.messages.at(-1)
  if (
    lastMessage?.meta?.kind === 'run-stopped' &&
    ['manual', 'user-interrupt'].includes(lastMessage.meta.stopReason ?? '')
  ) {
    return 'interrupted'
  }

  return 'ended'
}

export const getSessionHistoryLifecycleLabel = (
  entry: SessionHistoryEntry,
  language: AppLanguage,
) => {
  const lifecycle = getSessionHistoryLifecycle(entry)

  if (language === 'en') {
    return lifecycle === 'interrupted' ? 'Interrupted' : 'Ended'
  }

  return lifecycle === 'interrupted' ? '中断' : '已结束'
}

const createInternalHistorySearchText = (entry: SessionHistoryEntry) =>
  [
    entry.title,
    entry.sessionId ?? '',
    providerSearchLabel(entry.provider),
    entry.model,
    entry.workspacePath,
    getSessionHistoryLifecycleLabel(entry, 'en'),
    getSessionHistoryLifecycleLabel(entry, 'zh-CN'),
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
