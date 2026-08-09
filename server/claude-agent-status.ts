import type {
  AppLanguage,
  StreamAgentEntry,
  StreamAgentsActivity,
  StreamAgentStatus,
} from '../shared/schema.js'

// 症状：Claude 派发子代理后卡片只剩一个通用计时器，用户无法判断跑到哪一步、是否卡住。
// 根因：2026-08-09 实测 claude 2.1.206 的 stream-json stdout（168 行）证明 CLI 在顶层
//       主动播报 system:task_started / task_progress / task_updated / task_notification，
//       字段含 subagent_type、当前动作、last_tool_name、usage 与终态；宿主一行都没接。
// 被否决：解析 parent_tool_use_id 非空的 sidechain 行自建工具状态机——同一次派发只有 7 条
//         sidechain 且需还原完整消息体，而 task_progress 已是 CLI 归纳好的进度摘要。
//         详见 docs/specs/claude-subagent-progress/design.md。

const maxPreviewItems = 6

type JsonRecord = Record<string, unknown>

type TrackedAgent = StreamAgentEntry & {
  activity: string[]
  startedAt: number
}

// 症状：用户报「面板一直没动」——整轮已跑 26 分钟，三条进度还停在 3.3s / 10.7s。
// 根因：2026-08-09 实测 CLI 的 task_progress 只在子代理"完成一次工具调用"时发；子代理
//       执行一条长命令期间整整 155 秒零事件（39.6s → 195.1s）。面板忠实反映最后一次
//       心跳，看起来就像死了。
// 被否决：静默超时就清空面板——子代理其实活着，清掉等于谎报完成。改为本地推算一行已运行
//         时长，由 providers 的周期重发驱动它走动。前缀是用户可见文本，不能用内部标记。
export const claudeAgentElapsedPrefix = '⏳'

type ClaudeAgentStatusTrackerOptions = {
  now?: () => number
  language?: AppLanguage
}

export type ClaudeAgentTrackerUpdate = {
  handled: boolean
  activity?: StreamAgentsActivity
}

// 前缀必须是 `agent-status:`：src/codex-agent-status-slash.ts 靠它回溯最近一次子代理快照，
// 换成别的前缀会让 /agents 斜杠命令在 Claude 会话里退化成模糊 fallback。
const claudeAgentStatusItemId = 'agent-status:claude'

const subAgentSubtypes = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

const readRecord = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key]
  return isRecord(value) ? value : undefined
}

