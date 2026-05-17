import type { ChatMessage, Provider, StreamAgentEntry, StreamAgentTool, StreamAgentToolCallStatus, StreamEditedFile, StreamTodoItem } from '../../shared/schema'
import { isHiddenCompactBoundaryMessage } from './chat-card-compaction'

export type StructuredCommandMessage = {
  itemId: string
  status: 'in_progress' | 'completed' | 'declined'
  command: string
  output: string
  exitCode: number | null
}

export type StructuredReasoningMessage = {
  itemId: string
  status: 'completed'
  text: string
}

export type StructuredToolMessage = {
  itemId: string
  status: 'completed'
  toolName: string
  summary: string
  toolInput?: Record<string, string>
}

export type StructuredEditedFile = StreamEditedFile

export type StructuredEditsMessage = {
  itemId: string
  status: 'completed'
  files: StructuredEditedFile[]
}

export type StructuredTodoItem = StreamTodoItem

export type StructuredTodoMessage = {
  itemId: string
  status: 'completed'
  items: StructuredTodoItem[]
}

export type StructuredAgentEntry = StreamAgentEntry

export type StructuredAgentsMessage = {
  itemId: string
  status: 'completed'
  tool: StreamAgentTool
  callStatus: StreamAgentToolCallStatus
  prompt?: string | null
  model?: string | null
  reasoningEffort?: string | null
  agents: StructuredAgentEntry[]
}

export type StructuredAskUserOption = {
  label: string
  description: string
}

export type StructuredAskUserQuestionItem = {
  question: string
  header: string
  multiSelect: boolean
  options: StructuredAskUserOption[]
}

export type StructuredAskUserMessage = {
  itemId: string
  status: 'completed'
  question: string
  header: string
  multiSelect: boolean
  options: StructuredAskUserOption[]
  questions: StructuredAskUserQuestionItem[]
}

export type StructuredToolGroupItem =
  | { kind: 'command'; message: ChatMessage; data: StructuredCommandMessage }
  | { kind: 'tool'; message: ChatMessage; data: StructuredToolMessage }
  | { kind: 'edits'; message: ChatMessage; data: StructuredEditsMessage }

export type StructuredToolGroup = {
  type: 'tool-group'
  items: StructuredToolGroupItem[]
}

export type RenderableMessage =
  | {
      type: 'message'
      message: ChatMessage
    }
  | StructuredToolGroup

const structuredDataCache = new WeakMap<ChatMessage, Record<string, unknown> | null>()

export const readStructuredData = (message: ChatMessage) => {
  const cached = structuredDataCache.get(message)
  if (cached !== undefined || structuredDataCache.has(message)) {
    return cached
  }

  const raw = message.meta?.structuredData

  if (typeof raw !== 'string' || !raw.trim()) {
    structuredDataCache.set(message, null)
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    const nextValue = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
    structuredDataCache.set(message, nextValue)
    return nextValue
  } catch {
    structuredDataCache.set(message, null)
    return null
  }
}

export const readStructuredString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key] : undefined

export const readStructuredInteger = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'number' && Number.isInteger(record[key]) ? record[key] : undefined

export const readStructuredExitCode = (record: Record<string, unknown>) => {
  if (record.exitCode === null) {
    return null
  }

  return typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
    ? record.exitCode
    : null
}

export const parseStructuredCommandMessage = (message: ChatMessage): StructuredCommandMessage | null => {
  if (message.meta?.kind !== 'command') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')
  const status = readStructuredString(payload, 'status')

  if (
    !itemId ||
    (status !== 'in_progress' && status !== 'completed' && status !== 'declined')
  ) {
    return null
  }

  return {
    itemId,
    status,
    command: readStructuredString(payload, 'command') ?? '',
    output: readStructuredString(payload, 'output') ?? '',
    exitCode: readStructuredExitCode(payload),
  }
}

export const parseStructuredReasoningMessage = (message: ChatMessage): StructuredReasoningMessage | null => {
  if (message.meta?.kind !== 'reasoning') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')
  const text = readStructuredString(payload, 'text')

  if (!itemId || !text) {
    return null
  }

  return {
    itemId,
    status: 'completed',
    text,
  }
}

