import type {
  AppState,
  InternalSessionHistoryLoadRequest,
  InternalSessionHistoryLoadResponse,
  SessionHistoryEntry,
} from '../shared/schema'

type RestoreState = Pick<AppState, 'sessionHistory'>

type ResolveSessionHistoryEntryOptions = {
  entryId: string
  state: RestoreState
  loadEntry: (request: InternalSessionHistoryLoadRequest) => Promise<InternalSessionHistoryLoadResponse>
}

const isCompleteSessionHistoryEntry = (entry: SessionHistoryEntry) => {
  const expectedMessageCount = Math.max(
    typeof entry.messageCount === 'number' ? entry.messageCount : 0,
    entry.messages.length,
  )

  return !entry.messagesPreview && entry.messages.length >= expectedMessageCount
}

export const resolveSessionHistoryEntryForRestore = async ({
  entryId,
  state,
  loadEntry,
}: ResolveSessionHistoryEntryOptions): Promise<SessionHistoryEntry> => {
  const localEntry = state.sessionHistory.find((entry) => entry.id === entryId)

  if (localEntry && isCompleteSessionHistoryEntry(localEntry)) {
    return localEntry
  }

  const response = await loadEntry({ entryId })
  return response.entry
}
