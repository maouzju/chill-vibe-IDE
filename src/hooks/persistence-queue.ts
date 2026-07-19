import type { AppState, ChatMessage } from '../../shared/schema'
import type { IdeAction } from '../state'

type TimeoutHandle = ReturnType<typeof setTimeout> | number

type QueuedStateSaveSchedulerOptions = {
  delayMs: number
  queueStateSave: (state: AppState) => void
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimeoutHandle
  clearTimeoutFn?: (handle: TimeoutHandle) => void
}

type QueuedStateSaveScheduleOptions = {
  delayMs?: number
  resetTimer?: boolean
}

export const defaultQueuedStateSaveDelayMs = 300
export const streamingQueuedStateSaveDelayMs = 5_000
// Renderer-facing flush cadence for streaming output. These only batch React
// renders; disk persistence has its own independent streaming throttle below.
// 80ms keeps a single reply feeling like live typing (~12 paints/s) while
// still coalescing per-token deltas. Multi-stream boards back off below so the
// combined card render rate cannot scale linearly with every open agent pane.
export const streamRenderFlushIntervalMs = 80
export const streamRenderColumnYieldMs = 50
export const streamRenderInteractionProtectionMs = 120
export const streamRenderMaxInteractionDeferralMs = 300
const moderateMultiStreamRenderFlushIntervalMs = 200
const busyMultiStreamRenderFlushIntervalMs = 500
const busyStreamingQueuedStateSaveDelayMs = 15_000
const busyStreamingCardThreshold = 2
const streamingStateContentBudgetChars = 750_000
const queuedPersistenceStructuredDataBudgetChars = 4_000

export type StreamDeltaBufferEntry = {
  columnId: string
  cardId: string
  messageId: string
  buffer: string
  model?: string
}

export type StreamActivityBufferEntry = {
  columnId: string
  cardId: string
  messages: ChatMessage[]
}

export const enqueueStreamDeltaBufferEntry = (
  buffer: Map<string, StreamDeltaBufferEntry>,
  entry: StreamDeltaBufferEntry,
) => {
  const existing = buffer.get(entry.messageId)
  if (existing) {
    existing.buffer += entry.buffer
    existing.model = existing.model ?? entry.model
    return
  }

  buffer.set(entry.messageId, { ...entry })
}

export const takeStreamDeltaBufferEntriesForCard = (
  buffer: Map<string, StreamDeltaBufferEntry>,
  cardId: string,
) => {
  const entries: StreamDeltaBufferEntry[] = []
  for (const [messageId, entry] of buffer.entries()) {
    if (entry.cardId !== cardId) {
      continue
    }
    buffer.delete(messageId)
    entries.push(entry)
  }
  return entries
}

export const getPersistenceVersion = (state: Pick<AppState, 'updatedAt'>) =>
  typeof state.updatedAt === 'string' && state.updatedAt.trim().length > 0
    ? state.updatedAt
    : ''

export const hasStreamingCards = (state: Pick<AppState, 'columns'>) =>
  state.columns.some((column) =>
    Object.values(column.cards).some((card) => card.status === 'streaming'),
  )

export const getStreamingCardCount = (state: Pick<AppState, 'columns'>) =>
  state.columns.reduce(
    (count, column) =>
      count + Object.values(column.cards).filter((card) => card.status === 'streaming').length,
    0,
  )

export const getStreamRenderFlushIntervalMs = (activeStreamCount: number) => {
  if (activeStreamCount >= 4) {
    return busyMultiStreamRenderFlushIntervalMs
  }

  if (activeStreamCount >= 2) {
    return moderateMultiStreamRenderFlushIntervalMs
  }

  return streamRenderFlushIntervalMs
}

export const getStreamRenderInteractionDelayMs = ({
  nowMs,
  lastInteractionAtMs,
  firstAttemptAtMs,
}: {
  nowMs: number
  lastInteractionAtMs: number
  firstAttemptAtMs: number
}) => {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(lastInteractionAtMs) ||
    !Number.isFinite(firstAttemptAtMs)
  ) {
    return 0
  }

  const interactionProtectionRemainingMs =
    streamRenderInteractionProtectionMs - Math.max(0, nowMs - lastInteractionAtMs)
  if (interactionProtectionRemainingMs <= 0) {
    return 0
  }

  const deferralBudgetRemainingMs =
    streamRenderMaxInteractionDeferralMs - Math.max(0, nowMs - firstAttemptAtMs)
  if (deferralBudgetRemainingMs <= 0) {
    return 0
  }

  return Math.min(interactionProtectionRemainingMs, deferralBudgetRemainingMs)
}

