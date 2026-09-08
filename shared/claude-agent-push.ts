import type { ChatCard, ChatMessage, ClaudeAgentStatusPush } from './schema.js'

export const retireUntrackedClaudeAgents = (messages: ChatMessage[]): ChatMessage[] => {
  let changed = false
  const next = messages.map((message) => {
    if (message.meta?.provider !== 'claude' || message.meta.kind !== 'agents' || !message.meta.structuredData) return message
    try {
      const data = JSON.parse(message.meta.structuredData)
      if (data.view !== 'status' || !Array.isArray(data.agents)) return message
      let updated = false
      const agents = data.agents.map((agent: Record<string, unknown>) => {
        if (agent && ['running', 'pendingInit'].includes(String(agent.status))) {
          updated = true
          return { ...agent, status: 'interrupted' }
        }
        return agent
      })
      if (!updated) return message
      changed = true
      return { ...message, meta: { ...message.meta, structuredData: JSON.stringify({ ...data, agents }) } }
    } catch { return message }
  })
  return changed ? next : messages
}

export const applyClaudeAgentStatusPush = (card: ChatCard, push: ClaudeAgentStatusPush): ChatCard => {
  if (card.provider !== 'claude' || (card.sessionId && push.sessionId && card.sessionId !== push.sessionId)) return card
  const id = `claude:${push.streamId}:item:agent-status:claude`
  const index = card.messages.findIndex((message) => message.id === id)
  const messages = index < 0 ? retireUntrackedClaudeAgents(card.messages) : card.messages
  const message: ChatMessage = {
    id, role: 'assistant', content: '', createdAt: messages[index]?.createdAt ?? new Date().toISOString(),
    meta: { provider: 'claude', kind: 'agents', itemId: push.agentStatus.itemId, structuredData: JSON.stringify(push.agentStatus) },
  }
  if (messages[index]?.meta?.structuredData === message.meta?.structuredData) return card
  const next = [...messages]
  if (index < 0) next.push(message)
  else next[index] = message
  return { ...card, messages: next }
}
