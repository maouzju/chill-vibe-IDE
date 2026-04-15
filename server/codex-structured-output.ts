import type { StreamActivity, StreamAssistantMessage } from '../shared/schema.js'
import { finalizeStructuredEditedFile } from './structured-edits.js'

type CodexStructuredStreamEvent =
  | ({ type: 'activity' } & StreamActivity)
  | ({ type: 'assistant_message' } & StreamAssistantMessage)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key] : undefined

const readInteger = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'number' && Number.isInteger(record[key]) ? record[key] : undefined

const readRecord = (record: Record<string, unknown>, key: string) =>
  isRecord(record[key]) ? (record[key] as Record<string, unknown>) : null

const codexAskUserTagPattern = /^<ask-user-question>\s*([\s\S]+?)\s*<\/ask-user-question>$/

const readNullableExitCode = (record: Record<string, unknown>) => {
  if (record.exit_code === null || record.exitCode === null) {
    return null
  }

  return typeof record.exit_code === 'number' && Number.isInteger(record.exit_code)
    ? record.exit_code
    : typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
      ? record.exitCode
    : null
}

const normalizeCommandStatus = (
  value: unknown,
): Extract<StreamActivity, { kind: 'command' }>['status'] | null => {
  if (value === 'in_progress' || value === 'inProgress') {
    return 'in_progress'
  }

  if (value === 'completed') {
    return value
  }

  if (value === 'declined') {
    return 'declined'
  }

  return null
}

const normalizeCodexItemType = (value: string) => {
  switch (value) {
    case 'commandExecution':
      return 'command_execution'
    case 'agentMessage':
      return 'agent_message'
    case 'fileChange':
      return 'file_change'
    case 'contextCompaction':
      return 'context_compaction'
    default:
      return value
  }
}

const normalizeCodexPatchKind = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }

  if (!isRecord(value)) {
    return undefined
  }

  const kindType = readString(value, 'type')
  if (!kindType) {
    return undefined
  }

  switch (kindType) {
    case 'add':
      return 'added'
    case 'delete':
      return 'deleted'
    case 'update':
      return 'modified'
    default:
      return undefined
  }
}

const readCodexChangeOriginalPath = (record: Record<string, unknown>) => {
  const patchKind = readRecord(record, 'kind')

  if (patchKind) {
    return readString(patchKind, 'move_path') ?? readString(patchKind, 'movePath')
  }

  return readString(record, 'original_path') ?? readString(record, 'old_path')
}

const parseCodexEditedFiles = (
  item: Record<string, unknown>,
): Extract<StreamActivity, { kind: 'edits' }>['files'] => {
  const rawFiles = Array.isArray(item.files)
    ? item.files
    : Array.isArray(item.edited_files)
      ? item.edited_files
      : Array.isArray(item.changes)
        ? item.changes
      : Array.isArray(item.diffs)
        ? item.diffs
        : [item]

  return rawFiles
    .map((entry) => {
      if (!isRecord(entry)) {
        return null
      }

      return finalizeStructuredEditedFile({
        path:
          readString(entry, 'path') ??
          readString(entry, 'file_path') ??
          readString(entry, 'new_path'),
        originalPath: readCodexChangeOriginalPath(entry),
        kind:
          normalizeCodexPatchKind(entry.kind) ??
          readString(entry, 'kind') ??
          readString(entry, 'change_type'),
        addedLines: readInteger(entry, 'addedLines') ?? readInteger(entry, 'added_lines'),
        removedLines: readInteger(entry, 'removedLines') ?? readInteger(entry, 'removed_lines'),
        patch:
          readString(entry, 'patch') ??
          readString(entry, 'diff') ??
          readString(entry, 'unified_diff'),
      })
    })
    .filter((entry): entry is Extract<StreamActivity, { kind: 'edits' }>['files'][number] => entry !== null)
}

const parseCodexAskUserActivity = (
  itemId: string,
  content: string,
): Extract<StreamActivity, { kind: 'ask-user' }> | null => {
  const match = content.trim().match(codexAskUserTagPattern)

  if (!match) {
    return null
  }

  try {
    const parsed = JSON.parse(match[1]!) as unknown

    if (!isRecord(parsed) || !Array.isArray(parsed.options)) {
      return null
    }

    const question = readString(parsed, 'question')?.trim()

    if (!question) {
      return null
    }

    const options = parsed.options
      .map((entry) => {
        if (!isRecord(entry)) {
          return null
        }

        const label = readString(entry, 'label')?.trim()

        if (!label) {
          return null
        }

        return {
          label,
          description: readString(entry, 'description')?.trim() ?? '',
        }
      })
      .filter(
        (
          entry,
        ): entry is Extract<StreamActivity, { kind: 'ask-user' }>['options'][number] => entry !== null,
      )

    if (options.length === 0) {
      return null
    }

    return {
      itemId,
      kind: 'ask-user',
      status: 'completed',
      header: readString(parsed, 'header')?.trim() ?? '',
      question,
      multiSelect: parsed.multiSelect === true,
      options,
    }
  } catch {
    return null
  }
}

