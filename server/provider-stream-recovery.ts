import type { ChatRequest, StreamErrorEvent, StreamErrorHint } from '../shared/schema.js'

const recoverableErrorPatterns = [
  'ended without emitting a terminal completion event',
  'closed before completion',
  'stream closed before',
  'unexpected completion',
] as const

export const classifyProviderStreamErrorRecovery = (
  request: Pick<ChatRequest, 'sessionId'>,
  message: string,
  hint?: StreamErrorHint,
): Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode'> => {
  if (!request.sessionId?.trim()) {
    return {}
  }

  if (hint === 'switch-config' || hint === 'env-setup') {
    return {}
  }

  const normalizedMessage = message.trim().toLowerCase()
  if (!normalizedMessage) {
    return {}
  }

  if (recoverableErrorPatterns.some((pattern) => normalizedMessage.includes(pattern))) {
    return {
      recoverable: true,
      recoveryMode: 'resume-session',
    }
  }

  return {}
}
