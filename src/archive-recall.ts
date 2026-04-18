import type { ArchiveRecallSnapshot, CardStatus, ChatMessage, Provider } from '../shared/schema.ts'
import { getCompactMessageWindow } from './components/chat-card-compaction'

export const buildArchiveRecallSnapshot = ({
  messages,
  provider,
  status,
}: {
  messages: ChatMessage[]
  provider: Provider
  status: CardStatus
}): ArchiveRecallSnapshot | undefined => {
  const compactWindow = getCompactMessageWindow(messages, provider, status, {
    allowPerformanceWindowing: false,
  })

  if (compactWindow.hiddenReason !== 'compact' || compactWindow.hiddenMessageCount <= 0) {
    return undefined
  }

  const hiddenMessages = messages.slice(0, compactWindow.hiddenMessageCount)
  if (hiddenMessages.length === 0) {
    return undefined
  }

  return {
    hiddenReason: 'compact',
    hiddenMessageCount: hiddenMessages.length,
    messages: hiddenMessages,
  }
}
