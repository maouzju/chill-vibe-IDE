export type LocalRecoveryStatsEvent = 'request' | 'disconnect' | 'recovery_success' | 'recovery_fail'

export type LocalRecoveryStatsState = {
  hadRecoverableDisconnect: boolean
}

export const beginLocalRecoveryStatsRun = (): {
  state: LocalRecoveryStatsState
  events: LocalRecoveryStatsEvent[]
} => ({
  state: { hadRecoverableDisconnect: false },
  events: ['request'],
})



export const beginOrContinueLocalRecoveryStatsRun = (
  state: LocalRecoveryStatsState | undefined,
): {
  state: LocalRecoveryStatsState
  events: LocalRecoveryStatsEvent[]
} => (state ? { state, events: [] } : beginLocalRecoveryStatsRun())


export const noteLocalRecoveryDisconnect = (
  state: LocalRecoveryStatsState | undefined,
): {
  state: LocalRecoveryStatsState
  events: LocalRecoveryStatsEvent[]
} => ({
  state: {
    hadRecoverableDisconnect: true,
  },
  events: state?.hadRecoverableDisconnect ? [] : ['disconnect'],
})

export const continueLocalRecoveryStatsRun = (
  state: LocalRecoveryStatsState | undefined,
): {
  state: LocalRecoveryStatsState | undefined
  events: LocalRecoveryStatsEvent[]
} => ({
  state,
  events: [],
})

export const settleLocalRecoveryStatsRun = (
  state: LocalRecoveryStatsState | undefined,
  outcome: 'success' | 'failure' | 'abandoned',
): {
  state: undefined
  events: LocalRecoveryStatsEvent[]
} => {
  if (!state?.hadRecoverableDisconnect) {
    return { state: undefined, events: [] }
  }

  if (outcome === 'success') {
    return { state: undefined, events: ['recovery_success'] }
  }

  if (outcome === 'failure') {
    return { state: undefined, events: ['recovery_fail'] }
  }

  return { state: undefined, events: [] }
}
