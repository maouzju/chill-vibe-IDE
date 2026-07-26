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
  isStreamingTail?: boolean
}

export const plainStreamingAssistantThresholdChars = 16_000

export const shouldUsePlainStreamingAssistantRender = (
  message: Pick<ChatMessage, 'role' | 'content' | 'meta'>,
  isStreamingTail: boolean,
) =>
  isStreamingTail &&
  message.role === 'assistant' &&
  message.meta?.kind === undefined &&
  message.content.length >= plainStreamingAssistantThresholdChars

export const areMessageBubblePropsEqual = (
  previous: MessageBubbleProps,
  next: MessageBubbleProps,
) =>
  previous.language === next.language &&
  previous.message === next.message &&
  previous.workspacePath === next.workspacePath &&
  previous.answeredOption === next.answeredOption &&
  previous.isStickyToTop === next.isStickyToTop &&
  previous.isStreamingTail === next.isStreamingTail &&
  Boolean(previous.onOpenFile) === Boolean(next.onOpenFile) &&
  Boolean(previous.onForkFromHere) === Boolean(next.onForkFromHere)
