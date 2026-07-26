import type { ChatMessage, StreamAgentsActivity } from '../shared/schema'
import { parseStructuredAgentsMessage } from './components/chat-card-parsing'

export const createCodexAgentStatusSnapshotActivity = (
  messages: ChatMessage[],
  itemId: string,
): StreamAgentsActivity => {
  let fallbackAgents: StreamAgentsActivity['agents'] | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const parsed = parseStructuredAgentsMessage(messages[index]!)
    if (parsed?.view !== 'status') {
      continue
    }

    const agents = parsed.agents.map((agent) => ({
      ...agent,
      activity: [...(agent.activity ?? [])],
    }))
    fallbackAgents ??= agents
    if (parsed.itemId.startsWith('agent-status:')) {
      return {
        itemId,
        kind: 'agents',
        status: 'completed',
        view: 'status',
        agents,
      }
    }
  }

  return {
    itemId,
    kind: 'agents',
    status: 'completed',
    view: 'status',
    agents: fallbackAgents ?? [],
  }
}
