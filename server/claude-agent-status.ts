import type {
  AppLanguage,
  StreamAgentEntry,
  StreamAgentsActivity,
  StreamAgentStatus,
} from '../shared/schema.js'
import { parseClaudeToolResults } from './claude-tool-result.js'

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

// 合成条目以派发它的 tool_use_id 为键：CLI 随后发出的 system:task_* 带着同一个
// tool_use_id，tracker 靠它把兜底条目换成真实子代理，两边都不能各自拼字符串。
export const syntheticClaudeAgentId = (toolUseId: string) => `workflow:${toolUseId}`

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
// 症状：打断整轮后，那几个被掐死的子代理在数据层被记成"已完成"，观感是它们干完了活。
// 根因：2026-08-16 拿 claude 2.1.206 实测打断（见本文件顶部的实测说明）——CLI 发的是
//   task_updated {"status":"killed"} 与 task_notification {"status":"stopped"}，
//   两个值都没有分支，落进 default 的"未知终态收敛为 completed"。它们不是未来的未知值，
//   是当前版本每次打断都会发的值；同一实验里正常跑完发的是明确的 "completed"，
//   所以 default 那条兜底继续保留是安全的，缺的只是把这两个已知值显式接住。
const mapTerminalStatus = (status: string | undefined): StreamAgentStatus => {
  switch (status) {
    case 'failed':
    case 'error':
    case 'errored':
      return 'errored'
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
    case 'killed':
    case 'stopped':
    case 'aborted':
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
  const aliases = new Map<string, string>()
  const background = new Set<string>()

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

  // 症状：Fable 5.1 / 新 CLI 有时只发 Workflow 的 tool_use、不发 system:task_*，面板整轮空白，
  //       用户只能看到一段静态汇总文字；而一旦按 tool_use 先建条目兜底，正常派发 Task/Agent 时
  //       面板又会多出一条永不退役的「子代理」——真实那条完成后它仍在"已运行 …"，直到整轮结束。
  // 根因：2026-09-08 发布审计实测 claude 2.1.263 正常派发仍发 task_started，且带着同一个
  //       tool_use_id；合成条目与真实条目键不同，谁也不认识谁。
  // 被否决：只给 Workflow 建合成条目——Task/Agent 同样会撞上不发 task_* 的 CLI；
  //         改为按 tool_use_id 关联，真实事件一到就把兜底条目换掉（见 retireSyntheticFor）。
  const beginSynthetic = (taskId: string, toolName: string): StreamAgentsActivity => {
    if (agents.has(aliases.get(taskId) ?? taskId)) return snapshot()
    const fallbackNickname = language === 'en' ? 'Sub-agent' : '子代理'
    ensureAgent(taskId, {
      nickname: toolName === 'Workflow' ? 'Workflow' : fallbackNickname,
      role: toolName,
      status: 'running',
    })
    return snapshot()
  }

  // 返回是否真的收掉了一条仍在跑的合成条目；已被真实事件换掉的返回 false，
  // 调用方据此决定要不要再广播一次快照，避免整轮末尾多推一张空面板。
  const completeSynthetic = (taskId: string): boolean => {
    const agent = agents.get(taskId)
    if (!agent || !isRunningStatus(agent.status)) {
      return false
    }
    agent.status = 'completed'
    return true
  }

  const retireSyntheticFor = (event: JsonRecord) => {
    const toolUseId = readString(event, 'tool_use_id')
    if (!toolUseId) {
      return
    }
    const syntheticId = syntheticClaudeAgentId(toolUseId)
    // 已有后台回执别名仍指向该条目，不能删掉它再从零建时钟。
    if (background.has(syntheticId)) return
    const previous = agents.get(syntheticId)
    const nativeId = readString(event, 'task_id')
    if (previous && nativeId) {
      agents.set(nativeId, { ...previous, threadId: nativeId })
      aliases.set(syntheticId, nativeId)
      if (background.delete(syntheticId)) background.add(nativeId)
    }
    if (!agents.delete(syntheticId)) {
      return
    }
    const index = order.indexOf(syntheticId)
    if (index >= 0) {
      order.splice(index, 1)
      if (nativeId && !order.includes(nativeId)) order.splice(index, 0, nativeId)
    }
  }

  const pushPreview = (agent: TrackedAgent, line: string) => {
    agent.activity.push(line)
    while (agent.activity.length > maxPreviewItems) {
      agent.activity.shift()
    }
  }

  const resolveTask = (id: string) => aliases.get(id) ?? id
  const settleAll = (status: StreamAgentStatus = 'interrupted') => {
    for (const agent of agents.values()) {
      if (isRunningStatus(agent.status)) agent.status = status
    }
    return snapshot()
  }

  // status 由调用方按回合结局给：正常结束是 completed，回合报错是 interrupted。
  // 跨回合保留的后台条目两种情况都不动——它们的终态只能来自原生 task_* 事件。
  const finishTurn = (keepBackground: boolean, status: StreamAgentStatus = 'completed') => {
    for (const agent of agents.values()) {
      if (isRunningStatus(agent.status) && !(keepBackground && background.has(agent.threadId))) {
        agent.status = status
      }
    }
    return snapshot()
  }

  const handleEvent = (value: unknown): ClaudeAgentTrackerUpdate => {
    if (!isRecord(value) || readString(value, 'parent_tool_use_id')) {
      return { handled: false }
    }

    // 2026-09-08 原生记录：Workflow 可立即报文件不存在，也可返回后台 task id。
    // 不能把 tool_result 一律当完成；别名让后续 task_notification 结算同一计时器。
    if (value.type === 'user') {
      let changed = false
      for (const result of parseClaudeToolResults(value.message)) {
        const syntheticId = syntheticClaudeAgentId(result.toolUseId)
        const id = resolveTask(syntheticId)
        const agent = agents.get(id)
        if (!agent || !isRunningStatus(agent.status)) continue
        const task = /^Workflow launched in background\. Task ID:\s*(\S+)/u.exec(result.text)
        if (result.isError || /^<tool_use_error>/u.test(result.text)) {
          agent.status = 'errored'
        } else if (task) {
          aliases.set(task[1], id)
          background.add(id)
        } else if (id !== syntheticId) {
          // 已被原生 task_started 认领：后台 Agent/Task 的「Async agent launched」回执在
          // task_started 之后才到，它只是派发回执，终态由 system:task_notification 决定。
          // 2026-09-08 实测 claude 2.1.263；前台 Agent 的回执晚于终态，走上面的 continue。
          continue
        } else if (!background.has(id)) {
          agent.status = 'completed'
        }
        changed = true
      }
      const message = readRecord(value, 'message')
      const content = message?.content
      const notification = (typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((block) => isRecord(block) && block.type === 'text').map((block) => block.text).join('')
        : '').trim()
      if (notification.startsWith('<task-notification>') && notification.endsWith('</task-notification>')) {
        const taskId = /<task-id>([^<]+)<\/task-id>/u.exec(notification)?.[1]
        const toolId = /<tool-use-id>([^<]+)<\/tool-use-id>/u.exec(notification)?.[1]
        const status = /<status>([^<]+)<\/status>/u.exec(notification)?.[1]
        const agent = agents.get(resolveTask(taskId ?? '')) ?? agents.get(resolveTask(`workflow:${toolId}`))
        if (agent && status) {
          agent.status = mapTerminalStatus(status)
          changed = true
        }
      }
      return { handled: false, ...(changed ? { activity: snapshot() } : {}) }
    }
    if (value.type !== 'system') return { handled: false }

    const subtype = readString(value, 'subtype')
    if (!subtype || !subAgentSubtypes.has(subtype)) {
      return { handled: false }
    }

    const nativeId = readString(value, 'task_id')
    if (!nativeId) {
      return { handled: true }
    }
    const toolUseId = readString(value, 'tool_use_id')
    const synthetic = toolUseId ? agents.get(syntheticClaudeAgentId(toolUseId)) : undefined
    if (synthetic?.role === 'Workflow') {
      aliases.set(nativeId, synthetic.threadId)
      background.add(synthetic.threadId)
    }
    const taskId = resolveTask(nativeId)
    const known = agents.get(taskId)
    if (known && !isRunningStatus(known.status)) return { handled: true }

    if (subtype === 'task_started') {
      if (!known && !looksLikeSubAgentTask(value)) {
        return { handled: true }
      }
      retireSyntheticFor(value)
      ensureAgent(taskId, {
        nickname: readString(value, 'description'),
        role: readString(value, 'subagent_type'),
        status: 'running',
      })
      return { handled: true, activity: snapshot() }
    }

    if (subtype === 'task_progress') {
      if (!known && !looksLikeSubAgentTask(value)) {
        return { handled: true }
      }

      const line = formatClaudeAgentProgressLine(value)
      if (!line) {
        return { handled: true }
      }

      // 心跳先于 task_started 到达（或该轮是恢复出来的）时仍要显示，否则面板会漏掉整个子代理。
      retireSyntheticFor(value)
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
    beginSynthetic,
    completeSynthetic,
    settleAll,
    finishTurn,
    hasBackgroundAgents: () => [...background].some((id) => {
      const agent = agents.get(id)
      return agent && isRunningStatus(agent.status)
    }),
    getAgent: (taskId: string) => {
      const agent = agents.get(taskId)
      return agent ? publicAgent(agent) : undefined
    },
  }
}

export type ClaudeAgentStatusTracker = ReturnType<typeof createClaudeAgentStatusTracker>
