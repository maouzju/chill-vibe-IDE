import type {
  AppLanguage,
  StreamAgentEntry,
  StreamAgentsActivity,
  StreamAgentStatus,
} from '../shared/schema.js'
import { claudeWorkflowSummaryPrefix } from '../shared/claude-agent-push.js'
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

// key 是进度行去掉计数器后的"动作身份"，同一动作的新心跳按它替换旧行。
type ProgressPreview = { key: string; line: string }

type TrackedAgent = StreamAgentEntry & {
  preview: ProgressPreview[]
  startedAt: number
  // Workflow 条目专用：CLI workflow_progress 按 `type:index` 合并后的整张表。
  workflow?: Map<string, JsonRecord>
}

// 症状：用户报「面板一直没动」——整轮已跑 26 分钟，三条进度还停在 3.3s / 10.7s。
// 根因：2026-08-09 实测 CLI 的 task_progress 只在子代理"完成一次工具调用"时发；子代理
//       执行一条长命令期间整整 155 秒零事件（39.6s → 195.1s）。面板忠实反映最后一次
//       心跳，看起来就像死了。
// 被否决：静默超时就清空面板——子代理其实活着，清掉等于谎报完成。改为本地推算一行已运行
//         时长，由 providers 的周期重发驱动它走动。前缀是用户可见文本，不能用内部标记。
export const claudeAgentElapsedPrefix = '⏳'

// 症状：标题写着「四模块并行」，Workflow 条目却只有一行 A3:rig，看不出另外三个去哪了；
//   那行的 1074 tools / 118m 读起来像 rig 一个人的（2026-09-27 用户截图）。
// 根因：同日对拍 toy-blade 的 journal，core / data+rpg / render 早已跑完，只剩 rig；面板只列在跑的 agent，
//   从不交代"几个里完成了几个"，而心跳的 usage 是整个工作流的累计值。同日探针
//   （scripts/probe-claude-workflow-progress.mjs，claude 2.1.280）证实 workflow_progress 是按 type:index
//   合并的整张表：结束的 agent 仍在表里（done/error），排队的是 state=start 但没有 agentId/startedAt，
//   开跑的带各自的 toolCalls/startedAt。
// 被否决：放宽渲染层的 slice(-3)——桌面与手机监工页都尾切 3 行，还要动 Tier 2 快照；每个 agent 各画一行——
//   并行十几个时会把真正的心跳行挤出可见窗口。改为在 ⏳ 行前插一行汇总，尾切后始终可见。
// 常量本身放在 shared：落盘快照失去追踪时的收尾也要认得这一行。
export { claudeWorkflowSummaryPrefix }

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

// 症状：Workflow 条目同一个 agent 名在一行里出现两次，且每次心跳多一行只差工具数的近似副本
//   （2026-09-27 用户截图：「Drafts: draft:concept (throttle-retry) · draft:concept (throttle-retry) · 149 tools」下面紧跟 150 tools 一行）。
// 根因：2026-09-27 抠 claude 2.1.280 的 Workflow 进度发射点：description=`${phaseTitle}: ${label}`、
//   last_tool_name=label；usage 是整个工作流的累计值，同一 agent 的每次心跳只有计数器在变。
//   journal 核实当时只有一个 draft:concept 在跑，不是 CLI 派了两个。
// 被否决：按整行字符串去重——计数器每次都变，永远不相等；只去连续重复——并行 agent 交替上报时仍会刷出旧副本。
const readProgressAction = (event: JsonRecord) => {
  const description = readString(event, 'description')
  if (!description) {
    return null
  }
  const toolName = readString(event, 'last_tool_name')
  const redundantTool = toolName !== undefined
    && (description === toolName || description.endsWith(`: ${toolName}`))
  return toolName && !redundantTool ? `${description} · ${toolName}` : description
}

