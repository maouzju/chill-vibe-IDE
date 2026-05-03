import type { AppState } from '../../shared/schema'
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
export const streamDeltaFlushIntervalMs = 1_000
const busyStreamingQueuedStateSaveDelayMs = 15_000
const busyStreamingCardThreshold = 2
const streamingStateContentBudgetChars = 750_000
const queuedPersistenceStructuredDataBudgetChars = 4_000

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
  actionType === 'updateCard'

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

  return action.type === 'upsertProviderProfile' ||
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

const trimQueuedPersistenceStructuredData = (structuredData: string) => {
  if (structuredData.length <= queuedPersistenceStructuredDataBudgetChars) {
    return structuredData
  }

  try {
    const payload = JSON.parse(structuredData) as Record<string, unknown>

    if (typeof payload.output !== 'string' && typeof payload.content !== 'string') {
      return trimQueuedPersistenceText(structuredData)
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
