import type { ChatMessage, Provider, StreamAgentEntry, StreamAgentTool, StreamAgentToolCallStatus, StreamEditedFile, StreamTodoItem } from '../../shared/schema'
import { isHiddenCompactBoundaryMessage } from './chat-card-compaction'

export type StructuredCommandMessage = {
  itemId: string
  status: 'in_progress' | 'completed' | 'failed' | 'declined'
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
    (status !== 'in_progress' && status !== 'completed' && status !== 'failed' && status !== 'declined')
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
  const text = sanitizeLeakedCallMarkerLines(readStructuredString(payload, 'text') ?? '')

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

const structuredPatchOmittedReasons = new Set<NonNullable<StreamEditedFile['patchOmittedReason']>>([
  'file-too-large',
  'baseline-unavailable',
  'detail-file-limit',
  'patch-budget',
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
  const patchOmittedReason = readStructuredString(record, 'patchOmittedReason')

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
    ...(patchOmittedReason && structuredPatchOmittedReasons.has(
      patchOmittedReason as NonNullable<StreamEditedFile['patchOmittedReason']>,
    )
      ? {
          patchOmittedReason:
            patchOmittedReason as NonNullable<StreamEditedFile['patchOmittedReason']>,
        }
      : {}),
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
  const fileMap = new Map<string, {
    addedLines: number
    removedLines: number
    patchOmittedReason?: StreamEditedFile['patchOmittedReason']
    hasDetailedPatch: boolean
  }>()
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
        if (!file.patchOmittedReason) {
          existing.hasDetailedPatch = true
          existing.patchOmittedReason = undefined
        } else if (!existing.hasDetailedPatch) {
          existing.patchOmittedReason = file.patchOmittedReason
        }
      } else {
        fileMap.set(file.path, {
          addedLines: file.addedLines,
          removedLines: file.removedLines,
          patchOmittedReason: file.patchOmittedReason,
          hasDetailedPatch: !file.patchOmittedReason,
        })
      }
    }
  }

  return [...fileMap.entries()].map(([path, stats]) => ({
    path,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
    ...(stats.patchOmittedReason ? { patchOmittedReason: stats.patchOmittedReason } : {}),
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

export const getRenderableEntryStructureKey = (entries: RenderableMessage[]) =>
  entries.map(getRenderableEntryId).join('\u001f')

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
  if (sanitizeLeakedClaudeCallMarkerContent(message).trim()) return false
  if (message.meta?.imageAttachments) return false

  const kind = message.meta?.kind
  if (kind === 'tool' || kind === 'command' || kind === 'edits' || kind === 'todo' || kind === 'agents') return true

  // Plain assistant messages with no content and no attachments are streaming
  // artifacts that should not render as empty bubbles.
  if (message.role === 'assistant' && !kind) return true

  return false
}

const isLeakedCallMarkerLine = (line: string) => {
  const normalized = line.trim().toLowerCase()
  return normalized === 'call' || normalized === 'call:'
}

const isClaudeProtocolMarkerLine = (line: string) => {
  const normalized = line.trim().toLowerCase()
  return isLeakedCallMarkerLine(line) || normalized === 'court'
}

const isAmbiguousClaudeProtocolMarkerLine = (line: string) => {
  const normalized = line.trim().toLowerCase()
  return (
    isClaudeProtocolMarkerLine(line) ||
    normalized === 'course' ||
    normalized === 'card' ||
    normalized === '课' ||
    // The gateway can also double or triple the marker word (`cardcard`).
    /^(?:call:?|court|course|count|card|课){2,3}$/.test(normalized)
  )
}

// Strips tool-call XML that Claude typed as text — including the
// gateway-mangled variant where the leading `<` was eaten and the internal
// namespace leaks (`antml:invoke name="...">`), with an intact or mangled
// (`</invoke">`) close. Backtick-prefixed mentions stay untouched, and the
// antml form additionally requires ` name="` so prose discussing the marker
// itself is never swallowed. Shared by the message sanitize chain here and the
// markdown renderer fallback.
export const stripLeakedClaudeToolXml = (content: string) =>
  content
    .replace(/(?<!`)<function_calls>\s*<invoke(?:\s+[^>\n]*?)?>[\s\S]*?(?:<\/invoke>\s*<\/function_calls>|$)/gi, '')
    .replace(/(?<!`)<invoke(?:\s+[^>\n]*?)?>[\s\S]*?(?:<\/invoke>|$)/gi, '')
    .replace(/(?<!`)<?antml:invoke\s+name="[\s\S]*?(?:<\/invoke[^\n<]*?>|$)/gi, '')
    .replace(/(?<!`)<parameter\s+[^>\n]*?>[\s\S]*?(?:<\/parameter>|$)/gi, '')

// Streaming re-renders call the sanitize/detection chain below on every
// history message for every delta, and each call line-splits and regex-scans
// the full content. History message contents never change, so a bounded
// content-keyed cache turns the per-delta cost from O(total session chars)
// into O(streaming tail chars). Without it, 5 panes × long sessions overload
// the renderer main thread (the stuck-pane bug family).
const createBoundedContentCache = <V>(limit: number) => {
  const cache = new Map<string, V>()
  return (key: string, compute: () => V): V => {
    const hit = cache.get(key)
    if (hit !== undefined || cache.has(key)) return hit as V
    const value = compute()
    if (cache.size >= limit) cache.clear()
    cache.set(key, value)
    return value
  }
}

const sanitizeMarkerLines = (
  content: string,
  isMarkerLine: (line: string) => boolean,
) => {
  const lines = content.split(/\r?\n/)
  let inFence = false
  const cleanedLines = lines.filter((line) => {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence
      return true
    }
    return inFence || !isMarkerLine(line)
  })
  if (cleanedLines.length === lines.length) {
    return content
  }

  return cleanedLines.join('\n').trim()
}

const sanitizeLeakedCallMarkerLines = (content: string) =>
  sanitizeMarkerLines(content, isLeakedCallMarkerLine)

const sanitizeClaudeProtocolMarkerLines = (
  content: string,
  options: { includeAmbiguousMarkers?: boolean } = {},
) =>
  sanitizeMarkerLines(
    content,
    options.includeAmbiguousMarkers
      ? isAmbiguousClaudeProtocolMarkerLine
      : isClaudeProtocolMarkerLine,
  )

const stripStandaloneEmptyMarkdownBulletResidue = (content: string) => {
  const lines = content.split(/\r?\n/)
  let inFence = false
  const cleaned: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    const isFence = /^(```|~~~)/.test(trimmed)

    if (isFence) {
      cleaned.push(line)
      inFence = !inFence
      continue
    }

    if (!inFence && /^[-*]$/.test(trimmed)) {
      continue
    }

    cleaned.push(line)
  }

  return cleaned.join('\n').trim()
}

const stripTrailingEmptyMarkdownFenceResidue = (content: string) => {
  const lines = content.split(/\r?\n/)
  let openFence: { marker: '`' | '~'; length: number; lineIndex: number } | null = null

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = lines[lineIndex]?.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/)
    if (!match) continue

    const fence = match[1]!
    const marker = fence[0] as '`' | '~'
    const suffix = match[2] ?? ''

    if (!openFence) {
      openFence = { marker, length: fence.length, lineIndex }
      continue
    }

    if (
      marker === openFence.marker &&
      fence.length >= openFence.length &&
      suffix.trim().length === 0
    ) {
      openFence = null
    }
  }

  if (
    !openFence ||
    lines.slice(openFence.lineIndex + 1).some((line) => line.trim().length > 0)
  ) {
    return content
  }

  return lines.slice(0, openFence.lineIndex).join('\n').trim()
}

