import type { StreamActivity } from '../shared/schema.js'

type CodexCompactionActivity = Extract<StreamActivity, { kind: 'compaction' }>
type CodexCompactionEventSource = 'context-compaction-item' | 'thread-compacted'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key] : undefined

const readRecord = (record: Record<string, unknown>, key: string) =>
  isRecord(record[key]) ? (record[key] as Record<string, unknown>) : null

const normalizeCompactionItemType = (value: string | undefined) => {
  switch (value) {
    case 'contextCompaction':
      return 'context_compaction'
    default:
      return value
  }
}

const getCodexCompactionEventSource = (event: unknown): CodexCompactionEventSource | null => {
  if (!isRecord(event)) {
    return null
  }

  const method = readString(event, 'method')

  if (method === 'thread/compacted') {
    return 'thread-compacted'
  }

  const type = readString(event, 'type')
  if (method !== 'item/completed' && type !== 'item.completed') {
    return null
  }

  const item = readRecord(event, 'item') ?? readRecord(readRecord(event, 'params') ?? {}, 'item')
  const itemType = normalizeCompactionItemType(item ? readString(item, 'type') : undefined)

  return itemType === 'context_compaction' ? 'context-compaction-item' : null
}

export const createCodexCompactionActivityDeduper = () => {
  let lastCompactionSource: CodexCompactionEventSource | null = null
  let lastCompactionKey: string | null = null

  return {
    shouldEmit(event: unknown, activity: CodexCompactionActivity) {
      const source = getCodexCompactionEventSource(event)

      if (!source) {
        lastCompactionSource = null
        lastCompactionKey = null
        return true
      }

      const key = `${source}:${activity.itemId}`

      if (lastCompactionKey === key) {
        return false
      }

      if (lastCompactionSource && lastCompactionSource !== source) {
        lastCompactionSource = null
        lastCompactionKey = null
        return false
      }

      lastCompactionSource = source
      lastCompactionKey = key
      return true
    },
    reset() {
      lastCompactionSource = null
      lastCompactionKey = null
    },
  }
}