export const parseStructuredToolMessage = (message: ChatMessage): StructuredToolMessage | null => {
  if (message.meta?.kind !== 'tool') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')
  const toolName = readStructuredString(payload, 'toolName')
  const summary = readStructuredString(payload, 'summary')

  if (!itemId || !toolName || !summary) {
    return null
  }

  const rawInput = payload.toolInput
  const toolInput =
    typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
      ? Object.fromEntries(
          Object.entries(rawInput as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        )
      : undefined

  return {
    itemId,
    status: 'completed',
    toolName,
    summary,
    toolInput: toolInput && Object.keys(toolInput).length > 0 ? toolInput : undefined,
  }
}

const structuredEditedFileKinds = new Set<StreamEditedFile['kind']>([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
])

export const parseStructuredEditedFile = (value: unknown): StreamEditedFile | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const record = value as Record<string, unknown>
  const path = readStructuredString(record, 'path')
  const originalPath = readStructuredString(record, 'originalPath')
  const kind = readStructuredString(record, 'kind')
  const addedLines = readStructuredInteger(record, 'addedLines')
  const removedLines = readStructuredInteger(record, 'removedLines')
  const patch = readStructuredString(record, 'patch')

  if (
    !path ||
    !kind ||
    !structuredEditedFileKinds.has(kind as StreamEditedFile['kind']) ||
    addedLines === undefined ||
    removedLines === undefined ||
    patch === undefined
  ) {
    return null
  }

  return {
    path,
    originalPath,
    kind: kind as StreamEditedFile['kind'],
    addedLines,
    removedLines,
    patch,
  }
}

export const parseStructuredEditsMessage = (message: ChatMessage): StructuredEditsMessage | null => {
  if (message.meta?.kind !== 'edits') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')
  const status = readStructuredString(payload, 'status')
  const rawFiles = payload.files

  if (!itemId || status !== 'completed' || !Array.isArray(rawFiles)) {
    return null
  }

  const files = rawFiles
    .map((file) => parseStructuredEditedFile(file))
    .filter((file): file is StreamEditedFile => file !== null)

  return {
    itemId,
    status: 'completed',
    files,
  }
}

export const parseStructuredTodoMessage = (message: ChatMessage): StructuredTodoMessage | null => {
  if (message.meta?.kind !== 'todo') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')
  const status = readStructuredString(payload, 'status')
  const rawItems = payload.items

  if (!itemId || status !== 'completed' || !Array.isArray(rawItems)) {
    return null
  }

  const items: StructuredTodoItem[] = []

  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }

    const record = entry as Record<string, unknown>
    const id = readStructuredString(record, 'id')
    const content = readStructuredString(record, 'content')
    const activeForm = readStructuredString(record, 'activeForm')
    const priority = readStructuredString(record, 'priority')
    const itemStatus = readStructuredString(record, 'status')

    if (
      !id ||
      !content ||
      (itemStatus !== 'pending' && itemStatus !== 'in_progress' && itemStatus !== 'completed')
    ) {
      continue
    }

    items.push({
      id,
      content,
      ...(activeForm ? { activeForm } : {}),
      status: itemStatus,
      ...(priority === 'low' || priority === 'medium' || priority === 'high'
        ? { priority }
        : {}),
    } satisfies StructuredTodoItem)
  }

  return {
    itemId,
    status: 'completed',
    items,
  }
}

const createStructuredStreamPrefix = (provider: Provider, streamId: string) =>
  `${provider}:${streamId}:item:`