export const getStreamRenderBufferColumnIds = (
  deltaBuffer: Map<string, StreamDeltaBufferEntry>,
  activityBuffer: Map<string, StreamActivityBufferEntry>,
) => {
  const columnIds = new Set<string>()
  for (const entry of deltaBuffer.values()) {
    columnIds.add(entry.columnId)
  }
  for (const entry of activityBuffer.values()) {
    columnIds.add(entry.columnId)
  }
  return Array.from(columnIds)
}

export const drainStreamRenderBufferActionsForColumn = (
  deltaBuffer: Map<string, StreamDeltaBufferEntry>,
  activityBuffer: Map<string, StreamActivityBufferEntry>,
  columnId: string,
) => {
  const actions: IdeAction[] = []

  for (const [messageId, entry] of deltaBuffer.entries()) {
    if (entry.columnId !== columnId) continue
    deltaBuffer.delete(messageId)
    if (entry.buffer.length === 0) continue
    actions.push({
      type: 'appendAssistantDelta',
      columnId: entry.columnId,
      cardId: entry.cardId,
      messageId: entry.messageId,
      delta: entry.buffer,
      model: entry.model,
    })
  }

  for (const [cardId, entry] of activityBuffer.entries()) {
    if (entry.columnId !== columnId) continue
    activityBuffer.delete(cardId)
    if (entry.messages.length === 0) continue
    actions.push({
      type: 'upsertMessages',
      columnId: entry.columnId,
      cardId: entry.cardId,
      messages: entry.messages,
    })
  }

  return actions
}

export const getLiveChatContentChars = (state: Pick<AppState, 'columns'>) =>
  state.columns.reduce(
    (total, column) =>
      total + Object.values(column.cards).reduce(
        (cardTotal, card) =>
          cardTotal + card.messages.reduce(
            (messageTotal, message) =>
              messageTotal + message.content.length + (message.meta?.structuredData?.length ?? 0),
            0,
          ),
        0,
      ),
    0,
  )

export const isBusyStreamingState = (state: Pick<AppState, 'columns'>) =>
  getStreamingCardCount(state) >= busyStreamingCardThreshold ||
  getLiveChatContentChars(state) >= streamingStateContentBudgetChars

export const getQueuedStateSaveDelayMs = (state: Pick<AppState, 'columns'>) =>
  isBusyStreamingState(state)
    ? busyStreamingQueuedStateSaveDelayMs
    : hasStreamingCards(state)
      ? streamingQueuedStateSaveDelayMs
      : defaultQueuedStateSaveDelayMs

export const shouldResetQueuedStateSaveTimer = (state: Pick<AppState, 'columns'>) =>
  !hasStreamingCards(state) && !isBusyStreamingState(state)

export const shouldPauseQueuedStateSave = (state: Pick<AppState, 'columns'>) => {
  void state
  return false
}

export const shouldUseQueuedPersistenceForAction = (actionType: IdeAction['type']) =>
  actionType === 'appendAssistantDelta' ||
  actionType === 'appendMessages' ||
  actionType === 'upsertMessages' ||
  actionType === 'updateCard' ||
  actionType === 'importExternalSession' ||
  actionType === 'removeSessionHistory'

export const shouldPersistActionImmediately = (
  actionType: IdeAction['type'],
  state: Pick<AppState, 'columns'>,
) => !shouldUseQueuedPersistenceForAction(actionType) &&
  actionType === 'selectCardModel' &&
  shouldPauseQueuedStateSave(state)

const runtimeSyncSettingsKeys = [
  'cliRoutingEnabled',
  'resilientProxyEnabled',
  'resilientProxyStallTimeoutSec',
  'resilientProxyFirstByteTimeoutSec',
  'resilientProxyMaxRetries',
  'providerProfiles',
] as const