const readFiniteNumber = (record: JsonRecord | null | undefined, key: string) => {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// CLI 只给终态字符串，未来新增的终态不能让子代理永远挂在"运行中"，因此未知终态收敛为 completed。
const mapTerminalStatus = (status: string | undefined): StreamAgentStatus => {
  switch (status) {
    case 'failed':
    case 'error':
    case 'errored':
      return 'errored'
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
      return 'interrupted'
    case 'in_progress':
    case 'running':
    case 'pending':
      return 'running'
    default:
      return 'completed'
  }
}

const isRunningStatus = (status: StreamAgentStatus) =>
  status === 'pendingInit' || status === 'running'

// 症状：一条普通的后台命令会在「正在运行的子智能体」面板里冒充成一个子代理。
// 根因：2026-08-09 实测 CLI 用同一套 system:task_* 上报后台 shell —— 后台命令是
//       task_type=local_bash 且不带 subagent_type，子代理是 task_type=local_agent
//       且带 subagent_type（如 Explore）。
// 用 includes('agent') 而非全等 local_agent：Agent 工具的 remote 隔离模式会带别的
// agent 前缀，全等会把远程子代理整类漏掉。
const looksLikeSubAgentTask = (event: JsonRecord) => {
  const taskType = readString(event, 'task_type')
  if (taskType !== undefined) {
    return taskType.includes('agent')
  }
  // 心跳事件不带 task_type，只能靠 subagent_type 认领。
  return readString(event, 'subagent_type') !== undefined
}

const formatDuration = (durationMs: number | undefined) => {
  if (durationMs === undefined || durationMs < 0) {
    return undefined
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`
  }
  const seconds = durationMs / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds % 60)}s`
}

export const formatClaudeAgentProgressLine = (event: unknown): string | null => {
  if (!isRecord(event)) {
    return null
  }

  const description = readString(event, 'description')
  if (!description) {
    return null
  }

  const usage = readRecord(event, 'usage')
  const segments = [description]

  const toolName = readString(event, 'last_tool_name')
  if (toolName) {
    segments.push(toolName)
  }

  const toolUses = readFiniteNumber(usage, 'tool_uses')
  if (toolUses !== undefined && toolUses > 0) {
    segments.push(`${toolUses} ${toolUses === 1 ? 'tool' : 'tools'}`)
  }

  const duration = formatDuration(readFiniteNumber(usage, 'duration_ms'))
  if (duration) {
    segments.push(duration)
  }

  return segments.join(' · ')
}

export const createClaudeAgentStatusTracker = ({
  now = () => Date.now(),
  language = 'zh-CN',
}: ClaudeAgentStatusTrackerOptions = {}) => {
  const order: string[] = []
  const agents = new Map<string, TrackedAgent>()

  const ensureAgent = (
    taskId: string,
    patch: Partial<Pick<TrackedAgent, 'nickname' | 'role' | 'status'>> = {},
  ) => {
    let agent = agents.get(taskId)
    if (!agent) {
      order.push(taskId)
      agent = { threadId: taskId, status: 'running', activity: [], startedAt: now() }
      agents.set(taskId, agent)
    }

    if (patch.nickname) agent.nickname = patch.nickname
    if (patch.role) agent.role = patch.role
    if (patch.status) agent.status = patch.status
    return agent
  }

  const formatElapsed = (startedAt: number) => {
    const elapsedMs = Math.max(0, now() - startedAt)
    const totalSeconds = Math.floor(elapsedMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    const duration = language === 'en'
      ? `${minutes > 0 ? `${minutes}m` : ''}${seconds}s`
      : `${minutes > 0 ? `${minutes}分` : ''}${seconds}秒`
    return `${claudeAgentElapsedPrefix} ${language === 'en' ? 'running' : '已运行'} ${duration}`
  }

  const publicAgent = (agent: TrackedAgent): StreamAgentEntry => ({
    threadId: agent.threadId,
    ...(agent.nickname ? { nickname: agent.nickname } : {}),
    ...(agent.role ? { role: agent.role } : {}),
    status: agent.status,
    ...(agent.message !== undefined ? { message: agent.message } : {}),
    activity: [...agent.activity, ...(isRunningStatus(agent.status) ? [formatElapsed(agent.startedAt)] : [])],
  })

  // itemId 固定：整轮内就地更新同一张卡片，否则每个进度心跳都会新开一张卡把聊天流冲垮。
  const snapshot = (): StreamAgentsActivity => ({
    itemId: claudeAgentStatusItemId,
    kind: 'agents',
    status: 'completed',
    view: 'status',
    agents: order
      .map((taskId) => agents.get(taskId))
      .filter((agent): agent is TrackedAgent => agent !== undefined && isRunningStatus(agent.status))
      .map(publicAgent),
  })

  const hasRunningAgents = () =>
    order.some((taskId) => {
      const agent = agents.get(taskId)
      return Boolean(agent && isRunningStatus(agent.status))
    })

  const pushPreview = (agent: TrackedAgent, line: string) => {
    agent.activity.push(line)
    while (agent.activity.length > maxPreviewItems) {
      agent.activity.shift()
    }
  }

  const handleEvent = (value: unknown): ClaudeAgentTrackerUpdate => {
    if (!isRecord(value) || value.type !== 'system') {
      return { handled: false }
    }

    const subtype = readString(value, 'subtype')
    if (!subtype || !subAgentSubtypes.has(subtype)) {
      return { handled: false }
    }

    const taskId = readString(value, 'task_id')
    if (!taskId) {
      return { handled: true }
    }

    if (subtype === 'task_started') {
      if (!looksLikeSubAgentTask(value)) {
        return { handled: true }
      }
      ensureAgent(taskId, {
        nickname: readString(value, 'description'),
        role: readString(value, 'subagent_type'),
        status: 'running',
      })
      return { handled: true, activity: snapshot() }
    }

    if (subtype === 'task_progress') {
      if (!looksLikeSubAgentTask(value)) {
        return { handled: true }
      }

      const line = formatClaudeAgentProgressLine(value)
      if (!line) {
        return { handled: true }
      }

      // 心跳先于 task_started 到达（或该轮是恢复出来的）时仍要显示，否则面板会漏掉整个子代理。
      const agent = ensureAgent(taskId, {
        role: readString(value, 'subagent_type'),
        status: 'running',
      })
      pushPreview(agent, line)
      return { handled: true, activity: snapshot() }
    }

    const existing = agents.get(taskId)
    if (!existing) {
      return { handled: true }
    }

    if (subtype === 'task_updated') {
      const patch = readRecord(value, 'patch')
      if (!patch) {
        return { handled: true }
      }
      existing.status = mapTerminalStatus(readString(patch, 'status'))
      return { handled: true, activity: snapshot() }
    }

    existing.status = mapTerminalStatus(readString(value, 'status'))
    return { handled: true, activity: snapshot() }
  }

  return {
    handleEvent,
    snapshot,
    hasRunningAgents,
    getAgent: (taskId: string) => {
      const agent = agents.get(taskId)
      return agent ? publicAgent(agent) : undefined
    },
  }
}

export type ClaudeAgentStatusTracker = ReturnType<typeof createClaudeAgentStatusTracker>