const getCodexEventType = (event: Record<string, unknown>) => {
  const type = readString(event, 'type')
  if (type) {
    return type
  }

  const method = readString(event, 'method')
  if (method === 'item/started') {
    return 'item.started'
  }
  if (method === 'item/completed') {
    return 'item.completed'
  }

  return null
}

const getCodexEventParams = (event: Record<string, unknown>) =>
  readRecord(event, 'params') ?? event

const getCodexEventItem = (event: Record<string, unknown>) => {
  const directItem = readRecord(event, 'item')
  if (directItem) {
    return directItem
  }

  const params = readRecord(event, 'params')
  if (!params) {
    return null
  }

  return readRecord(params, 'item')
}

const readCodexReasoningText = (item: Record<string, unknown>) => {
  const text = readString(item, 'text')
  if (text) {
    return text
  }

  const summary = Array.isArray(item.summary)
    ? item.summary.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (summary.length > 0) {
    return summary.join('\n')
  }

  const content = Array.isArray(item.content)
    ? item.content.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (content.length > 0) {
    return content.join('\n')
  }

  return null
}

export const parseCodexResponseEvent = (event: unknown): CodexStructuredStreamEvent[] => {
  if (!isRecord(event)) {
    return []
  }

  const eventType = getCodexEventType(event)

  if (eventType !== 'item.started' && eventType !== 'item.completed') {
    if (readString(event, 'method') === 'thread/compacted') {
      const params = getCodexEventParams(event)
      const itemId = readString(params, 'turnId')

      if (!itemId) {
        return []
      }

      return [
        {
          type: 'activity',
          itemId,
          kind: 'compaction',
          status: 'completed',
          trigger: 'auto',
        },
      ]
    }

    return []
  }

  const item = getCodexEventItem(event)

  if (!item) {
    return []
  }

  const itemId = readString(item, 'id')
  const itemType = readString(item, 'type')

  if (!itemId || !itemType) {
    return []
  }

  const normalizedItemType = normalizeCodexItemType(itemType)

  if (normalizedItemType === 'command_execution') {
    const status = normalizeCommandStatus(item.status)

    if (!status) {
      return []
    }

    return [
      {
        type: 'activity',
        itemId,
        kind: 'command',
        status,
        command: readString(item, 'command') ?? '',
        output: readString(item, 'aggregated_output') ?? readString(item, 'aggregatedOutput') ?? '',
        exitCode: readNullableExitCode(item),
      },
    ]
  }

  if (
    eventType === 'item.completed' &&
    (normalizedItemType === 'edited_files' ||
      normalizedItemType === 'diff' ||
      normalizedItemType === 'file_change')
  ) {
    const files = parseCodexEditedFiles(item)

    if (files.length === 0) {
      return []
    }

    return [
      {
        type: 'activity',
        itemId,
        kind: 'edits',
        status: 'completed',
        files,
      },
    ]
  }

  if (eventType === 'item.completed' && normalizedItemType === 'reasoning') {
    const text = readCodexReasoningText(item)

    if (!text) {
      return []
    }

    return [
      {
        type: 'activity',
        itemId,
        kind: 'reasoning',
        status: 'completed',
        text,
      },
    ]
  }

  if (eventType === 'item.completed' && normalizedItemType === 'context_compaction') {
    return [
      {
        type: 'activity',
        itemId,
        kind: 'compaction',
        status: 'completed',
        trigger: 'auto',
      },
    ]
  }

  if (eventType === 'item.completed' && normalizedItemType === 'agent_message') {
    const content = readString(item, 'text')

    if (!content) {
      return []
    }

    const askUserActivity = parseCodexAskUserActivity(itemId, content)

    if (askUserActivity) {
      return [
        {
          type: 'activity',
          ...askUserActivity,
        },
      ]
    }

    return [
      {
        type: 'assistant_message',
        itemId,
        content,
      },
    ]
  }

  return []
}
