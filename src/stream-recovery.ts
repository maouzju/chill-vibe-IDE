import { getChatMessageAttachments } from '../shared/chat-attachments.js'
import type {
  ChatMessage,
  ImageAttachment,
  StreamActivity,
  StreamErrorEvent,
  StreamErrorRecoveryMode,
} from '../shared/schema.js'

const transientRecoveryPlaceholderPattern = /^reconnecting(?:\s*(?:\.{3}|\u2026))?(?:\s+\d+\s*\/\s*\d+)?$/i
const transientRecoveryPlaceholderSequencePattern =
  /^(?:reconnecting(?:\s*(?:\.{3}|\u2026))?(?:\s+\d+\s*\/\s*\d+)?\s*)+$/i
// 症状：中转连续吐空 200，CLI 每次都把 `API Error: …` 当 assistant 文本打出来；
// 2026-09-03 实测一张卡攒了 45 条，既让重试预算每次归零，又在 fresh-session
// 续传时把 6000 字符的重放预算吃光、原始需求整条被省略，模型只拿到"请继续"
// 就去翻工作目录捡别的会话的活干。错误回显不是进展，按占位符同等对待。
const providerErrorEchoPattern = /^API Error:/i

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

export const getRecoverableStreamErrorSessionId = (
  error: Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode' | 'sessionId'>,
) => {
  if (error.recoverable !== true || error.recoveryMode !== 'resume-session') {
    return null
  }

  const sessionId = error.sessionId?.trim()
  return sessionId && sessionId.length > 0 ? sessionId : null
}

const defaultRecoverableStreamRetryLimit = 6

export const getRecoverableStreamRetryLimit = (configuredMaxRetries?: number) => {
  if (configuredMaxRetries === -1) {
    return Number.POSITIVE_INFINITY
  }

  if (
    typeof configuredMaxRetries === 'number' &&
    Number.isInteger(configuredMaxRetries) &&
    configuredMaxRetries >= 0 &&
    configuredMaxRetries <= 50
  ) {
    return configuredMaxRetries
  }

  return defaultRecoverableStreamRetryLimit
}

export const shouldResetStreamRecoveryAttemptsForText = (content: string) => {
  const normalized = content.trim()

  if (!normalized) {
    return false
  }

  return !(
    transientRecoveryPlaceholderPattern.test(normalized) ||
    transientRecoveryPlaceholderSequencePattern.test(normalized) ||
    providerErrorEchoPattern.test(normalized)
  )
}

export const shouldResetStreamRecoveryAttemptsForActivity = (
  source: 'session' | 'log' | 'activity' | 'assistant_message',
  activityKind?: StreamActivity['kind'],
) =>
  source === 'assistant_message' ||
  (source === 'activity' && activityKind !== 'reasoning')

export type StreamRecoveryCheckpointTurn = {
  message: ChatMessage
  prompt: string
  attachments: ImageAttachment[]
}

export const resolveStreamRecoveryCheckpointTurn = ({
  messages,
  streamId,
}: {
  messages: ChatMessage[]
  streamId?: string
}): StreamRecoveryCheckpointTurn | null => {
  const userMessageIndex = messages.findLastIndex((message) => message.role === 'user')
  if (userMessageIndex < 0) {
    return null
  }

  const message = messages[userMessageIndex]!
  const attachments = getChatMessageAttachments(message)
  if (!message.content.trim() && attachments.length === 0) {
    // Empty continuation sends intentionally have no new visible user turn.
    // Never roll back to and replay an older prompt by guessing.
    return null
  }

  const trailingMessages = messages.slice(userMessageIndex + 1)
  if (
    trailingMessages.length > 0 &&
    (
      !streamId ||
      trailingMessages.some(
        (trailing) =>
          trailing.role === 'user' || trailing.meta?.streamId !== streamId,
      )
    )
  ) {
    // The visible user message belongs to an older completed turn unless every
    // later message is provably owned by the stream currently being recovered.
    return null
  }

  return {
    message,
    prompt: message.content,
    attachments,
  }
}

export const shouldFallbackToFreshSessionAfterResumeLoop = ({
  recoverable,
  recoveryMode,
  hasSessionId,
  resumeAttempt,
  maxResumeAttempts,
}: {
  recoverable?: boolean
  recoveryMode?: StreamErrorRecoveryMode
  hasSessionId: boolean
  resumeAttempt: number
  maxResumeAttempts: number
}) =>
  recoverable === true &&
  recoveryMode === 'resume-session' &&
  hasSessionId &&
  resumeAttempt >= maxResumeAttempts

export const shouldKeepRecoveringResumeWithFreshSession = ({
  recoverable,
  recoveryMode,
  hasSessionId,
  resumeAttempt,
  maxResumeAttempts,
}: {
  recoverable?: boolean
  recoveryMode?: StreamErrorRecoveryMode
  hasSessionId: boolean
  resumeAttempt: number
  maxResumeAttempts: number
}) =>
  recoverable === true &&
  recoveryMode === 'resume-session' &&
  (
    !hasSessionId ||
    shouldFallbackToFreshSessionAfterResumeLoop({
      recoverable,
      recoveryMode,
      hasSessionId,
      resumeAttempt,
      maxResumeAttempts,
    })
  )

export const shouldFallbackToFreshSessionAfterTransientResumeLoop = ({
  recoverable,
  recoveryMode,
  transientOnly,
  hasSessionId,
  transientResumeAttempt,
  maxTransientResumeAttempts,
}: {
  recoverable?: boolean
  recoveryMode?: StreamErrorRecoveryMode
  transientOnly?: boolean
  hasSessionId: boolean
  transientResumeAttempt: number
  maxTransientResumeAttempts: number
}) =>
  transientOnly === true &&
  shouldFallbackToFreshSessionAfterResumeLoop({
    recoverable,
    recoveryMode,
    hasSessionId,
    resumeAttempt: transientResumeAttempt,
    maxResumeAttempts: maxTransientResumeAttempts,
  })

export const shouldKeepRecoveringTransientResumeWithFreshSession = ({
  recoverable,
  recoveryMode,
  transientOnly,
  hasSessionId,
  transientResumeAttempt,
  maxTransientResumeAttempts,
}: {
  recoverable?: boolean
  recoveryMode?: StreamErrorRecoveryMode
  transientOnly?: boolean
  hasSessionId: boolean
  transientResumeAttempt: number
  maxTransientResumeAttempts: number
}) =>
  transientOnly === true &&
  shouldKeepRecoveringResumeWithFreshSession({
    recoverable,
    recoveryMode,
    hasSessionId,
    resumeAttempt: transientResumeAttempt,
    maxResumeAttempts: maxTransientResumeAttempts,
  })
