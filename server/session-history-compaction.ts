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

const persistedCommandOutputMarkerPattern = /^\n\n\[Output truncated in saved state\. \d+ characters omitted\.\]\n\n$/

// 症状：读一次档就整份重写一次（WAL、tmp、fsync、快照轮转），省略字数还被改成 61 之类的假数。
// 根因：2026-11-20 审查。压缩产物是 256 + 标记 + 256 ≈ 575 字符，仍大于 512 的阈值，
//   于是已压缩过的输出每次都被判成「还要压」，didCompact 恒为 true。
// 不把阈值抬到 ~600：那会让 513–600 字符的原始输出从此不压，改了落盘内容；
//   这里只认「头 256 + 标记 + 尾 256」这一种形状，旧版 24KB+8KB 的产物照常重压。
const isAlreadyCompactedCommandOutput = (output: string) =>
  output.length > persistedCommandOutputHeadChars + persistedCommandOutputTailChars &&
  persistedCommandOutputMarkerPattern.test(
    output.slice(persistedCommandOutputHeadChars, output.length - persistedCommandOutputTailChars),
  )

export const compactPersistedCommandOutput = (output: string) => {
  if (output.length <= maxPersistedCommandOutputChars || isAlreadyCompactedCommandOutput(output)) {
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

const transferTrimMarkerPattern = /^\n\n\[Output truncated in restored session\. \d+ characters omitted\.\]\n\n$/

// 与上面 isAlreadyCompactedCommandOutput 同一个坑：裁剪产物（2000 + 标记 + 2000）仍大于 4000 的预算，
// 裁过的归档再恢复一次就会被重裁，省略字数被改成约 70 的假数。
const isAlreadyTrimmedTransferText = (value: string) =>
  transferTrimMarkerPattern.test(
    value.slice(transferStructuredDataBudgetChars / 2, value.length - transferStructuredDataBudgetChars / 2),
  )

const trimTransferText = (value: string) =>
  value.length <= transferStructuredDataBudgetChars || isAlreadyTrimmedTransferText(value)
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