const stripTrailingClaudeProtocolResidueLines = (
  content: string,
  options: { includeAmbiguousMarkers?: boolean } = {},
) => {
  const markerPattern = options.includeAmbiguousMarkers
    ? /(?:[ \t]*(?:\r?\n|^)[ \t]*(?:call:?|court|course|card|课){1,3}[ \t]*(?:\r?\n)?)+$/iu
    : /(?:[ \t]*(?:\r?\n|^)[ \t]*(?:call:?|court)[ \t]*(?:\r?\n)?)+$/iu

  return content
    .replace(markerPattern, '')
    .replace(/(?:[ \t]*(?:\r?\n|^)[ \t]*count[ \t]*(?:\r?\n)?)+$/i, '')
    .trim()
}

const canContainLeakedClaudeCallMarker = (message: ChatMessage) => {
  if (message.role !== 'assistant') return false
  if (message.meta?.kind) return false
  if (message.meta?.imageAttachments) return false

  return true
}

const sanitizedCallMarkerContentCache = createBoundedContentCache<string>(400)

const sanitizeLeakedClaudeCallMarkerContent = (
  message: ChatMessage,
  options: { includeAmbiguousClaudeMarkers?: boolean } = {},
) => {
  if (!canContainLeakedClaudeCallMarker(message)) return message.content

  if (message.meta?.provider !== 'claude') {
    return sanitizedCallMarkerContentCache(`g ${message.content}`, () =>
      stripTrailingEmptyMarkdownFenceResidue(
        stripStandaloneEmptyMarkdownBulletResidue(
          sanitizeLeakedCallMarkerLines(message.content),
        ),
      ),
    )
  }

  const variant = options.includeAmbiguousClaudeMarkers ? 'a' : 'c'
  return sanitizedCallMarkerContentCache(`${variant} ${message.content}`, () => {
    const withoutCallMarkers = stripTrailingEmptyMarkdownFenceResidue(
      stripStandaloneEmptyMarkdownBulletResidue(
        sanitizeClaudeProtocolMarkerLines(stripLeakedClaudeToolXml(message.content), {
          includeAmbiguousMarkers: options.includeAmbiguousClaudeMarkers,
        }),
      ),
    )

    return stripTrailingEmptyMarkdownFenceResidue(
      stripTrailingClaudeProtocolResidueLines(withoutCallMarkers, {
        includeAmbiguousMarkers: options.includeAmbiguousClaudeMarkers,
      }),
    )
  })
}