// 症状：按动作去重后，被放弃的首次尝试与已跑完的上一阶段会一直钉在面板第二行，看着像还有一个在跑
//   （2026-09-27 对抗审查实锤；改前的滚动列表两次心跳就能把它们冲掉）。
// 根因：claude 2.1.280 重派时把 label 改成 `${label} (throttle-retry)` / `${label} (retry N)`，index 不变；
//   agent 结束只体现在 workflow_progress 里该 agent 的 state 变成 done/error，心跳本身不带终态。
// 被否决：按心跳次数淘汰旧行——分不清"上一阶段已结束"和"并行 agent 正卡在一条长命令里"，
//   而 CLI 每次状态变化都会附带整张 workflow_progress，按它的活跃集合裁剪是精确的。
const previewKey = (action: string) => action.replace(/ \((?:throttle-retry|retry \d+)\)$/u, '')

type WorkflowAgentState = 'queued' | 'running' | 'done' | 'failed'

const readWorkflowAgentState = (entry: JsonRecord): WorkflowAgentState | undefined => {
  switch (readString(entry, 'state')) {
    case 'start':
      return readString(entry, 'agentId') || readFiniteNumber(entry, 'startedAt') !== undefined ? 'running' : 'queued'
    case 'progress':
      return 'running'
    case 'done':
      return 'done'
    case 'error':
      return 'failed'
    default:
      return undefined
  }
}

// 与心跳 description 同一身份：按 CLI 拼 description 的原样拼（它不 trim phase 名与 label），再像 readString 那样只 trim 两端。
const workflowEntryKey = (entry: JsonRecord) => {
  if (typeof entry.label !== 'string') return undefined
  const phaseTitle = typeof entry.phaseTitle === 'string' && entry.phaseTitle ? entry.phaseTitle : undefined
  const description = (phaseTitle ? `${phaseTitle}: ${entry.label}` : entry.label).trim()
  return description ? previewKey(description) : undefined
}

const listWorkflowAgents = (table: Map<string, JsonRecord> | undefined) =>
  table ? [...table.values()].filter((entry) => entry.type === 'workflow_agent') : []

const listRunningWorkflowAgents = (table: Map<string, JsonRecord> | undefined, key: string) =>
  listWorkflowAgents(table).filter((entry) =>
    readWorkflowAgentState(entry) === 'running' && workflowEntryKey(entry) === key)

// copies > 1 表示几个同名 agent 共用这一行（行尾标 ×N）；此时调用方不给计数，见 task_progress 分支。
type ProgressCounters = { toolUses?: number; durationMs?: number; copies?: number }

