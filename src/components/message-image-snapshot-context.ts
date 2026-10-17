import { createContext } from 'react'

// 消息里的本地图片按"该条消息第一次展示的那一刻"冻结（pitfall #407）。
// renderMarkdown 的组件表按 workspacePath 缓存，不能把 messageId 塞进签名，所以走 context。
// null = 不在消息里（无冻结语义，保持实时读盘）。
export const MessageImageSnapshotContext = createContext<string | null>(null)