const normalizeLeakedClaudeCallMarkerMessage = (
  message: ChatMessage,
  options: { includeAmbiguousClaudeMarkers?: boolean } = {},
): ChatMessage => {
  const content = sanitizeLeakedClaudeCallMarkerContent(message, options)

  return content === message.content ? message : { ...message, content }
}

const isClaudeStructuredActivityMessage = (message: ChatMessage | undefined) => {
  if (!message) return false
  if (message.meta?.provider !== 'claude') return false

  const kind = message.meta?.kind
  return kind === 'tool' || kind === 'command' || kind === 'edits'
}

const isClaudeAssistantTextMessage = (message: ChatMessage | undefined) => {
  if (!message) return false
  if (message.role !== 'assistant') return false
  if (message.meta?.provider !== 'claude') return false
  if (message.meta?.kind) return false

  return true
}

const isStandaloneClaudeCountResidueNearToolActivity = (
  message: ChatMessage,
  previous: ChatMessage | undefined,
  next: ChatMessage | undefined,
) => {
  if (message.role !== 'assistant') return false
  if (message.meta?.kind) return false
  if (message.meta?.imageAttachments) return false
  if (message.content.trim().toLowerCase() !== 'count') return false

  return (
    message.meta?.provider === 'claude' ||
    isClaudeStructuredActivityMessage(previous) ||
    isClaudeStructuredActivityMessage(next) ||
    isClaudeAssistantTextMessage(previous) ||
    isClaudeAssistantTextMessage(next)
  )
}

// Leaked protocol markers are single short words (call/court/course/count/card/课…),
// so any lone word wedged between two Claude tool activities is treated as residue
// instead of growing the enumerated marker list one leak at a time. A real assistant
// reply is never a bare word sandwiched by tool cards; final one-word replies only
// *follow* tool activity and stay visible.
const isStandaloneProtocolResidueWordContent = (content: string) => {
  const normalized = content.trim()
  return /^[a-zA-Z]{2,12}$/.test(normalized) || /^[一-鿿]$/.test(normalized)
}

