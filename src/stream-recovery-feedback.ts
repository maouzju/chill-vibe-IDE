export type CardRecoveryStatus =
  | { kind: 'reconnecting'; attempt: number; max: number }
  | { kind: 'resumed' }
  | { kind: 'failed' }

export const computeRecoveryStatusAfterRetryScheduled = (
  currentAttempt: number,
  max: number,
): CardRecoveryStatus => ({ kind: 'reconnecting', attempt: currentAttempt + 1, max })

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
