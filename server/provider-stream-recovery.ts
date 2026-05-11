import type { ChatRequest, StreamErrorEvent, StreamErrorHint } from '../shared/schema.js'

const recoverableErrorPatterns = [
  'ended without emitting a terminal completion event',
  'closed before completion',
  'stream closed before',
  'unexpected completion',
  'selected model is at capacity',
  'model is at capacity',
] as const

const zeroExitPattern = /\b(?:codex|claude) exited with status code:\s*0\b/i

const recoverableSwitchConfigErrorPatterns = [
  'third-party apps now draw from your extra usage',
  'claim it at',
  'settings/usage',
  'keep going',
] as const

const isRecoverableSwitchConfigError = (normalizedMessage: string) =>
  recoverableSwitchConfigErrorPatterns.every((pattern) => normalizedMessage.includes(pattern))

export const classifyProviderStreamErrorRecovery = (
  request: Pick<ChatRequest, 'sessionId'>,
  message: string,
  hint?: StreamErrorHint,
): Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode'> => {
  if (!request.sessionId?.trim()) {
    return {}
  }

  const normalizedMessage = message.trim().toLowerCase()
  if (!normalizedMessage) {
    return {}
  }

  const switchConfigRecoverable = isRecoverableSwitchConfigError(normalizedMessage)

  if (hint === 'env-setup' || (hint === 'switch-config' && !switchConfigRecoverable)) {
    return {}
  }

  if (
    switchConfigRecoverable ||
    recoverableErrorPatterns.some((pattern) => normalizedMessage.includes(pattern)) ||
    zeroExitPattern.test(normalizedMessage)
  ) {
    return {
      recoverable: true,
      recoveryMode: 'resume-session',
    }
  }

  return {}
}
