import type { ArchiveRecallSnapshot, CardStatus, ChatMessage, Provider } from '../shared/schema.ts'
import { getCompactMessageWindow } from './components/chat-card-compaction'

// 压缩之后，哪些 provider 还能把压缩前的原文翻出来（归档回查）。
//
// 目前只有 Codex：服务端只在 Codex 的启动参数里挂归档回查的 MCP 服务
// （server/archive-recall.ts 的 createArchiveRecallRuntimeOverrides）。
//
// 「带着历史另开新会话」时按不按压缩边界截断（chat-request-seeding.ts 的 getSeedingWindow）
// 必须和这里是同一个答案：截了又没有回查，压缩前的对话就凭空没了。所以两边都问这个函数，
// 不各写各的 provider 判断。
export const supportsArchiveRecall = (provider: Provider) => provider === 'codex'

export const buildArchiveRecallSnapshot = ({
  messages,
  provider,
  status,
}: {
  messages: ChatMessage[]
  provider: Provider
  status: CardStatus
}): ArchiveRecallSnapshot | undefined => {
  if (!supportsArchiveRecall(provider)) {
    return undefined
  }

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