export const collectChangesSummaryFilesForStream = (
  messages: ChatMessage[],
  provider: Provider,
  streamId: string,
) => {
  const fileMap = new Map<string, { addedLines: number; removedLines: number }>()
  const streamPrefix = createStructuredStreamPrefix(provider, streamId)

  for (const message of messages) {
    if (!message.id.startsWith(streamPrefix)) {
      continue
    }

    const edits = parseStructuredEditsMessage(message)
    if (!edits) {
      continue
    }

    for (const file of edits.files) {
      const existing = fileMap.get(file.path)
      if (existing) {
        existing.addedLines += file.addedLines
        existing.removedLines += file.removedLines
      } else {
        fileMap.set(file.path, {
          addedLines: file.addedLines,
          removedLines: file.removedLines,
        })
      }
    }
  }

  return [...fileMap.entries()].map(([path, stats]) => ({
    path,
    ...stats,
  }))
}

export const parseStructuredAskUserMessage = (message: ChatMessage): StructuredAskUserMessage | null => {
  if (message.meta?.kind !== 'ask-user') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')

  if (!itemId) {
    return null
  }

  const parseOptions = (raw: unknown): StructuredAskUserOption[] => {
    if (!Array.isArray(raw)) {
      return []
    }
    return raw
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return null
        }
        const record = entry as Record<string, unknown>
        const label = readStructuredString(record, 'label')
        const description = readStructuredString(record, 'description') ?? ''
        return label ? { label, description } : null
      })
      .filter((opt): opt is StructuredAskUserOption => opt !== null)
  }

  const parseQuestionItem = (raw: unknown): StructuredAskUserQuestionItem | null => {
    if (typeof raw !== 'object' || raw === null) {
      return null
    }
    const record = raw as Record<string, unknown>
    const q = readStructuredString(record, 'question')
    const opts = parseOptions(record.options)
    if (!q || opts.length === 0) {
      return null
    }
    return {
      question: q,
      header: readStructuredString(record, 'header') ?? '',
      multiSelect: record.multiSelect === true,
      options: opts,
    }
  }

  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : null
  const parsedQuestions = rawQuestions
    ? rawQuestions
        .map(parseQuestionItem)
        .filter((q): q is StructuredAskUserQuestionItem => q !== null)
    : []

  // Legacy shape: single question at the top level.
  const topQuestion = readStructuredString(payload, 'question')
  const topOptions = parseOptions(payload.options)

  const questions: StructuredAskUserQuestionItem[] =
    parsedQuestions.length > 0
      ? parsedQuestions
      : topQuestion && topOptions.length > 0
        ? [
            {
              question: topQuestion,
              header: readStructuredString(payload, 'header') ?? '',
              multiSelect: payload.multiSelect === true,
              options: topOptions,
            },
          ]
        : []

  if (questions.length === 0) {
    return null
  }

  const first = questions[0]!

  return {
    itemId,
    status: 'completed',
    question: first.question,
    header: first.header,
    multiSelect: first.multiSelect,
    options: first.options,
    questions,
  }
}

const structuredAgentTools = new Set<StreamAgentTool>([
  'spawnAgent',
  'sendInput',
  'resumeAgent',
  'wait',
  'closeAgent',
])

const structuredAgentCallStatuses = new Set<StreamAgentToolCallStatus>([
  'inProgress',
  'completed',
  'failed',
])

const structuredAgentStatuses = new Set<StructuredAgentEntry['status']>([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
])

