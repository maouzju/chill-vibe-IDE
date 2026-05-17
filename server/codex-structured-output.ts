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

const codexStructuredAgentMessagePrefixPattern = /^(?:<ask-user-question>|{)/

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
    case 'collabAgentToolCall':
      return 'collab_agent_tool_call'
    default:
      return value
  }
}

const normalizeAgentTool = (value: unknown): Extract<StreamActivity, { kind: 'agents' }>['tool'] | null => {
  switch (value) {
    case 'spawnAgent':
    case 'spawn_agent':
      return 'spawnAgent'
    case 'sendInput':
    case 'send_input':
      return 'sendInput'
    case 'resumeAgent':
    case 'resume_agent':
      return 'resumeAgent'
    case 'wait':
      return 'wait'
    case 'closeAgent':
    case 'close_agent':
      return 'closeAgent'
    default:
      return null
  }
}

const normalizeAgentCallStatus = (
  value: unknown,
): Extract<StreamActivity, { kind: 'agents' }>['callStatus'] | null => {
  switch (value) {
    case 'inProgress':
    case 'in_progress':
      return 'inProgress'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}

const normalizeAgentStatus = (
  value: unknown,
): Extract<StreamActivity, { kind: 'agents' }>['agents'][number]['status'] => {
  switch (value) {
    case 'pendingInit':
    case 'pending_init':
      return 'pendingInit'
    case 'running':
      return 'running'
    case 'interrupted':
      return 'interrupted'
    case 'completed':
      return 'completed'
    case 'errored':
      return 'errored'
    case 'shutdown':
      return 'shutdown'
    case 'notFound':
    case 'not_found':
      return 'notFound'
    default:
      return 'pendingInit'
  }
}

const readAgentStatusMessage = (record: Record<string, unknown> | null) => {
  if (!record) {
    return null
  }

  const message = readString(record, 'message')

  if (message) {
    return message
  }

  const statusValue = record.status
  if (isRecord(statusValue)) {
    return (
      readString(statusValue, 'message') ??
      readString(statusValue, 'completed') ??
      readString(statusValue, 'errored') ??
      null
    )
  }

  return null
}

const parseCodexAgentMetadataEntry = (value: unknown) => {
  if (!isRecord(value)) {
    return null
  }

  const threadId =
    readString(value, 'threadId') ??
    readString(value, 'thread_id') ??
    readString(value, 'id')

  if (!threadId) {
    return null
  }

  return {
    threadId,
    nickname:
      readString(value, 'agentNickname') ??
      readString(value, 'agent_nickname') ??
      readString(value, 'nickname'),
    role:
      readString(value, 'agentRole') ??
      readString(value, 'agent_role') ??
      readString(value, 'agentType') ??
      readString(value, 'agent_type') ??
      readString(value, 'role'),
    status: value.status,
    message: readAgentStatusMessage(value),
  }
}

const readAgentState = (
  record: Record<string, unknown>,
  threadId: string,
  metadata?: ReturnType<typeof parseCodexAgentMetadataEntry>,
) => {
  const agentsStates = readRecord(record, 'agentsStates') ?? readRecord(record, 'agents_states')
  const state = agentsStates && isRecord(agentsStates[threadId])
    ? agentsStates[threadId] as Record<string, unknown>
    : null
  const statusSource = state ?? metadata ?? null

  return {
    status: normalizeAgentStatus(statusSource?.status),
    message: readAgentStatusMessage(statusSource),
  }
}

const parseCodexCollabAgentActivity = (
  item: Record<string, unknown>,
): Extract<StreamActivity, { kind: 'agents' }> | null => {
  const itemId = readString(item, 'id')
  const tool = normalizeAgentTool(item.tool)
  const callStatus = normalizeAgentCallStatus(item.status)

  if (!itemId || !tool || !callStatus) {
    return null
  }

  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds
    : Array.isArray(item.receiver_thread_ids)
      ? item.receiver_thread_ids
      : []
  const metadataEntries = [
    ...(Array.isArray(item.receiverAgents) ? item.receiverAgents : []),
    ...(Array.isArray(item.receiver_agents) ? item.receiver_agents : []),
    ...(Array.isArray(item.agentStatuses) ? item.agentStatuses : []),
    ...(Array.isArray(item.agent_statuses) ? item.agent_statuses : []),
  ]
    .map(parseCodexAgentMetadataEntry)
    .filter((entry): entry is NonNullable<ReturnType<typeof parseCodexAgentMetadataEntry>> => entry !== null)
  const metadataByThreadId = new Map(metadataEntries.map((entry) => [entry.threadId, entry]))
  const agentsStates = readRecord(item, 'agentsStates') ?? readRecord(item, 'agents_states')
  const normalizedReceiverThreadIds = receiverThreadIds
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
  const threadIds = [
    ...new Set([
      ...normalizedReceiverThreadIds,
      ...metadataEntries.map((entry) => entry.threadId),
      ...(agentsStates ? Object.keys(agentsStates) : []),
    ]),
  ]

  return {
    itemId,
    kind: 'agents',
    status: 'completed',
    tool,
    callStatus,
    prompt: readString(item, 'prompt') ?? null,
    model: readString(item, 'model') ?? null,
    reasoningEffort: readString(item, 'reasoningEffort') ?? readString(item, 'reasoning_effort') ?? null,
    agents: threadIds.map((threadId) => {
      const metadata = metadataByThreadId.get(threadId)
      const state = readAgentState(item, threadId, metadata)
      return {
        threadId,
        ...(metadata?.nickname ? { nickname: metadata.nickname } : {}),
        ...(metadata?.role ? { role: metadata.role } : {}),
        status: state.status,
        message: state.message,
      }
    }),
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

const readCodexCommentaryEntryText = (entry: unknown) => {
  if (typeof entry === 'string') {
    return entry.trim()
  }

  if (!isRecord(entry)) {
    return null
  }

  return readString(entry, 'text')?.trim() ?? readString(entry, 'content')?.trim() ?? null
}

const parseCodexCommentaryActivity = (
  itemId: string,
  content: string,
): Extract<StreamActivity, { kind: 'reasoning' }> | null => {
  const trimmed = content.trim()

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown

    if (!isRecord(parsed)) {
      return null
    }

    const commentary = Array.isArray(parsed.commentary) ? parsed.commentary : null
    if (!commentary || commentary.length === 0) {
      return null
    }

    const text = commentary
      .map((entry) => readCodexCommentaryEntryText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join('\n\n')
      .trim()

    if (!text) {
      return null
    }

    return {
      itemId,
      kind: 'reasoning',
      status: 'completed',
      text,
    }
  } catch {
    return null
  }
}

export const looksLikeCodexStructuredAgentMessage = (content: string) =>
  codexStructuredAgentMessagePrefixPattern.test(content.trimStart())

export const parseCodexAgentMessageContent = (
  itemId: string,
  content: string,
): CodexStructuredStreamEvent[] => {
  const askUserActivity = parseCodexAskUserActivity(itemId, content)

  if (askUserActivity) {
    return [
      {
        type: 'activity',
        ...askUserActivity,
      },
    ]
  }

  const commentaryActivity = parseCodexCommentaryActivity(itemId, content)

  if (commentaryActivity) {
    return [
      {
        type: 'activity',
        ...commentaryActivity,
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

  if (normalizedItemType === 'collab_agent_tool_call') {
    const activity = parseCodexCollabAgentActivity(item)

    if (!activity) {
      return []
    }

    return [
      {
        type: 'activity',
        ...activity,
      },
    ]
  }

  if (eventType === 'item.completed' && normalizedItemType === 'agent_message') {
    const content = readString(item, 'text')

    if (!content) {
      return []
    }

    return parseCodexAgentMessageContent(itemId, content)
  }

  return []
}
