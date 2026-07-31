import { createContext } from 'react'

import type { AppLanguage } from '../../shared/schema'

export type MessageFileOpenHandler = (openPath: string, options?: { line?: number }) => void

export type MessageFileOpenContextValue = {
  open: MessageFileOpenHandler
  language: AppLanguage
}

// Chat markdown is rendered by a plain function (renderMarkdown) whose component
// map is cached per workspacePath, so threading the open-file callback through the
// signature would either break that cache or need a second cache key. Context keeps
// the cache intact and lets the <a>/<code> components pick the handler up directly.
// A null value means "no editor host mounted" — the markdown then keeps its old
// reveal-in-explorer behaviour instead of rendering dead click targets.
export const MessageFileOpenContext = createContext<MessageFileOpenContextValue | null>(null)
