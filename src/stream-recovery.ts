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

// 中转/网关层的瞬时故障：HTTP 层就坏了（HTML 错误页、5xx、429、建连失败、断 socket），
// 与会话内容无关。停滞看门狗、Reconnecting 占位这类**不在**这里——那些可能是 Codex
// 毒化的会话尖端，吐完半截输出照样死。
const sessionIndependentUpstreamFailurePatterns = [
  'empty or malformed response',
  'last_content_type=none',
  'server-side issue, usually temporary',
  'repeated 529 overloaded',
  'api is at capacity',
  'model is at capacity',
  'is experiencing high load',
  'our servers are currently overloaded',
  'no accounts are currently available',
  'request rejected (429)',
  '上游已负载',
  'unable to connect to api',
  'connection refused',
  'econnrefused',
  'socket connection was closed',
  'connection closed mid-response',
] as const

export const isSessionIndependentUpstreamFailure = (message: string) => {
  const normalized = message.trim().toLowerCase()
  return sessionIndependentUpstreamFailurePatterns.some((pattern) => normalized.includes(pattern))
}

// 症状：长任务里中转偶发吐 HTML 空 200，续上后跑了一堆命令又抽一次，卡片就回滚到本轮
//   用户消息重发（fork 失败时更糟：seeded 冷启动），模型说「之前的摸底记录被截断了」。
// 根因：2026-09-29 截图 + 回归钉死。失败续传计数只在整轮 done 时清零，两次互不相干的
//   中转抽风（中间有真实工具进展）也凑满 maxResumeSessionLoopAttempts=2 触发逃生舱。
// 被否决：不在任意进展后清零——Codex 毒化尖端会先吐半截输出再停滞（stream-recovery-feedback
//   design），那样会无限续传；只对与会话无关的传输类故障、且确有进展时重开计数。
export const resolveNextFailedResumeSessionAttempt = ({
  previousAttempt,
  madeMeaningfulProgress,
  message,
}: {
  previousAttempt: number
  madeMeaningfulProgress: boolean
  message: string
}) =>
  madeMeaningfulProgress && isSessionIndependentUpstreamFailure(message) ? 1 : previousAttempt + 1

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
