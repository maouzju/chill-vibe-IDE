import type { StreamErrorEvent, StreamErrorRecoveryMode } from '../shared/schema.js'

export const resolveStreamRecoveryMode = (
  error: Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode'>,
  hasSessionId: boolean,
): StreamErrorRecoveryMode | null => {
  if (!error.recoverable) {
    return null
  }

  if (error.recoveryMode === 'resume-session') {
    return hasSessionId ? 'resume-session' : 'reattach-stream'
  }

  return 'reattach-stream'
}