const isStandaloneClaudeResidueWordBetweenToolActivity = (
  message: ChatMessage,
  previous: ChatMessage | undefined,
  next: ChatMessage | undefined,
) => {
  if (message.role !== 'assistant') return false
  if (message.meta?.kind) return false
  if (message.meta?.imageAttachments) return false
  if (message.meta?.provider && message.meta.provider !== 'claude') return false
  if (!isStandaloneProtocolResidueWordContent(message.content)) return false

  return (
    isClaudeStructuredActivityMessage(previous) &&
    isClaudeStructuredActivityMessage(next)
  )
}

const isStandaloneClaudeProtocolResidueNearToolActivity = (
  message: ChatMessage,
  previous: ChatMessage | undefined,
  next: ChatMessage | undefined,
) =>
  isStandaloneClaudeCountResidueNearToolActivity(message, previous, next) ||
  isStandaloneClaudeResidueWordBetweenToolActivity(message, previous, next)

const retryChatterContentCache = createBoundedContentCache<boolean>(400)

// Retry chatter is a short apologize-and-resend fragment. Long-form prose is
// never chatter even when it mentions tooling keywords ("重试工具" in an
// essay), and the length gate also bounds the per-delta cost of scanning a
// still-streaming tail message that the content cache can never hit.
const maxClaudeTypedToolRetryChatterChars = 4096
const maxClaudeTypedToolApologyFragmentChars = 256

const isClaudeTypedToolRetryChatterContent = (content: string) => {
  if (content.length > maxClaudeTypedToolRetryChatterChars) return false
  return retryChatterContentCache(content, () => computeClaudeTypedToolRetryChatterContent(content))
}

const computeClaudeTypedToolRetryChatterContent = (content: string) => {
  const normalized = sanitizeClaudeProtocolMarkerLines(content, {
    includeAmbiguousMarkers: true,
  }).replace(/\s+/g, ' ').trim()

  if (!normalized) return false

  return (
    /工具.{0,160}(?:格式|坏|重新|重试|再发|解析|失败|改用|触发|避免|反复)/iu.test(normalized) ||
    /错误.{0,80}裸.{0,80}(?:<invoke|invoke).{0,80}(?:文本格式|格式)?/iu.test(normalized) ||
    /(?:<invoke|invoke).{0,80}(?:文本格式|格式).{0,80}(?:错误|裸)/iu.test(normalized) ||
    /(?:重新|重试|再发|改用).{0,120}工具/iu.test(normalized) ||
    /(?:edit|write|tool\s+call|tool).{0,180}(?:malformed|format|parse|parsing|retry|again|failed|failure|broken|resend|re-send|fallback|fall\s+back|switch)/iu.test(
      normalized,
    ) ||
    /(?:retry|resend|re-send|fallback|fall\s+back|switch).{0,120}(?:edit|write|tool\s+call|tool)/iu.test(
      normalized,
    )
  )
}

const apologyFragmentContentCache = createBoundedContentCache<boolean>(400)

const isClaudeTypedToolApologyFragmentContent = (content: string) => {
  if (content.length > maxClaudeTypedToolApologyFragmentChars) return false
  return apologyFragmentContentCache(content, () => {
    const normalized = sanitizeClaudeProtocolMarkerLines(content, {
      includeAmbiguousMarkers: true,
    }).replace(/\s+/g, ' ').trim()
    return /^抱歉[，,]?\s*我的?$/.test(normalized) || /^sorry[,\s]+my$/i.test(normalized)
  })
}

const hasClaudeStructuredActivityNearby = (
  messages: ChatMessage[],
  index: number,
  distance: number,
) => {
  for (let offset = 1; offset <= distance; offset += 1) {
    if (
      isClaudeStructuredActivityMessage(messages[index - offset]) ||
      isClaudeStructuredActivityMessage(messages[index + offset])
    ) {
      return true
    }
  }

  return false
}

const hasClaudeTypedToolRetryChatterNearby = (
  messages: ChatMessage[],
  index: number,
  distance: number,
) => {
  for (let offset = 1; offset <= distance; offset += 1) {
    const previous = messages[index - offset]
    const next = messages[index + offset]
    if (
      (previous && isClaudeTypedToolRetryChatterContent(previous.content)) ||
      (next && isClaudeTypedToolRetryChatterContent(next.content))
    ) {
      return true
    }
  }

  return false
}