export const parseStructuredAgentsMessage = (message: ChatMessage): StructuredAgentsMessage | null => {
  if (message.meta?.kind !== 'agents') {
    return null
  }

  const payload = readStructuredData(message)

  if (!payload) {
    return null
  }

  const itemId = readStructuredString(payload, 'itemId')
  const status = readStructuredString(payload, 'status')
  const tool = readStructuredString(payload, 'tool')
  const callStatus = readStructuredString(payload, 'callStatus')
  const rawAgents = payload.agents

  if (
    !itemId ||
    status !== 'completed' ||
    !tool ||
    !structuredAgentTools.has(tool as StreamAgentTool) ||
    !callStatus ||
    !structuredAgentCallStatuses.has(callStatus as StreamAgentToolCallStatus) ||
    !Array.isArray(rawAgents)
  ) {
    return null
  }

  const agents = rawAgents
    .map((entry): StructuredAgentEntry | null => {
      if (typeof entry !== 'object' || entry === null) {
        return null
      }
      const record = entry as Record<string, unknown>
      const threadId = readStructuredString(record, 'threadId')
      const entryStatus = readStructuredString(record, 'status') ?? 'pendingInit'

      if (!threadId || !structuredAgentStatuses.has(entryStatus as StructuredAgentEntry['status'])) {
        return null
      }

      return {
        threadId,
        ...(readStructuredString(record, 'nickname')
          ? { nickname: readStructuredString(record, 'nickname') }
          : {}),
        ...(readStructuredString(record, 'role')
          ? { role: readStructuredString(record, 'role') }
          : {}),
        status: entryStatus as StructuredAgentEntry['status'],
        message: readStructuredString(record, 'message') ?? null,
      }
    })
    .filter((entry): entry is StructuredAgentEntry => entry !== null)

  return {
    itemId,
    status: 'completed',
    tool: tool as StreamAgentTool,
    callStatus: callStatus as StreamAgentToolCallStatus,
    prompt: readStructuredString(payload, 'prompt') ?? null,
    model: readStructuredString(payload, 'model') ?? null,
    reasoningEffort: readStructuredString(payload, 'reasoningEffort') ?? null,
    agents,
  }
}

export const getAskUserAnswerKey = (message: ChatMessage) => {
  if (message.meta?.kind !== 'ask-user') {
    return message.id
  }

  const parsed = parseStructuredAskUserMessage(message)
  const firstQuestion = parsed?.questions[0]
  const questionSignature = firstQuestion
    ? JSON.stringify({
        question: firstQuestion.question,
        header: firstQuestion.header,
        multiSelect: firstQuestion.multiSelect,
        options: firstQuestion.options.map((option) => option.label),
      })
    : ''

  return `${message.id}:${parsed?.itemId ?? message.meta.itemId ?? ''}:${questionSignature}`
}

export const getToolGroupKey = (items: StructuredToolGroupItem[]): string =>
  items.length > 0 ? items[0]!.message.id : ''

export const getRenderableEntryId = (entry: RenderableMessage) =>
  entry.type === 'message' ? entry.message.id : getToolGroupKey(entry.items)

export const getTopVisibleRenderableEntryId = (
  messages: RenderableMessage[],
  isEntryVisibleAtTop: (entryId: string) => boolean,
) => {
  for (const entry of messages) {
    const entryId = getRenderableEntryId(entry)
    if (isEntryVisibleAtTop(entryId)) {
      return entryId
    }
  }

  return null
}

export const getLastRenderableUserMessageId = (messages: RenderableMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (entry?.type === 'message' && entry.message.role === 'user') {
      return entry.message.id
    }
  }

  return null
}

export type RestoredStickyUserAnchor = {
  stickyMessageId: string
  anchorEntryId: string
}

export const getRestoredStickyUserAnchor = (
  messages: RenderableMessage[],
): RestoredStickyUserAnchor | null => {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const entry = messages[index]
    const nextEntry = messages[index + 1]

    if (entry?.type === 'message' && entry.message.role === 'user' && nextEntry) {
      return {
        stickyMessageId: entry.message.id,
        anchorEntryId: getRenderableEntryId(nextEntry),
      }
    }
  }

  return null
}

export const getStickyRenderableUserMessageId = (
  messages: RenderableMessage[],
  topEntryId: string | null,
) => {
  if (!topEntryId) {
    return null
  }

  let previousStickyMessageId: string | null = null

  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index]!
    const hasFollowingRenderableEntry = index < messages.length - 1

    if (getRenderableEntryId(entry) === topEntryId) {
      if (entry.type === 'message' && entry.message.role === 'user') {
        return null
      }
      return previousStickyMessageId
    }

    if (entry.type === 'message' && entry.message.role === 'user' && hasFollowingRenderableEntry) {
      previousStickyMessageId = entry.message.id
    }
  }

  return previousStickyMessageId
}

