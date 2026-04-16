import type { StreamErrorEvent, StreamErrorRecoveryMode } from '../shared/schema.js'

const transientRecoveryPlaceholderPattern = /^reconnecting(?:\s*(?:\.{3}|…))?(?:\s+\d+\s*\/\s*\d+)?$/i

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

export const shouldResetStreamRecoveryAttemptsForText = (content: string) => {
  const normalized = content.trim()

  if (!normalized) {
    return false
  }

  return !transientRecoveryPlaceholderPattern.test(normalized)
}

export const shouldResetStreamRecoveryAttemptsForActivity = (
  source: 'session' | 'log' | 'activity' | 'assistant_message',
) => source === 'activity' || source === 'assistant_message'
