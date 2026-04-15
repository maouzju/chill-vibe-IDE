type TimeoutHandle = ReturnType<typeof setTimeout> | number

type DraftSyncSchedulerOptions = {
  idleMs?: number
  onSync: (draft: string) => void
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimeoutHandle
  clearTimeoutFn?: (handle: TimeoutHandle) => void
}

export const draftSyncIdleMs = 3_000

export const createDraftSyncScheduler = ({
  idleMs = draftSyncIdleMs,
  onSync,
  setTimeoutFn = (callback, nextDelayMs) => setTimeout(callback, nextDelayMs),
  clearTimeoutFn = (handle) => clearTimeout(handle),
}: DraftSyncSchedulerOptions) => {
  let pendingDraft: string | null = null
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

    if (pendingDraft === null) {
      return false
    }

    const draft = pendingDraft
    pendingDraft = null
    onSync(draft)
    return true
  }

  return {
    schedule(draft: string) {
      pendingDraft = draft
      clearPendingTimer()
      if (idleMs <= 0) {
        return
      }
      timeoutHandle = setTimeoutFn(() => {
        void flush()
      }, idleMs)
    },
    markPending(draft: string) {
      pendingDraft = draft
      clearPendingTimer()
    },
    flush,
    cancel() {
      pendingDraft = null
      clearPendingTimer()
    },
    hasPending() {
      return pendingDraft !== null
    },
  }
}
