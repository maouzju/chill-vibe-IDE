import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ArchiveRecallSnapshot, ChatMessage } from '../shared/schema.js'
import { maxPersistedCardMessages } from './session-history-compaction.js'

const compactedCardHistoryDirName = 'compacted-card-history'

type CompactedCardHistoryFile = {
  cardId: string
  updatedAt: string
  messages: ChatMessage[]
}

const getHistoryDir = (dataDir: string) => path.join(dataDir, compactedCardHistoryDirName)

const encodeCardId = (cardId: string) => Buffer.from(cardId, 'utf8').toString('base64url')

const getHistoryPath = (dataDir: string, cardId: string) =>
  path.join(getHistoryDir(dataDir), `${encodeCardId(cardId)}.json`)

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const message = value as Partial<ChatMessage>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'string'
  )
}

const readHistoryFile = async (
  dataDir: string,
  cardId: string,
): Promise<CompactedCardHistoryFile | null> => {
  try {
    const parsed = JSON.parse(await readFile(getHistoryPath(dataDir, cardId), 'utf8')) as Partial<CompactedCardHistoryFile>
    if (parsed.cardId !== cardId || !Array.isArray(parsed.messages)) {
      return null
    }

    return {
      cardId,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      messages: parsed.messages.filter(isChatMessage),
    }
  } catch {
    return null
  }
}

const mergeMessagesWithoutDowngrading = (
  existing: ChatMessage[],
  incoming: ChatMessage[],
) => {
  const seen = new Set(existing.map((message) => message.id))
  const merged = [...existing]

  for (const message of incoming) {
    if (!seen.has(message.id)) {
      seen.add(message.id)
      merged.push(message)
    }
  }

  return merged
}

const atomicWriteHistoryFile = async (
  dataDir: string,
  cardId: string,
  messages: ChatMessage[],
) => {
  const historyDir = getHistoryDir(dataDir)
  await mkdir(historyDir, { recursive: true })
  const targetPath = getHistoryPath(dataDir, cardId)
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`
  const payload: CompactedCardHistoryFile = {
    cardId,
    updatedAt: new Date().toISOString(),
    messages,
  }

  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, 'utf8')
    await rename(temporaryPath, targetPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

const getCompactedPrefix = (card: unknown): ChatMessage[] => {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return []
  }

  const candidate = card as {
    provider?: unknown
    messages?: unknown
  }
  if (!Array.isArray(candidate.messages)) {
    return []
  }

  const messages = candidate.messages.filter(isChatMessage)
  // 症状：旧会话往上翻到某处就断了，更早的消息找不到。
  // 根因：活动卡 500 条上限在 sanitize 里直接 slice，此前只有 Codex 的 compact 前缀会进 sidecar，
  // Claude 或没 compact 过的会话被裁掉的开头永久丢失。这里把被裁的溢出前缀也归档。
  const overflowEnd = Math.max(messages.length - maxPersistedCardMessages, 0)
  if (candidate.provider === 'codex') {
    for (let index = messages.length - 1; index > 0; index -= 1) {
      const message = messages[index]
      if (
        message?.role === 'user' &&
        message.meta?.compactBoundary === 'true' &&
        message.meta?.compactPending !== 'true'
      ) {
        return messages.slice(0, Math.max(index, overflowEnd))
      }
    }
  }

  return messages.slice(0, overflowEnd)
}

export const persistCompactedCardHistories = async (rawState: unknown, dataDir: string) => {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return
  }

  const columns = (rawState as { columns?: unknown }).columns
  if (!Array.isArray(columns)) {
    return
  }

  for (const column of columns) {
    if (!column || typeof column !== 'object' || Array.isArray(column)) {
      continue
    }

    const cards = (column as { cards?: unknown }).cards
    if (!cards || typeof cards !== 'object' || Array.isArray(cards)) {
      continue
    }

    for (const [cardId, card] of Object.entries(cards)) {
      const compactedPrefix = getCompactedPrefix(card)
      if (!cardId || compactedPrefix.length === 0) {
        continue
      }

      const existing = await readHistoryFile(dataDir, cardId)
      const merged = mergeMessagesWithoutDowngrading(existing?.messages ?? [], compactedPrefix)
      if (existing && merged.length === existing.messages.length) {
        continue
      }

      await atomicWriteHistoryFile(dataDir, cardId, merged)
    }
  }
}

export const pruneResetCompactedCardHistories = async (rawState: unknown, dataDir: string) => {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return
  }

  const columns = (rawState as { columns?: unknown }).columns
  if (!Array.isArray(columns)) {
    return
  }

  for (const column of columns) {
    if (!column || typeof column !== 'object' || Array.isArray(column)) {
      continue
    }

    const cards = (column as { cards?: unknown }).cards
    if (!cards || typeof cards !== 'object' || Array.isArray(cards)) {
      continue
    }

    for (const [cardId, card] of Object.entries(cards)) {
      if (!cardId || !card || typeof card !== 'object' || Array.isArray(card)) {
        continue
      }

      const candidate = card as {
        provider?: unknown
        messages?: unknown
        messageCount?: unknown
        sessionId?: unknown
      }
      const messageCount = typeof candidate.messageCount === 'number'
        ? Math.max(Math.trunc(candidate.messageCount), 0)
        : 0
      if (
        !Array.isArray(candidate.messages) ||
        candidate.messages.length > 0 ||
        messageCount > 0 ||
        (typeof candidate.sessionId === 'string' && candidate.sessionId.trim().length > 0)
      ) {
        continue
      }

      await rm(getHistoryPath(dataDir, cardId), { force: true })
    }
  }
}

export const loadCompactedCardHistorySnapshot = async (
  dataDir: string,
  cardId: string | undefined,
): Promise<ArchiveRecallSnapshot | undefined> => {
  if (!cardId) {
    return undefined
  }

  const history = await readHistoryFile(dataDir, cardId)
  if (!history || history.messages.length === 0) {
    return undefined
  }

  return {
    hiddenReason: 'compact',
    hiddenMessageCount: history.messages.length,
    messages: history.messages,
  }
}

export const loadCompactedCardHistoryForDisplay = async (
  dataDir: string,
  cardId: string,
) => ({
  snapshot: (await loadCompactedCardHistorySnapshot(dataDir, cardId)) ?? null,
})

export const mergeArchiveRecallSnapshots = (
  persisted: ArchiveRecallSnapshot | undefined,
  current: ArchiveRecallSnapshot | undefined,
): ArchiveRecallSnapshot | undefined => {
  const messages = mergeMessagesWithoutDowngrading(
    persisted?.messages ?? [],
    current?.messages ?? [],
  )
  if (messages.length === 0) {
    return undefined
  }

  return {
    hiddenReason: 'compact',
    hiddenMessageCount: messages.length,
    messages,
  }
}
