import type { AppState } from '../../shared/schema'
import type { IdeAction } from '../state'

type TimeoutHandle = ReturnType<typeof setTimeout> | number

type QueuedStateSaveSchedulerOptions = {
  delayMs: number
  queueStateSave: (state: AppState) => void
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimeoutHandle
  clearTimeoutFn?: (handle: TimeoutHandle) => void
}

export const getPersistenceVersion = (state: Pick<AppState, 'updatedAt'>) =>
  typeof state.updatedAt === 'string' && state.updatedAt.trim().length > 0
    ? state.updatedAt
    : ''

export const shouldPauseQueuedStateSave = (state: Pick<AppState, 'columns'>) =>
  state.columns.some((column) =>
    Object.values(column.cards).some((card) => card.status === 'streaming'),
  )

export const shouldPersistActionImmediately = (
  actionType: IdeAction['type'],
  state: Pick<AppState, 'columns'>,
) => actionType === 'selectCardModel' && shouldPauseQueuedStateSave(state)

const runtimeSyncSettingsKeys = ['cliRoutingEnabled', 'resilientProxyEnabled', 'providerProfiles'] as const

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
    schedule(state: AppState) {
      pendingState = state
      clearPendingTimer()
      timeoutHandle = setTimeoutFn(() => {
        void flush()
      }, delayMs)
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
