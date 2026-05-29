import type { InterruptedSessionEntry, ImageAttachment } from './schema.js'

type InterruptedSessionResumeSource = Pick<
  InterruptedSessionEntry,
  'sessionId' | 'sessionModel' | 'resumeMode' | 'resumePrompt' | 'resumeAttachments'
>

type InterruptedSessionResumeRequest = {
  sessionId?: string
  prompt: string
  attachments: ImageAttachment[]
}

const normalizeSessionId = (sessionId?: string) => {
  const trimmed = sessionId?.trim()
  return trimmed ? trimmed : undefined
}

export const hasInterruptedSessionRetryPayload = (
  entry: Pick<InterruptedSessionResumeSource, 'resumeMode' | 'resumePrompt' | 'resumeAttachments'>,
) =>
  entry.resumeMode === 'retry-last-user-message' &&
  (entry.resumePrompt.trim().length > 0 || entry.resumeAttachments.length > 0)

export const isInterruptedSessionRecoverable = (entry: InterruptedSessionResumeSource) =>
  Boolean(normalizeSessionId(entry.sessionId)) || hasInterruptedSessionRetryPayload(entry)

export const getInterruptedSessionResumeRequest = (
  entry: InterruptedSessionResumeSource,
  requestedModel?: string,
): InterruptedSessionResumeRequest | null => {
  const sessionId = normalizeSessionId(entry.sessionId)
  const sessionModel = entry.sessionModel?.trim()
  const model = requestedModel?.trim()
  if (sessionId && (!model || (sessionModel && sessionModel === model))) {
    return {
      sessionId,
      prompt: '',
      attachments: [],
    }
  }

  if (!hasInterruptedSessionRetryPayload(entry)) {
    return null
  }

  return {
    sessionId: undefined,
    prompt: entry.resumePrompt,
    attachments: entry.resumeAttachments,
  }
}