const isEmptySkippableMessage = (message: ChatMessage) => {
  if (isHiddenCompactBoundaryMessage(message)) return true
  if (message.content.trim()) return false
  if (message.meta?.imageAttachments) return false

  const kind = message.meta?.kind
  if (kind === 'tool' || kind === 'command' || kind === 'edits' || kind === 'todo' || kind === 'agents') return true

  // Plain assistant messages with no content and no attachments are streaming
  // artifacts that should not render as empty bubbles.
  if (message.role === 'assistant' && !kind) return true

  return false
}

const mergeAdjacentAskUserMessages = (
  messages: ChatMessage[],
  startIndex: number,
): { merged: ChatMessage; nextIndex: number } | null => {
  const first = messages[startIndex]
  if (!first || first.meta?.kind !== 'ask-user') return null

  const firstParsed = parseStructuredAskUserMessage(first)
  if (!firstParsed) return null

  let lookahead = startIndex + 1
  const tail: ChatMessage[] = []

  while (lookahead < messages.length) {
    const next = messages[lookahead]!
    if (next.meta?.kind !== 'ask-user') break
    if (next.role !== first.role) break
    if (!parseStructuredAskUserMessage(next)) break
    tail.push(next)
    lookahead += 1
  }

  if (tail.length === 0) {
    return { merged: first, nextIndex: startIndex + 1 }
  }

  const mergedQuestions = [...firstParsed.questions]
  for (const msg of tail) {
    const parsed = parseStructuredAskUserMessage(msg)
    if (parsed) mergedQuestions.push(...parsed.questions)
  }

  const anchorPayload = {
    itemId: firstParsed.itemId,
    kind: 'ask-user' as const,
    status: 'completed' as const,
    question: mergedQuestions[0]!.question,
    header: mergedQuestions[0]!.header,
    multiSelect: mergedQuestions[0]!.multiSelect,
    options: mergedQuestions[0]!.options,
    questions: mergedQuestions,
  }

  const mergedMessage: ChatMessage = {
    ...first,
    meta: {
      ...first.meta!,
      structuredData: JSON.stringify(anchorPayload),
    },
  }

  return { merged: mergedMessage, nextIndex: lookahead }
}

export const buildRenderableMessages = (messages: ChatMessage[]): RenderableMessage[] => {
  const items: RenderableMessage[] = []
  let index = 0

  while (index < messages.length) {
    const currentMessage = messages[index]!
    const command = parseStructuredCommandMessage(currentMessage)
    const tool = parseStructuredToolMessage(currentMessage)
    const edits = parseStructuredEditsMessage(currentMessage)
    const todo = parseStructuredTodoMessage(currentMessage)
    const agents = parseStructuredAgentsMessage(currentMessage)

    if (!command && !tool && !edits) {
      if (todo || agents) {
        items.push({
          type: 'message',
          message: currentMessage,
        })
        index += 1
        continue
      }

      if (currentMessage.meta?.kind === 'ask-user') {
        const mergeResult = mergeAdjacentAskUserMessages(messages, index)
        if (mergeResult) {
          items.push({ type: 'message', message: mergeResult.merged })
          index = mergeResult.nextIndex
          continue
        }
      }

      if (!isEmptySkippableMessage(currentMessage)) {
        items.push({
          type: 'message',
          message: currentMessage,
        })
      }
      index += 1
      continue
    }

    const groupItems: StructuredToolGroupItem[] = []

    while (index < messages.length) {
      const msg = messages[index]!
      const cmd = parseStructuredCommandMessage(msg)
      const tl = parseStructuredToolMessage(msg)
      const ed = parseStructuredEditsMessage(msg)

      if (cmd) {
        groupItems.push({ kind: 'command', message: msg, data: cmd })
      } else if (tl) {
        groupItems.push({ kind: 'tool', message: msg, data: tl })
      } else if (ed) {
        groupItems.push({ kind: 'edits', message: msg, data: ed })
      } else if (isEmptySkippableMessage(msg)) {
        // Skip broken structured messages that failed to parse
        index += 1
        continue
      } else {
        break
      }

      index += 1
    }

    items.push({
      type: 'tool-group',
      items: groupItems,
    })
  }

  return items
}
