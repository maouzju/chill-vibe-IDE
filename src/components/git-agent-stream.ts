import type { ChatStreamSource } from '../api'

type MutableRef<T> = {
  current: T
}

export const getGitAgentAnalysisTimeouts = (changeCount: number) => ({
  firstByteTimeoutMs: Math.min(300_000, Math.max(90_000, changeCount * 2_000)),
  stallTimeoutMs: Math.min(180_000, Math.max(45_000, changeCount * 1_000)),
})

export const refreshGitAgentAnalysisTimeout = ({
  timeoutRef,
  doneRef,
  timeoutMs,
  onTimeout,
}: {
  timeoutRef: MutableRef<ReturnType<typeof setTimeout> | null>
  doneRef: MutableRef<boolean>
  timeoutMs: number
  onTimeout: () => void
}) => {
  if (doneRef.current) {
    return
  }

  if (timeoutRef.current) {
    clearTimeout(timeoutRef.current)
    timeoutRef.current = null
  }

  timeoutRef.current = setTimeout(() => {
    timeoutRef.current = null

    if (doneRef.current) {
      return
    }

    onTimeout()
  }, timeoutMs)
}

export const settleGitAgentAnalysisStream = ({
  streamSourceRef,
  timeoutRef,
  doneRef,
}: {
  streamSourceRef: MutableRef<ChatStreamSource | null>
  timeoutRef: MutableRef<ReturnType<typeof setTimeout> | null>
  doneRef: MutableRef<boolean>
}) => {
  doneRef.current = true

  if (timeoutRef.current) {
    clearTimeout(timeoutRef.current)
    timeoutRef.current = null
  }

  streamSourceRef.current?.close()
  streamSourceRef.current = null
}
