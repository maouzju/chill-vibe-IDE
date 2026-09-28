import type { ChatCard, ChatMessage, ClaudeAgentStatusPush } from './schema.js'

// Workflow 条目的汇总行前缀（由 server/claude-agent-status.ts 生成，决策记录在那里）。
// 放在 shared 是因为落盘快照的收尾（下方 retireUntrackedClaudeAgents）也要认得它。
export const claudeWorkflowSummaryPrefix = '📋'

// 症状：中途退出再启动，Workflow 条目已标 interrupted，旁边的汇总仍写着「在跑 1 · 排队 2」（2026-09-27 对抗审查复现）。
// 根因：汇总行第一段「已完成 x/y」是跑到哪的事实，后面几段是生成那一刻的实时计数；收尾只改 status、原样保留 activity。
// 被否决：整行删掉——丢了"四个里完成了几个"这条历史。只留第一段，中英文格式都以它开头。
const settleWorkflowSummary = (line: unknown) =>
  typeof line === 'string' && line.startsWith(`${claudeWorkflowSummaryPrefix} `) ? line.split(' · ')[0] : line

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
          return {
            ...agent,
            status: 'interrupted',
            ...(Array.isArray(agent.activity) ? { activity: agent.activity.map(settleWorkflowSummary) } : {}),
          }
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
