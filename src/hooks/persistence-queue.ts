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
export const streamDeltaFlushIntervalMs = 250

export const getPersistenceVersion = (state: Pick<AppState, 'updatedAt'>) =>
  typeof state.updatedAt === 'string' && state.updatedAt.trim().length > 0
    ? state.updatedAt
    : ''

export const hasStreamingCards = (state: Pick<AppState, 'columns'>) =>
  state.columns.some((column) =>
    Object.values(column.cards).some((card) => card.status === 'streaming'),
  )

export const getQueuedStateSaveDelayMs = (state: Pick<AppState, 'columns'>) =>
  hasStreamingCards(state) ? streamingQueuedStateSaveDelayMs : defaultQueuedStateSaveDelayMs

export const shouldResetQueuedStateSaveTimer = (state: Pick<AppState, 'columns'>) =>
  !hasStreamingCards(state)

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
