import type {
  StreamAgentEntry,
  StreamAgentsActivity,
  StreamAgentStatus,
} from '../shared/schema.js'

const maxPreviewItems = 6
const maxPreviewGraphemes = 240

type JsonRecord = Record<string, unknown>

type TrackedAgent = StreamAgentEntry & {
  parentThreadId?: string
  previewOrder: string[]
  previewByItemId: Map<string, string>
}

export type CodexAgentTrackerUpdate = {
  handled: boolean
  activity?: StreamAgentsActivity
  releaseDeferredRootCompletion?: boolean
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

const readStringPreserveWhitespace = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

const readRecord = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key]
  return isRecord(value) ? value : undefined
}

const normalizeWhitespace = (value: string) => value.split(/\s+/u).filter(Boolean).join(' ')

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const truncateUnicode = (value: string, limit = maxPreviewGraphemes) =>
  [...graphemeSegmenter.segment(value)]
    .slice(0, limit)
    .map((entry) => entry.segment)
    .join('')

const boundedSummary = (value: string) => {
  const normalized = normalizeWhitespace(truncateUnicode(value))
  return normalized || null
}

const readItemType = (item: JsonRecord) => readString(item, 'type')

const readPathForUi = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value
  }
  if (!isRecord(value)) {
    return undefined
  }
  return readString(value, 'path') ?? readString(value, 'value') ?? readString(value, 'display')
}

export const summarizeCodexAgentActivityItem = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null
  }

  const itemType = readItemType(value)
  switch (itemType) {
    case 'agentMessage':
    case 'plan':
      return boundedSummary(readStringPreserveWhitespace(value, 'text') ?? '')
    case 'reasoning': {
      const summary = Array.isArray(value.summary)
        ? value.summary.filter((entry): entry is string => typeof entry === 'string')
        : []
      return boundedSummary(summary.at(-1) ?? '')
    }
    case 'commandExecution': {
      const command = boundedSummary(readStringPreserveWhitespace(value, 'command') ?? '')
      return command ? boundedSummary(`$ ${command}`) : null
    }
    case 'fileChange':
      return boundedSummary(`Updated ${Array.isArray(value.changes) ? value.changes.length : 0} file(s)`)
    case 'mcpToolCall': {
      const server = readString(value, 'server')
      const tool = readString(value, 'tool')
      return server && tool ? boundedSummary(`MCP ${server}/${tool}`) : null
    }
    case 'dynamicToolCall': {
      const namespace = readString(value, 'namespace')
      const tool = readString(value, 'tool')
      return tool ? boundedSummary(`Tool ${namespace ? `${namespace}/` : ''}${tool}`) : null
    }
    case 'collabAgentToolCall': {
      const tool = readString(value, 'tool')
      const actions: Record<string, string> = {
        spawnAgent: 'Spawned an agent',
        sendInput: 'Sent input to an agent',
        resumeAgent: 'Resumed an agent',
        wait: 'Waited for an agent',
        closeAgent: 'Closed an agent',
      }
      return tool ? actions[tool] ?? null : null
    }
    case 'subAgentActivity': {
      const kind = readString(value, 'kind')
      const path = readString(value, 'agentPath')
      const actions: Record<string, string> = {
        started: 'Started',
        interacted: 'Contacted',
        interrupted: 'Interrupted',
      }
      return kind && path && actions[kind] ? boundedSummary(`${actions[kind]} ${path}`) : null
    }
    case 'webSearch': {
      const query = readString(value, 'query') ?? readString(readRecord(value, 'item'), 'query')
      return query ? boundedSummary(`Web search: ${query}`) : null
    }
    case 'imageView': {
      const path = readPathForUi(value.path)
      return path ? boundedSummary(`Viewed ${path}`) : null
    }
    case 'imageGeneration':
      return 'Generated an image'
    case 'enteredReviewMode':
      return 'Entered review mode'
    case 'exitedReviewMode':
      return 'Exited review mode'
    case 'contextCompaction':
      return 'Compacted context'
    case 'userMessage':
    case 'hookPrompt':
    case 'sleep':
    default:
      return null
  }
}

