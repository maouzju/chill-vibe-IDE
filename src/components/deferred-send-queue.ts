import type { ImageAttachment } from '../../shared/schema'

export type SendMessageMode = 'auto' | 'defer' | 'interrupt'

export type SendMessageOptions = {
  mode?: SendMessageMode
}

export type QueuedSendRequest = {
  id: string
  prompt: string
  attachments: ImageAttachment[]
}

export type QueuedSendSummary = {
  count: number
  nextPreview: string
  nextAttachmentCount: number
}

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

export const getQueuedSendPreview = (request: Pick<QueuedSendRequest, 'prompt'>) =>
  collapseWhitespace(request.prompt).slice(0, 120)

export const summarizeQueuedSends = (
  queue: readonly QueuedSendRequest[] | undefined,
): QueuedSendSummary | undefined => {
  if (!queue || queue.length === 0) {
    return undefined
  }

  const next = queue[0]!
  return {
    count: queue.length,
    nextPreview: getQueuedSendPreview(next),
    nextAttachmentCount: next.attachments.length,
  }
}

type QueuedSendTargetColumn = {
  id: string
  workspacePath?: string | null
  cards?: Record<string, unknown>
}

const ownsCardInWorkspace = (column: QueuedSendTargetColumn, cardId: string) =>
  Boolean(column.cards?.[cardId]) && Boolean(column.workspacePath?.trim())

export const resolveQueuedSendTargetColumnId = (
  columns: readonly QueuedSendTargetColumn[],
  fallbackColumnId: string,
  cardId: string,
) => {
  const fallbackColumn = columns.find((column) => column.id === fallbackColumnId)
  if (fallbackColumn && ownsCardInWorkspace(fallbackColumn, cardId)) {
    return fallbackColumn.id
  }

  return columns.find((column) => ownsCardInWorkspace(column, cardId))?.id ?? null
}
