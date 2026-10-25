import type { ChatMessage, InterruptedSessionEntry, ImageAttachment, Provider } from './schema.js'

type InterruptedSessionResumeSource = Pick<
  InterruptedSessionEntry,
  'sessionId' | 'sessionModel' | 'resumeMode' | 'resumePrompt' | 'resumeAttachments'
> & Partial<Pick<InterruptedSessionEntry, 'provider' | 'interruptedAgents'>>

export type InterruptedAgent = InterruptedSessionEntry['interruptedAgents'][number]

const isRunningAgentStatus = (status: unknown) => status === 'running' || status === 'pendingInit'

const readOptionalString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

// 只看转录里最新一张 status 快照：与渲染端 selectDockedAgentStatus 同口径（最新快照即真相）。
export const collectInterruptedAgents = (messages: ChatMessage[]): InterruptedAgent[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.meta?.kind !== 'agents' || !message.meta.structuredData) continue
    let payload: { view?: unknown; agents?: unknown }
    try {
      payload = JSON.parse(message.meta.structuredData) as typeof payload
    } catch {
      continue
    }
    if (payload.view !== 'status') continue
    if (!Array.isArray(payload.agents)) return []
    return payload.agents.flatMap((raw): InterruptedAgent[] => {
      if (!raw || typeof raw !== 'object') return []
      const agent = raw as Record<string, unknown>
      const threadId = readOptionalString(agent.threadId)
      if (!threadId || !isRunningAgentStatus(agent.status)) return []
      const nickname = readOptionalString(agent.nickname)
      const role = readOptionalString(agent.role)
      const model = readOptionalString(agent.model)
      const lastMessage = readOptionalString(agent.message)
      return [{
        threadId,
        ...(nickname ? { nickname } : {}),
        ...(role ? { role } : {}),
        ...(model ? { model } : {}),
        ...(lastMessage ? { message: lastMessage.slice(0, 400) } : {}),
      }]
    })
  }
  return []
}

const describeAgent = (agent: InterruptedAgent) => {
  const label = [agent.nickname, agent.role].filter(Boolean).join(' / ')
  const parts = [`- id: ${agent.threadId}`]
  if (label) parts.push(`name: ${label}`)
  if (agent.model) parts.push(`model: ${agent.model}`)
  if (agent.message) parts.push(`last status: ${agent.message.replace(/\s+/g, ' ')}`)
  return parts.join(' | ')
}

const resumeInstructionByProvider = (provider: Provider | undefined) => {
  if (provider === 'codex') {
    return 'For each one, call resume_agent with its id (then send_input / wait as before) so it continues from its own thread; only spawn a fresh agent with the same task if resume_agent fails.'
  }
  if (provider === 'claude') {
    return 'For each one, call SendMessage with its id (the CLI continues it from its saved transcript) and keep it in the background as before; ids starting with "workflow:" were Workflow runs: read their journal and re-run only the unfinished part. Only relaunch an Agent with the same task description if SendMessage fails.'
  }
  return 'Restart each of them with the same task so the work continues where it stopped.'
}

// 关 IDE 时整棵进程树被杀，子 agent 不会自己活过来；续跑首条消息点名它们，让模型用原生续接工具接回去。
export const buildInterruptedSessionResumePrompt = (
  provider: Provider | undefined,
  agents: InterruptedAgent[],
) => {
  if (agents.length === 0) {
    return ''
  }

  return [
    'The IDE was closed while this turn was running and has just been reopened; resume the turn exactly where it stopped, without redoing finished work or asking the user anything.',
    `These sub-agents were still running when the IDE closed and were stopped with it:`,
    ...agents.map(describeAgent),
    resumeInstructionByProvider(provider),
    'Then wait for them and finish the original task as you would have.',
  ].join('\n')
}

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
      prompt: buildInterruptedSessionResumePrompt(entry.provider, entry.interruptedAgents ?? []),
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
