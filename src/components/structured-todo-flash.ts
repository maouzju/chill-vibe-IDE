import type { StructuredTodoMessage } from './chat-card-parsing'

export const structuredTodoCompletionFlashDurationMs = 1150

export const getNewlyCompletedStructuredTodoItemIds = (
  previousItems: StructuredTodoMessage['items'],
  nextItems: StructuredTodoMessage['items'],
) => {
  const previousStatusById = new Map(
    previousItems.map((item) => [item.id, item.status] as const),
  )
  const newlyCompletedItemIds: string[] = []

  for (const item of nextItems) {
    if (item.status !== 'completed') {
      continue
    }

    const previousStatus = previousStatusById.get(item.id)

    if (previousStatus && previousStatus !== 'completed') {
      newlyCompletedItemIds.push(item.id)
    }
  }

  return newlyCompletedItemIds
}