export const shouldSyncRuntimeSettings = (action: IdeAction) => {
  if (action.type === 'updateSettings') {
    return runtimeSyncSettingsKeys.some((key) => key in action.patch)
  }

  return action.type === 'updateRequestModels' ||
    action.type === 'upsertProviderProfile' ||
    action.type === 'removeProviderProfile' ||
    action.type === 'setActiveProviderProfile'
}

const trimQueuedPersistenceText = (value: string) =>
  value.length <= queuedPersistenceStructuredDataBudgetChars
    ? value
    : [
        value.slice(0, queuedPersistenceStructuredDataBudgetChars / 2),
        '',
        `[Output truncated in queued state save. ${value.length - queuedPersistenceStructuredDataBudgetChars} characters omitted.]`,
        '',
        value.slice(-queuedPersistenceStructuredDataBudgetChars / 2),
      ].join('\n')

// Payloads without a top-level output/content string (edits files[].patch,
// tool summaries, …) must never fall back to trimming the raw JSON string —
// that produces invalid JSON and the card renders degraded after a restart.
// Trim oversized string leaves in place instead so the payload stays parseable.
const trimQueuedPersistenceJsonStrings = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return trimQueuedPersistenceText(value)
  }

  if (depth >= 6) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => trimQueuedPersistenceJsonStrings(entry, depth + 1))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        trimQueuedPersistenceJsonStrings(entry, depth + 1),
      ]),
    )
  }

  return value
}

const trimQueuedPersistenceStructuredData = (structuredData: string) => {
  if (structuredData.length <= queuedPersistenceStructuredDataBudgetChars) {
    return structuredData
  }

  try {
    const payload = JSON.parse(structuredData) as Record<string, unknown>

    if (typeof payload.output !== 'string' && typeof payload.content !== 'string') {
      return JSON.stringify(trimQueuedPersistenceJsonStrings(payload))
    }

    return JSON.stringify({
      ...payload,
      ...(typeof payload.output === 'string'
        ? { output: trimQueuedPersistenceText(payload.output) }
        : {}),
      ...(typeof payload.content === 'string'
        ? { content: trimQueuedPersistenceText(payload.content) }
        : {}),
    })
  } catch {
    return trimQueuedPersistenceText(structuredData)
  }
}

export const createQueuedPersistenceStateSnapshot = (state: AppState): AppState => ({
  ...state,
  columns: state.columns.map((column) => ({
    ...column,
    cards: Object.fromEntries(
      Object.entries(column.cards).map(([cardId, card]) => [
        cardId,
        {
          ...card,
          messages: card.messages.map((message) => ({
            ...message,
            meta: message.meta?.structuredData
              ? {
                  ...message.meta,
                  structuredData: trimQueuedPersistenceStructuredData(message.meta.structuredData),
                }
              : message.meta,
          })),
        },
      ]),
    ),
  })),
})

export const createQueuedStateSaveScheduler = ({
  delayMs,
  queueStateSave,
  setTimeoutFn = (callback, nextDelayMs) => setTimeout(callback, nextDelayMs),
  clearTimeoutFn = (handle) => clearTimeout(handle),
}: QueuedStateSaveSchedulerOptions) => {
  let pendingState: AppState | null = null
  let timeoutHandle: TimeoutHandle | null = null

  const clearPendingTimer = () => {
    if (timeoutHandle === null) {
      return
    }

    clearTimeoutFn(timeoutHandle)
    timeoutHandle = null
  }

  const flush = () => {
    clearPendingTimer()

    if (!pendingState) {
      return false
    }

    const state = pendingState
    pendingState = null
    queueStateSave(state)
    return true
  }

  return {
    schedule(state: AppState, options?: QueuedStateSaveScheduleOptions) {
      pendingState = state
      if (timeoutHandle !== null && options?.resetTimer === false) {
        return
      }

      clearPendingTimer()
      timeoutHandle = setTimeoutFn(() => {
        void flush()
      }, options?.delayMs ?? delayMs)
    },
    flush,
    cancel() {
      pendingState = null
      clearPendingTimer()
    },
    hasPending() {
      return pendingState !== null
    },
  }
}
