export type CardRecoveryStatus =
  | { kind: 'reconnecting'; attempt: number; max: number | 'unlimited' }
  | { kind: 'resumed' }
  | { kind: 'failed' }

export const computeRecoveryStatusAfterRetryScheduled = (
  currentAttempt: number,
  max: number,
): CardRecoveryStatus => ({
  kind: 'reconnecting',
  attempt: currentAttempt + 1,
  max: Number.isFinite(max) ? max : 'unlimited',
})

export const computeRecoveryStatusAfterSuccess = (
  previous: CardRecoveryStatus | undefined,
): CardRecoveryStatus | undefined => {
  if (!previous) return undefined
  if (previous.kind === 'reconnecting') return { kind: 'resumed' }
  // resumed / failed are terminal for the success path: resumed persists until the
  // clear timer fires; failed must not be silently revived by a late reset signal.
  return previous
}

export const computeRecoveryStatusAfterFinalFailure = (): CardRecoveryStatus => ({
  kind: 'failed',
})

export const shouldClearRecoveryStatusOnStreamIdle = (
  previous: CardRecoveryStatus | undefined,
): boolean => previous?.kind !== 'failed'


const transientRecoveryPlaceholderPattern = /^reconnecting(?:\s*(?:\.{3}|\u2026))?(?:\s+\d+\s*\/\s*\d+)?$/i

const isTransientRecoveryPlaceholder = (content: string) =>
  transientRecoveryPlaceholderPattern.test(content.trim())

export const shouldShowManualStreamRecoveryControl = ({
  cardStatus,
  recoveryStatus,
  latestAssistantContent,
}: {
  cardStatus: 'idle' | 'streaming' | 'error'
  recoveryStatus?: CardRecoveryStatus
  latestAssistantContent?: string
}) => {
  if (recoveryStatus?.kind === 'failed') {
    return true
  }

  if (cardStatus !== 'streaming') {
    return false
  }

  return (
    recoveryStatus?.kind === 'reconnecting' ||
    (latestAssistantContent ? isTransientRecoveryPlaceholder(latestAssistantContent) : false)
  )
}
