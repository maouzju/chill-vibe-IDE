import type { AppLanguage, ChatMessage } from '../../shared/schema'

export type MessageBubbleProps = {
  language: AppLanguage
  message: ChatMessage
  workspacePath: string
  answeredOption: string | null
  onSelectAskUserOption: (answerKey: string, label: string) => void
  onOpenFile?: (relativePath: string) => void
  isStickyToTop?: boolean
  onForkFromHere?: () => void
  entryRef?: (node: HTMLDivElement | null) => void
}

export const areMessageBubblePropsEqual = (
  previous: MessageBubbleProps,
  next: MessageBubbleProps,
) =>
  previous.language === next.language &&
  previous.message === next.message &&
  previous.workspacePath === next.workspacePath &&
  previous.answeredOption === next.answeredOption &&
  previous.isStickyToTop === next.isStickyToTop &&
  Boolean(previous.onOpenFile) === Boolean(next.onOpenFile) &&
  Boolean(previous.onForkFromHere) === Boolean(next.onForkFromHere)