const isRunningStatus = (status: StreamAgentStatus) =>
  status === 'pendingInit' || status === 'running'

const mapTurnStatus = (turn: JsonRecord | undefined): StreamAgentStatus => {
  switch (readString(turn, 'status')) {
    case 'failed':
      return 'errored'
    case 'interrupted':
      return 'interrupted'
    case 'inProgress':
      return 'running'
    case 'completed':
    default:
      return 'completed'
  }
}

const mapThreadStatus = (status: JsonRecord | undefined): StreamAgentStatus => {
  switch (readString(status, 'type')) {
    case 'active':
      return 'running'
    case 'systemError':
      return 'errored'
    case 'notLoaded':
      return 'shutdown'
    case 'idle':
    default:
      return 'completed'
  }
}

export const createCodexAgentStatusTracker = ({
  rootThreadId: initialRootThreadId,
}: {
  rootThreadId?: string | null
} = {}) => {
  let rootThreadId = initialRootThreadId?.trim() || null
  let rootCompletionDeferred = false
  const order: string[] = []
  const agents = new Map<string, TrackedAgent>()

  const ensureAgent = (
    threadId: string,
    patch: Partial<Pick<TrackedAgent, 'nickname' | 'role' | 'path' | 'parentThreadId' | 'status'>> = {},
  ) => {
    let agent = agents.get(threadId)
    if (!agent) {
      order.push(threadId)
      agent = {
        threadId,
        status: 'pendingInit',
        previewOrder: [],
        previewByItemId: new Map(),
      }
      agents.set(threadId, agent)
    }

    if (patch.nickname) agent.nickname = patch.nickname
    if (patch.role) agent.role = patch.role
    if (patch.path) agent.path = patch.path
    if (patch.parentThreadId) agent.parentThreadId = patch.parentThreadId
    if (patch.status) agent.status = patch.status
    return agent
  }

  const publicAgent = (agent: TrackedAgent): StreamAgentEntry => ({
    threadId: agent.threadId,
    ...(agent.nickname ? { nickname: agent.nickname } : {}),
    ...(agent.role ? { role: agent.role } : {}),
    ...(agent.path ? { path: agent.path } : {}),
    status: agent.status,
    ...(agent.message !== undefined ? { message: agent.message } : {}),
    activity: agent.previewOrder
      .map((itemId) => agent.previewByItemId.get(itemId))
      .filter((entry): entry is string => Boolean(entry)),
  })

  const snapshot = (): StreamAgentsActivity => ({
    itemId: `agent-status:${rootThreadId ?? 'pending'}`,
    kind: 'agents',
    status: 'completed',
    view: 'status',
    agents: order
      .map((threadId) => agents.get(threadId))
      .filter((agent): agent is TrackedAgent =>
        agent !== undefined && Boolean(agent.path) && isRunningStatus(agent.status))
      .map(publicAgent),
  })

  const hasRunningAgents = () =>
    order.some((threadId) => {
      const agent = agents.get(threadId)
      return Boolean(agent && isRunningStatus(agent.status))
    })

  const updatePreview = (agent: TrackedAgent, item: JsonRecord) => {
    const itemId = readString(item, 'id')
    const summary = summarizeCodexAgentActivityItem(item)
    if (!itemId || !summary) {
      return false
    }

    agent.previewOrder = agent.previewOrder.filter((candidate) => candidate !== itemId)
    agent.previewOrder.push(itemId)
    agent.previewByItemId.set(itemId, summary)
    while (agent.previewOrder.length > maxPreviewItems) {
      const removed = agent.previewOrder.shift()
      if (removed) agent.previewByItemId.delete(removed)
    }
    return true
  }

  const settleUpdate = (handled: boolean, changed: boolean): CodexAgentTrackerUpdate => {
    const releaseDeferredRootCompletion = rootCompletionDeferred && !hasRunningAgents()
    if (releaseDeferredRootCompletion) {
      rootCompletionDeferred = false
    }
    return {
      handled,
      ...(changed ? { activity: snapshot() } : {}),
      ...(releaseDeferredRootCompletion ? { releaseDeferredRootCompletion: true } : {}),
    }
  }

  const handleNotification = (value: unknown): CodexAgentTrackerUpdate => {
    if (!isRecord(value)) {
      return { handled: false }
    }

    const method = readString(value, 'method')
    const params = readRecord(value, 'params')
    if (!method || !params) {
      return { handled: false }
    }

    if (method === 'thread/started') {
      const thread = readRecord(params, 'thread')
      const threadId = readString(thread, 'id')
      const parentThreadId = readString(thread, 'parentThreadId')
      if (!threadId) {
        return { handled: false }
      }

      if (!parentThreadId) {
        rootThreadId ??= threadId
        return { handled: false }
      }

      if (parentThreadId !== rootThreadId && !agents.has(parentThreadId)) {
        return { handled: false }
      }

      const status = readRecord(thread, 'status')
      ensureAgent(threadId, {
        parentThreadId,
        nickname: readString(thread, 'agentNickname'),
        role: readString(thread, 'agentRole'),
        status: status ? mapThreadStatus(status) : 'pendingInit',
      })
      return settleUpdate(true, true)
    }

    const sourceThreadId = readString(params, 'threadId')
    const item = readRecord(params, 'item')
    const itemType = item ? readItemType(item) : undefined

    if (item && itemType === 'subAgentActivity') {
      const agentThreadId = readString(item, 'agentThreadId')
      const path = readString(item, 'agentPath')
      const kind = readString(item, 'kind')
      if (!agentThreadId) {
        return { handled: sourceThreadId !== rootThreadId }
      }

      if (
        sourceThreadId &&
        sourceThreadId !== rootThreadId &&
        !agents.has(sourceThreadId)
      ) {
        return { handled: true }
      }

      const agent = ensureAgent(agentThreadId, {
        path,
        status: kind === 'interrupted' ? 'interrupted' : 'running',
      })
      updatePreview(agent, item)
      return settleUpdate(sourceThreadId !== rootThreadId, true)
    }

    const isNonRootThread = Boolean(sourceThreadId && rootThreadId && sourceThreadId !== rootThreadId)
    const trackedAgent = sourceThreadId ? agents.get(sourceThreadId) : undefined
    if (!trackedAgent) {
      return { handled: isNonRootThread }
    }
    const agent = trackedAgent

    switch (method) {
      case 'turn/started':
        agent.status = 'running'
        return settleUpdate(true, true)
      case 'turn/completed': {
        const turn = readRecord(params, 'turn')
        agent.status = mapTurnStatus(turn)
        agent.message = readString(readRecord(turn, 'error'), 'message') ?? null
        return settleUpdate(true, true)
      }
      case 'thread/status/changed':
        agent.status = mapThreadStatus(readRecord(params, 'status'))
        return settleUpdate(true, true)
      case 'thread/closed':
        agent.status = 'shutdown'
        return settleUpdate(true, true)
      case 'item/started':
      case 'item/completed':
        agent.status = 'running'
        return settleUpdate(true, item ? updatePreview(agent, item) : false)
      default:
        return { handled: true }
    }
  }

  return {
    handleNotification,
    snapshot,
    hasRunningAgents,
    setRootThreadId(threadId: string) {
      if (threadId.trim()) rootThreadId = threadId.trim()
    },
    getRootThreadId: () => rootThreadId,
    getAgent: (threadId: string) => {
      const agent = agents.get(threadId)
      return agent ? publicAgent(agent) : undefined
    },
    isChildThread: (threadId: string | null | undefined) => Boolean(threadId && agents.has(threadId)),
    markRootTurnCompleted: (): 'finish' | 'defer' => {
      if (!hasRunningAgents()) {
        rootCompletionDeferred = false
        return 'finish'
      }
      rootCompletionDeferred = true
      return 'defer'
    },
  }
}

export type CodexAgentStatusTracker = ReturnType<typeof createCodexAgentStatusTracker>
