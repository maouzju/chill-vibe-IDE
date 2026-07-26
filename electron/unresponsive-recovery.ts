const defaultUnresponsiveRecoveryDelayMs = 8_000

export const resolveUnresponsiveRecoveryDelayMs = (value: string | undefined) => {
  if (value === undefined || !value.trim()) {
    return defaultUnresponsiveRecoveryDelayMs
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultUnresponsiveRecoveryDelayMs
  }

  return Math.floor(parsed)
}

export type UnresponsiveRecoveryEvent = {
  startedAtMs: number
  recoveredAtMs: number
  durationMs: number
}

export const createUnresponsiveRecoveryController = <TimerHandle = ReturnType<typeof setTimeout>>(
  options: {
    delayMs: number
    now?: () => number
    setTimer?: (callback: () => void, delayMs: number) => TimerHandle
    clearTimer?: (timer: TimerHandle) => void
    onRecover: (event: UnresponsiveRecoveryEvent) => void
  },
) => {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TimerHandle)
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let timer: TimerHandle | null = null
  let startedAtMs: number | null = null

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    startedAtMs = null
  }

  return {
    markUnresponsive() {
      if (options.delayMs <= 0 || timer !== null) {
        return
      }

      startedAtMs = now()
      timer = setTimer(() => {
        timer = null
        const recoveredAtMs = now()
        const recoveryStartedAtMs = startedAtMs ?? recoveredAtMs
        startedAtMs = null
        options.onRecover({
          startedAtMs: recoveryStartedAtMs,
          recoveredAtMs,
          durationMs: Math.max(0, recoveredAtMs - recoveryStartedAtMs),
        })
      }, options.delayMs)
    },
    markResponsive: cancel,
    dispose: cancel,
    isArmed() {
      return timer !== null
    },
  }
}
