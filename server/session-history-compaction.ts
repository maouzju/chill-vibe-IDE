import type { ChatMessage, SessionHistoryEntry } from '../shared/schema.js'

// Shared caps for chat transcripts that cross the Electron IPC bridge or land
// in state.json. Live cards are already trimmed to these budgets by the
// state-store sanitizer; archived-session restores and external-history
// imports must apply the same caps before returning a transcript to the
// renderer, or one legacy oversized sidecar can OOM the app on open.

export const maxPersistedCardMessages = 500

const maxPersistedCommandOutputChars = 512
const persistedCommandOutputHeadChars = 256
const persistedCommandOutputTailChars = 256

export const compactPersistedCommandOutput = (output: string) => {
  if (output.length <= maxPersistedCommandOutputChars) {
    return {
      output,
      didCompact: false,
    }
  }

  const omittedChars = output.length - persistedCommandOutputHeadChars - persistedCommandOutputTailChars

  return {
    output: [
      output.slice(0, persistedCommandOutputHeadChars),
      '',
      `[Output truncated in saved state. ${omittedChars} characters omitted.]`,
      '',
      output.slice(-persistedCommandOutputTailChars),
    ].join('\n'),
    didCompact: true,
  }
}

const compactPersistedMessageMeta = (meta: ChatMessage['meta']) => {
  if (!meta?.structuredData || meta.kind !== 'command') {
    return {
      meta,
      didCompact: false,
    }
  }

  try {
    const payload = JSON.parse(meta.structuredData) as Record<string, unknown>

    if (payload.kind !== 'command' || typeof payload.output !== 'string') {
      return {
        meta,
        didCompact: false,
      }
    }

    const compactedOutput = compactPersistedCommandOutput(payload.output)
    if (!compactedOutput.didCompact) {
      return {
        meta,
        didCompact: false,
      }
    }

    return {
      meta: {
        ...meta,
        structuredData: JSON.stringify({
          ...payload,
          output: compactedOutput.output,
        }),
      },
      didCompact: true,
    }
  } catch {
    return {
      meta,
      didCompact: false,
    }
  }
}

export const compactPersistedMessages = (messages: ChatMessage[]) => {
  let didCompact = false

  return {
    messages: messages.map((message) => {
      const compactedMeta = compactPersistedMessageMeta(message.meta)
      if (!compactedMeta.didCompact) {
        return message
      }

      didCompact = true
      return {
        ...message,
        meta: compactedMeta.meta,
      }
    }),
    didCompact,
  }
}

// Transfer-time fallback for structured payloads that the command compactor
// does not cover (tool summaries, edits patches, …). Oversized payloads are
// trimmed at the string-leaf level so the JSON stays parseable — trimming the
// raw JSON string would leave the card rendering degraded after restore.
const transferStructuredDataBudgetChars = 4_000

const trimTransferText = (value: string) =>
  value.length <= transferStructuredDataBudgetChars
    ? value
    : [
        value.slice(0, transferStructuredDataBudgetChars / 2),
        '',
        `[Output truncated in restored session. ${value.length - transferStructuredDataBudgetChars} characters omitted.]`,
        '',
        value.slice(-transferStructuredDataBudgetChars / 2),
      ].join('\n')

const trimTransferJsonStrings = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return trimTransferText(value)
  }

  if (depth >= 6) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => trimTransferJsonStrings(entry, depth + 1))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        trimTransferJsonStrings(entry, depth + 1),
      ]),
    )
  }

  return value
}

const trimTransferStructuredData = (structuredData: string) => {
  if (structuredData.length <= transferStructuredDataBudgetChars) {
    return structuredData
  }

  try {
    const payload = JSON.parse(structuredData)
    return JSON.stringify(trimTransferJsonStrings(payload))
  } catch {
    return trimTransferText(structuredData)
  }
}

export const compactSessionHistoryMessagesForTransfer = (messages: ChatMessage[]): ChatMessage[] => {
  const compacted = compactPersistedMessages(messages).messages.map((message) => {
    if (!message.meta?.structuredData || message.meta.structuredData.length <= transferStructuredDataBudgetChars) {
      return message
    }

    return {
      ...message,
      meta: {
        ...message.meta,
        structuredData: trimTransferStructuredData(message.meta.structuredData),
      },
    }
  })

  return compacted.length > maxPersistedCardMessages
    ? compacted.slice(-maxPersistedCardMessages)
    : compacted
}

export const compactSessionHistoryEntryForTransfer = (entry: SessionHistoryEntry): SessionHistoryEntry => {
  const messageCount = Math.max(
    typeof entry.messageCount === 'number' ? entry.messageCount : 0,
    entry.messages.length,
  )
  const messages = compactSessionHistoryMessagesForTransfer(entry.messages)

  if (messages === entry.messages && messageCount === entry.messageCount) {
    return entry
  }

  return {
    ...entry,
    messageCount,
    messages,
  }
}