// 传了 counters 就只用它（缺的段落省略），不再读心跳 usage：Workflow 的 usage 是整个工作流的累计值，
// 与表里单个 agent 的计数混用会让同一行的工具数时大时小。
export const formatClaudeAgentProgressLine = (event: unknown, counters?: ProgressCounters): string | null => {
  if (!isRecord(event)) {
    return null
  }

  const action = readProgressAction(event)
  if (!action) {
    return null
  }

  const usage = readRecord(event, 'usage')
  const copies = counters?.copies ?? 0
  const segments = [copies > 1 ? `${action} ×${copies}` : action]

  const toolUses = counters ? counters.toolUses : readFiniteNumber(usage, 'tool_uses')
  if (toolUses !== undefined && toolUses > 0) {
    segments.push(`${toolUses} ${toolUses === 1 ? 'tool' : 'tools'}`)
  }

  const duration = formatDuration(counters ? counters.durationMs : readFiniteNumber(usage, 'duration_ms'))
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
  // tool_use_id → 条目 id：sidechain 行只带 parent_tool_use_id，要靠它找回子代理条目。
  const toolUseIds = new Map<string, string>()

  const ensureAgent = (
    taskId: string,
    patch: Partial<Pick<TrackedAgent, 'nickname' | 'role' | 'status' | 'model'>> = {},
  ) => {
    let agent = agents.get(taskId)
    if (!agent) {
      order.push(taskId)
      agent = { threadId: taskId, status: 'running', preview: [], startedAt: now() }
      agents.set(taskId, agent)
    }

    if (patch.nickname) agent.nickname = patch.nickname
    if (patch.role) agent.role = patch.role
    if (patch.status) agent.status = patch.status
    if (patch.model) agent.model = patch.model
    return agent
  }

  // 进入终态就丢掉 workflow 表：结束后没有任何路径再读它（汇总只在运行中出，后续心跳撞终态守卫，
  // 复活会重建），而常驻进程的追踪器跨回合存活、从不淘汰条目。2026-09-27 对抗审查实测：
  // 20 个工作流 × 50 个 agent 留下 1.48MB 的 CLI 原始记录（每条带 promptPreview/resultPreview）。
  const setStatus = (agent: TrackedAgent, status: StreamAgentStatus) => {
    agent.status = status
    if (!isRunningStatus(status)) agent.workflow = undefined
  }

  const reviveAgent = (taskId: string) => {
    const agent = ensureAgent(taskId, { status: 'running' })
    agent.startedAt = now()
    agent.preview = []
    agent.workflow = undefined
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

  // 例：`📋 已完成 3/4 · 在跑 1 · 失败 1 · 排队 2`；为 0 的计数不出现。
  // 只报计数不列名字：2026-09-27 对抗审查在 Chromium 里按 index.css 实测，列 3 个名字的汇总在
  // 217~584px 的列里折成两行，而桌面活动框限高 3 行、底部对齐，折行会把最新那条心跳行挤出框。
  // 在跑的是谁由心跳行交代。
  const formatWorkflowSummary = (agent: TrackedAgent) => {
    const entries = listWorkflowAgents(agent.workflow)
    if (entries.length === 0) {
      return undefined
    }
    const states = entries.map(readWorkflowAgentState)
    const count = (state: WorkflowAgentState) => states.filter((value) => value === state).length
    const en = language === 'en'
    const segments = [en ? `${count('done')}/${entries.length} done` : `已完成 ${count('done')}/${entries.length}`]
    if (count('running') > 0) segments.push(en ? `${count('running')} running` : `在跑 ${count('running')}`)
    if (count('failed') > 0) segments.push(en ? `${count('failed')} failed` : `失败 ${count('failed')}`)
    if (count('queued') > 0) segments.push(en ? `${count('queued')} queued` : `排队 ${count('queued')}`)
    return `${claudeWorkflowSummaryPrefix} ${segments.join(' · ')}`
  }

  // 顺序固定为 心跳行… → 汇总 → ⏳：渲染端尾切 3 行，汇总与计时必须都留在窗口里。
  const publicAgent = (agent: TrackedAgent): StreamAgentEntry => {
    const running = isRunningStatus(agent.status)
    const summary = running ? formatWorkflowSummary(agent) : undefined
    return {
      threadId: agent.threadId,
      ...(agent.nickname ? { nickname: agent.nickname } : {}),
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      status: agent.status,
      ...(agent.message !== undefined ? { message: agent.message } : {}),
      activity: [
        ...agent.preview.map((entry) => entry.line),
        ...(summary ? [summary] : []),
        ...(running ? [formatElapsed(agent.startedAt)] : []),
      ],
    }
  }

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
    setStatus(agent, 'completed')
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

  // 同一动作只留最新一行并挪到末尾：渲染端只取尾部几行，末尾必须是最近的心跳。
  const pushPreview = (agent: TrackedAgent, entry: ProgressPreview) => {
    agent.preview = agent.preview.filter((existing) => existing.key !== entry.key)
    agent.preview.push(entry)
    while (agent.preview.length > maxPreviewItems) {
      agent.preview.shift()
    }
  }

  const resolveTask = (id: string) => aliases.get(id) ?? id
  const settleAll = (status: StreamAgentStatus = 'interrupted') => {
    for (const agent of agents.values()) {
      if (isRunningStatus(agent.status)) setStatus(agent, status)
    }
    return snapshot()
  }

  // status 由调用方按回合结局给：正常结束是 completed，回合报错是 interrupted。
  // 跨回合保留的后台条目两种情况都不动——它们的终态只能来自原生 task_* 事件。
  const finishTurn = (keepBackground: boolean, status: StreamAgentStatus = 'completed') => {
    for (const agent of agents.values()) {
      if (isRunningStatus(agent.status) && !(keepBackground && background.has(agent.threadId))) {
        setStatus(agent, status)
      }
    }
    return snapshot()
  }

  // 症状：面板看不出子代理跑在哪个模型上（SPEC subagent-model-badge）。
  // 数据源：system:task_* 事件不带模型；只有 sidechain 的 assistant 行 message.model 是 CLI 解析
  //   别名后的真实 id（Agent 工具入参里的 haiku/opus 只是别名且多数派发不填）。
  // 边界：只读这一个字段，不消费该行（handled 仍为 false，pitfall #223 的 sidechain 规则不动），
  //   同一模型重复到达不再推快照，否则子代理每说一句面板就刷一次。
  const attachSidechainModel = (parentToolUseId: string, value: JsonRecord) => {
    if (value.type !== 'assistant') return false
    const model = readString(readRecord(value, 'message'), 'model')
    if (!model) return false
    const taskId = resolveTask(toolUseIds.get(parentToolUseId) ?? syntheticClaudeAgentId(parentToolUseId))
    const agent = agents.get(taskId)
    if (!agent || agent.model === model) return false
    agent.model = model
    return true
  }

  const handleEvent = (value: unknown): ClaudeAgentTrackerUpdate => {
    if (!isRecord(value)) {
      return { handled: false }
    }
    const parentToolUseId = readString(value, 'parent_tool_use_id')
    if (parentToolUseId) {
      return { handled: false, ...(attachSidechainModel(parentToolUseId, value) ? { activity: snapshot() } : {}) }
    }

    // 2026-09-08 原生记录：Workflow 可立即报文件不存在，也可返回后台 task id。
    // 不能把 tool_result 一律当完成；别名让后续 task_notification 结算同一计时器。
    if (value.type === 'user') {
      let changed = false
      for (const result of parseClaudeToolResults(value.message)) {
        // 症状：主回合用 SendMessage 续跑已完成的子代理，面板整段空白（2026-09-25 用户实测）。
        // 根因：续跑复用原 agent id，条目已是终态，之后的 task_* 全撞终态守卫被丢；
        //   CLI 唯一稳定确认是回执里的 resumedAgentId。续跑一律异步，登记进 background 跨回合保留。
        const resumedId = /"resumedAgentId"\s*:\s*"([^"]+)"/u.exec(result.text)?.[1]
        if (resumedId && !result.isError) {
          reviveAgent(resolveTask(resumedId))
          background.add(resolveTask(resumedId))
          changed = true
          continue
        }
        const syntheticId = syntheticClaudeAgentId(result.toolUseId)
        const id = resolveTask(syntheticId)
        const agent = agents.get(id)
        if (!agent || !isRunningStatus(agent.status)) continue
        const task = /^Workflow launched in background\. Task ID:\s*(\S+)/u.exec(result.text)
        // 症状：模型停止输出的瞬间，仍在后台跑的 Agent 面板整个消失、再不回来（2026-09-10 用户实测：
        //   三个 run_in_background Agent 在根回合 end_turn 后又各跑 6～12 分钟，快照却已是 agents: []）。
        // 根因：这份「Async agent launched」回执此前只用来"不结算"，从没登记进 background，
        //   回合末 finishTurn(keep) 不管 keep 真假都把它们收成 completed，之后的 task_progress 撞终态守卫被丢。
        // 被否决：改读 tool_use 的 input.run_in_background——turn parser 与 runtime 都只把 toolName
        //   传进 beginSynthetic，而这份回执是 CLI 对后台派发的唯一稳定确认（前台 Agent 的回执晚于终态）。
        const asyncLaunch = /^Async agent launched/u.test(result.text)
        if (result.isError || /^<tool_use_error>/u.test(result.text)) {
          setStatus(agent, 'errored')
        } else if (task) {
          aliases.set(task[1], id)
          background.add(id)
        } else if (asyncLaunch) {
          // 2026-09-08 实测 claude 2.1.263 顺序是 tool_use → task_started（条目已别名到原生 task_id）
          // → 这份回执；它只是派发回执，终态由 system:task_notification 决定。
          background.add(id)
          continue
        } else if (id !== syntheticId) {
          // 已被原生 task_started 认领却收到别的回执：前台 Agent 的回执晚于终态，正常走不到这里；
          // 保守起见不当完成处理，终态仍交给 task_notification。
          continue
        } else if (!background.has(id)) {
          setStatus(agent, 'completed')
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
          setStatus(agent, mapTerminalStatus(status))
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
    if (toolUseId) toolUseIds.set(toolUseId, taskId)
    const known = agents.get(taskId)
    // 同一 id 再次 task_started 只可能是续跑，复活而不是丢弃；其余事件仍守终态。
    if (known && !isRunningStatus(known.status) && subtype === 'task_started') reviveAgent(taskId)
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

      const action = readProgressAction(value)
      if (!action) {
        return { handled: true }
      }

      // 心跳先于 task_started 到达（或该轮是恢复出来的）时仍要显示，否则面板会漏掉整个子代理。
      retireSyntheticFor(value)
      const agent = ensureAgent(taskId, {
        role: readString(value, 'subagent_type'),
        status: 'running',
      })
      const key = previewKey(action)
      const progress = Array.isArray(value.workflow_progress) ? value.workflow_progress : undefined
      if (progress) {
        agent.workflow ??= new Map()
        for (const entry of progress) {
          if (isRecord(entry) && typeof entry.type === 'string') agent.workflow.set(`${entry.type}:${String(entry.index)}`, entry)
        }
        const liveKeys = new Set(listWorkflowAgents(agent.workflow)
          .filter((entry) => readWorkflowAgentState(entry) === 'running')
          .map(workflowEntryKey))
        agent.preview = agent.preview.filter((entry) => liveKeys.has(entry.key))
        // 状态变化批次的 description 指向刚结束或刚入队的 agent（或整个工作流），不能给它加行。
        if (!liveKeys.has(key)) {
          return { handled: true, activity: snapshot() }
        }
      }
      // 收到过表就只用表里这个 agent 自己的计数（最多落后一次节流，10 秒）；没收到过才退回心跳 usage。
      // 症状：几个同名 agent 并行时，那一行显示的是 index 最大那个的计数，它一结束数字就倒退（2026-09-27 对抗审查复现）。
      // 根因：CLI 2.1.280 没给 label 时取 prompt 前 60 字，模板化 prompt 或循环复用 label 都会撞名；心跳只带
      //   `${phaseTitle}: ${label}`，不带 index，分不清是谁发的。
      // 被否决：按 index 分行——心跳认不出 index，照样不知道该更新哪一行。改为同名的共用一行、标 ×N、不给计数。
      const running = agent.workflow ? listRunningWorkflowAgents(agent.workflow, key) : []
      const own = running.length === 1 ? running[0] : undefined
      const ownStartedAt = own ? readFiniteNumber(own, 'startedAt') : undefined
      const line = formatClaudeAgentProgressLine(value, agent.workflow ? {
        toolUses: own ? readFiniteNumber(own, 'toolCalls') : undefined,
        durationMs: ownStartedAt !== undefined ? Math.max(0, now() - ownStartedAt) : undefined,
        copies: running.length,
      } : undefined)
      if (line) {
        pushPreview(agent, { key, line })
      }
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
      setStatus(existing, mapTerminalStatus(readString(patch, 'status')))
      return { handled: true, activity: snapshot() }
    }

    setStatus(existing, mapTerminalStatus(readString(value, 'status')))
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
