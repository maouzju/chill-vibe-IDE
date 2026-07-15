import type {
  QueuedSendRequest,
  StreamAskUserActivity,
} from '../../shared/schema'

export type { QueuedSendRequest } from '../../shared/schema'

export type SendMessageMode = 'auto' | 'defer' | 'interrupt'

export type SendMessageOptions = {
  mode?: SendMessageMode
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

type QueuedSendRuntimeCard = {
  id: string
  queuedSends?: readonly QueuedSendRequest[]
}

export const buildQueuedSendRuntimeState = (
  columns: readonly { cards: Record<string, QueuedSendRuntimeCard> }[],
) => {
  const queues = new Map<string, QueuedSendRequest[]>()
  const summaries = new Map<string, QueuedSendSummary>()

  for (const column of columns) {
    for (const card of Object.values(column.cards)) {
      if (!card.queuedSends || card.queuedSends.length === 0) {
        continue
      }

      const queue = card.queuedSends.map((request) => ({
        ...request,
        attachments: request.attachments.map((attachment) => ({ ...attachment })),
      }))
      const summary = summarizeQueuedSends(queue)
      queues.set(card.id, queue)
      if (summary) {
        summaries.set(card.id, summary)
      }
    }
  }

  return { queues, summaries }
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

export const shouldStopStreamForAskUserActivity = (
  activity: Pick<StreamAskUserActivity, 'planFile' | 'nativeTool'>,
) =>
  // Native CLI tool questions (AskUserQuestion / ExitPlanMode) are auto-answered
  // by the headless CLI, so the run keeps going unless we stop it here. Text-
  // convention ask-user blocks end the turn naturally and must not be stopped.
  activity.nativeTool === true || Boolean(activity.planFile?.trim())

export const shouldSuppressStreamOutputAfterAskUserActivity = (
  activity: Pick<StreamAskUserActivity, 'planFile' | 'nativeTool'>,
) => shouldStopStreamForAskUserActivity(activity)
