import type { StreamEnvelope } from './chat-manager.js'

// A "tap" is a global, read-only observer over every chat stream at once —
// unlike ChatManager.subscribe it is not scoped to one streamId. The remote
// monitor uses it to mirror all live sessions to a phone browser.
export type ChatStreamTapEvent = {
  streamId: string
  cardId?: string
  envelope: StreamEnvelope
}

export type TappableStreamRecord = {
  id: string
  cardId?: string
  terminal: boolean
  backlog: StreamEnvelope[]
}

export type ActiveStreamView = {
  streamId: string
  cardId?: string
  backlog: StreamEnvelope[]
}

export const createChatStreamTapRegistry = () => {
  const taps = new Set<(event: ChatStreamTapEvent) => void>()

  return {
    tap(listener: (event: ChatStreamTapEvent) => void) {
      taps.add(listener)
      return () => {
        taps.delete(listener)
      }
    },
    broadcast(event: ChatStreamTapEvent) {
      for (const listener of taps) {
        try {
          listener(event)
        } catch {
          // A broken observer must never disturb the chat stream itself or
          // its sibling observers; the tap is strictly read-only.
        }
      }
    },
    get size() {
      return taps.size
    },
  }
}

export type ChatStreamTapRegistry = ReturnType<typeof createChatStreamTapRegistry>

// Late-joining monitor clients need the picture so far: a snapshot copy of
// every non-terminal stream's backlog. Copies, not references — the live
// backlog array keeps mutating while the view is serialized.
export const buildActiveStreamViews = (records: Iterable<TappableStreamRecord>): ActiveStreamView[] => {
  const views: ActiveStreamView[] = []

  for (const record of records) {
    if (record.terminal) {
      continue
    }

    views.push({
      streamId: record.id,
      cardId: record.cardId,
      backlog: [...record.backlog],
    })
  }

  return views
}