const ambiguousMarkerLineCache = createBoundedContentCache<boolean>(400)

const contentHasAmbiguousClaudeProtocolMarkerLine = (content: string) =>
  ambiguousMarkerLineCache(content, () =>
    content.split(/\r?\n/).some((line) => isAmbiguousClaudeProtocolMarkerLine(line)),
  )

const isAmbiguousClaudeProtocolMarkerResidueNearToolActivity = (
  messages: ChatMessage[],
  index: number,
) => {
  const message = messages[index]
  if (!message) return false
  if (message.role !== 'assistant') return false
  if (message.meta?.provider !== 'claude') return false
  if (message.meta?.kind) return false
  if (message.meta?.imageAttachments) return false

  if (!contentHasAmbiguousClaudeProtocolMarkerLine(message.content)) {
    return false
  }

  return (
    hasClaudeStructuredActivityNearby(messages, index, 1) ||
    hasClaudeTypedToolRetryChatterNearby(messages, index, 2)
  )
}

const isClaudeTypedToolRetryChatterNearToolActivity = (
  messages: ChatMessage[],
  index: number,
) => {
  const message = messages[index]
  if (!message) return false
  if (message.role !== 'assistant') return false
  if (message.meta?.kind) return false
  if (message.meta?.imageAttachments) return false

  if (isClaudeTypedToolRetryChatterContent(message.content)) {
    return hasClaudeStructuredActivityNearby(messages, index, 2)
  }

  if (isClaudeTypedToolApologyFragmentContent(message.content)) {
    return (
      hasClaudeTypedToolRetryChatterNearby(messages, index, 1) &&
      hasClaudeStructuredActivityNearby(messages, index, 3)
    )
  }

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
    const isTypedToolRetryChatter = isClaudeTypedToolRetryChatterNearToolActivity(messages, index)
    const hasAmbiguousProtocolMarkerResidue =
      isAmbiguousClaudeProtocolMarkerResidueNearToolActivity(messages, index)
    const currentMessage = normalizeLeakedClaudeCallMarkerMessage(messages[index]!, {
      includeAmbiguousClaudeMarkers:
        isTypedToolRetryChatter || hasAmbiguousProtocolMarkerResidue,
    })

    const command = parseStructuredCommandMessage(currentMessage)
    const tool = parseStructuredToolMessage(currentMessage)
    const edits = parseStructuredEditsMessage(currentMessage)
    const todo = parseStructuredTodoMessage(currentMessage)
    const agents = parseStructuredAgentsMessage(currentMessage)

    if (!command && !tool && !edits) {
      if (isStandaloneClaudeProtocolResidueNearToolActivity(currentMessage, messages[index - 1], messages[index + 1])) {
        index += 1
        continue
      }
      if (isTypedToolRetryChatter) {
        index += 1
        continue
      }

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
      const shouldSkipTypedToolRetryChatter = isClaudeTypedToolRetryChatterNearToolActivity(messages, index)
      const hasAmbiguousProtocolMarkerResidue =
        isAmbiguousClaudeProtocolMarkerResidueNearToolActivity(messages, index)
      const msg = normalizeLeakedClaudeCallMarkerMessage(messages[index]!, {
        includeAmbiguousClaudeMarkers:
          shouldSkipTypedToolRetryChatter || hasAmbiguousProtocolMarkerResidue,
      })
      const cmd = parseStructuredCommandMessage(msg)
      const tl = parseStructuredToolMessage(msg)
      const ed = parseStructuredEditsMessage(msg)

      if (cmd) {
        groupItems.push({ kind: 'command', message: msg, data: cmd })
      } else if (tl) {
        groupItems.push({ kind: 'tool', message: msg, data: tl })
      } else if (ed) {
        groupItems.push({ kind: 'edits', message: msg, data: ed })
      } else if (
        isEmptySkippableMessage(msg) ||
        isStandaloneClaudeProtocolResidueNearToolActivity(msg, messages[index - 1], messages[index + 1]) ||
        shouldSkipTypedToolRetryChatter
      ) {
        // Skip broken structured messages that failed to parse, plus Claude
        // protocol residue that can appear between adjacent tool groups.
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
