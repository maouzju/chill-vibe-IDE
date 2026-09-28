import assert from 'node:assert/strict'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

import {
  claudeAgentElapsedPrefix,
  claudeWorkflowSummaryPrefix,
  createClaudeAgentStatusTracker,
  syntheticClaudeAgentId,
} from '../server/claude-agent-status'

// 面板底部那行本地推算的"已运行"和 Workflow 汇总行都不是 CLI 心跳，断言真实进度行时要先滤掉。
const progressLines = (activity: string[] | undefined) =>
  (activity ?? []).filter((line) =>
    !line.startsWith(claudeAgentElapsedPrefix) && !line.startsWith(claudeWorkflowSummaryPrefix))

const summaryLine = (activity: string[] | undefined) =>
  (activity ?? []).find((line) => line.startsWith(claudeWorkflowSummaryPrefix))

const elapsedLine = (activity: string[] | undefined) =>
  (activity ?? []).find((line) => line.startsWith(claudeAgentElapsedPrefix))

test('Workflow failure retires immediately, background receipt binds task id without resetting elapsed', () => {
  let now = 1_000_000
  const tracker = createClaudeAgentStatusTracker({ now: () => now })
  tracker.beginSynthetic('workflow:failed', 'Workflow')
  tracker.handleEvent({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'failed', is_error: true, content: '<tool_use_error>Workflow script file not found</tool_use_error>' },
  ] } })
  assert.equal(tracker.hasRunningAgents(), false)
  assert.equal(tracker.getAgent('workflow:failed')?.status, 'errored')
  tracker.beginSynthetic('workflow:started', 'Workflow')
  now += 60_000
  tracker.handleEvent({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'started', content: 'Workflow launched in background. Task ID: w123\nSummary: test' },
  ] } })
  tracker.handleEvent({ type: 'system', subtype: 'task_started', task_id: 'w123', tool_use_id: 'started', task_type: 'local_workflow' })
  assert.equal(tracker.snapshot().agents.length, 1)
  assert.equal(elapsedLine(tracker.snapshot().agents[0]?.activity), '⏳ 已运行 1分0秒')
  tracker.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'unrelated', status: 'completed' })
  assert.equal(tracker.hasRunningAgents(), true)
  tracker.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'w123', status: 'completed' })
  assert.equal(tracker.hasRunningAgents(), false)
  tracker.handleEvent({ type: 'system', subtype: 'task_progress', task_id: 'w123', subagent_type: 'Workflow', description: 'late progress' })
  assert.equal(tracker.hasRunningAgents(), false, '迟到进度不能复活终态')
})

test('Workflow native notification text settles only the matched tool, not sidechain or quoted user text', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.beginSynthetic('workflow:one', 'Workflow')
  const notification = '<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>one</tool-use-id>\n<status>stopped</status>\n</task-notification>'
  tracker.handleEvent({ type: 'user', parent_tool_use_id: 'child', message: { content: notification } })
  assert.equal(tracker.hasRunningAgents(), true)
  tracker.handleEvent({ type: 'user', message: { content: '请解释：' + notification } })
  assert.equal(tracker.hasRunningAgents(), true)
  tracker.handleEvent({ type: 'user', message: { content: notification } })
  assert.equal(tracker.hasRunningAgents(), false)
  assert.equal(tracker.getAgent('workflow:one')?.status, 'interrupted')
})

test('块数组里的原生 Workflow 通知也能停止计时', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.beginSynthetic('workflow:one', 'Workflow')
  tracker.handleEvent({ type: 'user', message: { content: [{ type: 'text', text: '<task-notification><tool-use-id>one</tool-use-id><status>completed</status></task-notification>' }] } })
  assert.equal(tracker.hasRunningAgents(), false)
})

test('原生任务先于后台回执时仍继承启动时间，重复派发与 progress 不重置它', () => {
  let now = 1_000_000
  const tracker = createClaudeAgentStatusTracker({ now: () => now })
  tracker.beginSynthetic('workflow:one', 'Workflow')
  now += 90_000
  tracker.handleEvent({ type: 'system', subtype: 'task_started', task_id: 'w1', tool_use_id: 'one', task_type: 'local_workflow' })
  tracker.handleEvent({ type: 'system', subtype: 'task_progress', task_id: 'w1', tool_use_id: 'one', subagent_type: 'Workflow', description: 'working' })
  tracker.handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Workflow launched in background. Task ID: w1\n' }] } })
  tracker.beginSynthetic('workflow:one', 'Workflow')
  tracker.finishTurn(true)
  assert.equal(tracker.snapshot().agents.length, 1)
  assert.equal(elapsedLine(tracker.snapshot().agents[0]?.activity), '⏳ 已运行 1分30秒')
  tracker.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'w1', status: 'completed' })
  assert.equal(tracker.hasRunningAgents(), false)
})

// 事件样本取自 2026-08-09 对 claude 2.1.206 的实测 stdout（-p --verbose
// --output-format stream-json --include-partial-messages），字段名与嵌套结构
// 与真实输出逐一对齐，用于锁住 CLI 的 system:task_* 形状。
const taskId = 'a143d10b76bb11650'
const toolUseId = 'toolu_01VmoiGnq5LvDeEiby8bnR4L'
const sessionId = '03c819fa-4bdb-470d-881e-d0c02a687d9e'

const taskStarted = () => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: toolUseId,
  description: 'Count .ts files in server dir',
  subagent_type: 'Explore',
  task_type: 'local_agent',
  prompt: 'Count how many files with the `.ts` extension exist DIRECTLY under...',
  uuid: '0dfffb21-5e80-41b6-9062-ab94428fb7d3',
  session_id: sessionId,
})

const taskProgress = (description: string, toolUses: number, durationMs: number) => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: taskId,
  tool_use_id: toolUseId,
  description,
  subagent_type: 'Explore',
  usage: { total_tokens: 27992, tool_uses: toolUses, duration_ms: durationMs },
  last_tool_name: 'PowerShell',
  uuid: 'eec0382c-ff30-4bd6-bbae-fd91340e7537',
  session_id: sessionId,
})

const taskUpdated = (status: string) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: taskId,
  patch: { status, end_time: 1786249729950 },
  uuid: '75d3e3f4-fe8b-401b-9c53-5aeb9c01e2c1',
  session_id: sessionId,
})

const taskNotification = (status: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  tool_use_id: toolUseId,
  status,
  output_file: 'C:\\Temp\\tasks\\a143d10b76bb11650.output',
  summary: 'Total `.ts` files directly under the folder: 46',
  uuid: 'dfc97864-55b0-4a5e-a895-f1f31cd0c240',
  session_id: sessionId,
})

test('task_started registers a running sub-agent with its type and description', () => {
  const tracker = createClaudeAgentStatusTracker()
  const update = tracker.handleEvent(taskStarted())

  assert.equal(update.handled, true)
  assert.ok(update.activity, 'a newly dispatched sub-agent must emit an activity snapshot')
  assert.equal(update.activity.kind, 'agents')
  assert.equal(update.activity.view, 'status')
  assert.equal(update.activity.agents.length, 1)

  const [agent] = update.activity.agents
  assert.equal(agent.threadId, taskId)
  assert.equal(agent.role, 'Explore')
  assert.equal(agent.nickname, 'Count .ts files in server dir')
  assert.equal(agent.status, 'running')
  assert.equal(tracker.hasRunningAgents(), true)
})

test('task_progress surfaces the current action and the tool being used', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  const update = tracker.handleEvent(
    taskProgress('Running List top-level .ts files by name', 2, 17808),
  )

  assert.equal(update.handled, true)
  assert.ok(update.activity, 'progress must refresh the panel')

  const [agent] = update.activity.agents
  const activity = progressLines(agent.activity)
  assert.equal(activity.length, 1)
  const line = activity[0]!
  assert.match(line, /Running List top-level \.ts files by name/u)
  assert.match(line, /PowerShell/u)
})

test('the panel updates one card in place instead of opening a new one per progress tick', () => {
  const tracker = createClaudeAgentStatusTracker()
  const started = tracker.handleEvent(taskStarted())
  const progressed = tracker.handleEvent(taskProgress('Running Count total files', 3, 28570))

  assert.equal(started.activity?.itemId, progressed.activity?.itemId)
})

test('successive progress ticks accumulate as separate preview lines', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskProgress('Running Check if target directory exists', 1, 5159))
  const update = tracker.handleEvent(
    taskProgress('Running List top-level .ts files by name', 2, 17808),
  )

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.equal(activity.length, 2)
  assert.match(activity[0]!, /Check if target directory exists/u)
  assert.match(activity[1]!, /List top-level \.ts files by name/u)
})

// 事件形状取自 2026-09-27 claude 2.1.280 的 Workflow 进度发射点：description 是
// `${phaseTitle}: ${label}`，last_tool_name 又是同一个 label，usage 是整个工作流的累计值。
const workflowProgress = (
  label: string,
  toolUses: number,
  durationMs: number,
  { phase = 'Drafts', live }: { phase?: string; live?: WorkflowAgentState[] } = {},
) => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: 'wf_native',
  tool_use_id: 'toolu_wf',
  description: `${phase}: ${label}`,
  usage: { total_tokens: 1_234_567, tool_uses: toolUses, duration_ms: durationMs },
  last_tool_name: label,
  // CLI 只在批次里有状态变化（start/done/error）或节流到点时附带整张 workflow_progress。
  // 2026-09-27 探针实测：排队中的 agent 是 state=start 但没有 agentId/startedAt，开跑后才补上。
  ...(live ? {
    workflow_progress: live.map(([phaseTitle, agentLabel, state, extra], index) => ({
      type: 'workflow_agent',
      index,
      label: agentLabel,
      phaseTitle,
      state: state === 'queued' ? 'start' : state,
      ...(state === 'queued' ? {} : { agentId: `agent-${index}` }),
      ...extra,
    })),
  } : {}),
})

type WorkflowAgentState = [
  phaseTitle: string,
  label: string,
  state: 'queued' | 'start' | 'progress' | 'done' | 'error',
  extra?: Record<string, unknown>,
]

const startWorkflow = (options: Parameters<typeof createClaudeAgentStatusTracker>[0] = {}) => {
  const tracker = createClaudeAgentStatusTracker(options)
  tracker.beginSynthetic(syntheticClaudeAgentId('toolu_wf'), 'Workflow')
  tracker.handleEvent({ type: 'system', subtype: 'task_started', task_id: 'wf_native', tool_use_id: 'toolu_wf', task_type: 'local_workflow' })
  return tracker
}

test('a Workflow progress line does not repeat the agent label the description already names', () => {
  const tracker = startWorkflow()
  const update = tracker.handleEvent(workflowProgress('draft:concept (throttle-retry)', 149, 3_923_000))

  const [line] = progressLines(update.activity?.agents[0]?.activity)
  assert.equal(line, 'Drafts: draft:concept (throttle-retry) · 149 tools · 65m23s')
})

test('Workflow heartbeats for the same agent refresh one line instead of stacking near-identical copies', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('draft:concept (throttle-retry)', 149, 3_923_000))
  const update = tracker.handleEvent(workflowProgress('draft:concept (throttle-retry)', 150, 3_923_400))

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.deepEqual(activity, ['Drafts: draft:concept (throttle-retry) · 150 tools · 65m23s'])
})

test('interleaved parallel Workflow agents keep one line each, most recent last', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('draft:concept', 10, 60_000))
  tracker.handleEvent(workflowProgress('draft:systems', 11, 61_000))
  const update = tracker.handleEvent(workflowProgress('draft:concept', 12, 62_000))

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.equal(activity.length, 2)
  assert.match(activity[0]!, /^Drafts: draft:systems · 11 tools/u)
  assert.match(activity[1]!, /^Drafts: draft:concept · 12 tools/u)
})

// 2026-09-27 用户那次的实际时间线：首次尝试跑了一段被判限流，45s 后以 `(throttle-retry)` 重派。
test('a retried Workflow agent replaces the abandoned attempt line instead of looking like a second agent', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('draft:concept', 40, 600_000))
  tracker.handleEvent(workflowProgress('draft:concept (throttle-retry)', 149, 3_923_000))
  const update = tracker.handleEvent(workflowProgress('draft:concept (retry 1)', 150, 3_923_400))

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.deepEqual(activity, ['Drafts: draft:concept (retry 1) · 150 tools · 65m23s'])
})

test('a finished phase drops its lines once workflow_progress reports the agents done', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('draft:a', 10, 60_000))
  tracker.handleEvent(workflowProgress('draft:b', 11, 61_000))
  const update = tracker.handleEvent(workflowProgress('critic', 12, 62_000, {
    phase: 'Review',
    live: [['Drafts', 'draft:a', 'done'], ['Drafts', 'draft:b', 'done'], ['Review', 'critic', 'start']],
  }))

  // 表里的 critic 没带自己的 toolCalls/startedAt，行上就不挂计数器，绝不退回整个工作流的累计值。
  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.deepEqual(activity, ['Review: critic'])
})

test('a done event does not re-add the line of the agent that just finished', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('draft:a', 10, 60_000))
  tracker.handleEvent(workflowProgress('draft:b', 11, 61_000))
  const update = tracker.handleEvent(workflowProgress('draft:a', 12, 62_000, {
    live: [['Drafts', 'draft:a', 'done'], ['Drafts', 'draft:b', 'progress']],
  }))

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.deepEqual(activity, ['Drafts: draft:b · 11 tools · 1m1s'])
})

// CLI 不 trim 脚本里的 phase 名，description 与 workflow_progress 用的是同一份原始字符串。
test('a phase title with stray whitespace still matches its live workflow_progress entry', () => {
  const tracker = startWorkflow()
  const update = tracker.handleEvent(workflowProgress('draft:a', 10, 60_000, {
    phase: 'Drafts ',
    live: [['Drafts ', 'draft:a', 'progress']],
  }))

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.deepEqual(activity, ['Drafts : draft:a'])
})

test('workflow_progress pruning keeps every parallel agent that is still live', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('draft:concept', 10, 60_000))
  const update = tracker.handleEvent(workflowProgress('draft:systems (throttle-retry)', 11, 61_000, {
    live: [['Drafts', 'draft:concept', 'progress'], ['Drafts', 'draft:systems (throttle-retry)', 'start']],
  }))

  const activity = progressLines(update.activity?.agents[0]?.activity)
  assert.equal(activity.length, 2)
  assert.match(activity[0]!, /^Drafts: draft:concept · 10 tools/u)
  assert.equal(activity[1], 'Drafts: draft:systems (throttle-retry)')
})

// 2026-09-27 用户截图：标题「四模块并行」，面板只有 A3:rig 一行，且 1074 tools / 118m 是整个工作流的累计值。
// toy-blade 的 journal 证实 core / data+rpg / render 早已跑完。
test('a Workflow with three of four agents done says so in a summary line the panel keeps visible', () => {
  const t0 = 1_000_000
  let now = t0
  const tracker = startWorkflow({ now: () => now })
  const wave: WorkflowAgentState[] = [
    ['Wave1', 'A1:core', 'progress', { startedAt: t0, toolCalls: 3 }],
    ['Wave1', 'A2:render', 'progress', { startedAt: t0, toolCalls: 2 }],
    ['Wave1', 'A3:rig', 'progress', { startedAt: t0, toolCalls: 1 }],
    ['Wave1', 'A7:data+rpg', 'progress', { startedAt: t0, toolCalls: 4 }],
  ]
  now += 60_000
  tracker.handleEvent(workflowProgress('A1:core', 10, 60_000, { phase: 'Wave1', live: wave }))
  tracker.handleEvent(workflowProgress('A7:data+rpg', 11, 60_000, { phase: 'Wave1' }))

  now = t0 + 7_084_000
  const update = tracker.handleEvent(workflowProgress('A3:rig', 1_074, 7_084_000, {
    phase: 'Wave1',
    live: [
      ['Wave1', 'A1:core', 'done', { startedAt: t0, toolCalls: 180, durationMs: 3_000_000 }],
      ['Wave1', 'A2:render', 'done', { startedAt: t0, toolCalls: 200, durationMs: 5_000_000 }],
      ['Wave1', 'A3:rig', 'progress', { startedAt: t0, toolCalls: 530 }],
      ['Wave1', 'A7:data+rpg', 'done', { startedAt: t0, toolCalls: 164, durationMs: 4_000_000 }],
    ],
  }))

  // 渲染层（桌面与手机监工页）都只取最后 3 行，汇总必须落在里面。
  const visible = (update.activity?.agents[0]?.activity ?? []).slice(-3)
  assert.equal(visible[0], 'Wave1: A3:rig · 530 tools · 118m4s', '工具数与时长是 rig 自己的，不是整个工作流的累计值')
  assert.equal(visible[1], `${claudeWorkflowSummaryPrefix} 已完成 3/4 · 在跑 1`)
  assert.match(visible[2]!, new RegExp(`^${claudeAgentElapsedPrefix}`, 'u'))

  // 两次状态变化之间的心跳不带 workflow_progress，汇总与该 agent 自己的计数要沿用上一张表。
  now += 5_000
  const heartbeat = tracker.handleEvent(workflowProgress('A3:rig', 1_075, 7_089_000, { phase: 'Wave1' }))
  const afterHeartbeat = heartbeat.activity?.agents[0]?.activity
  assert.deepEqual(progressLines(afterHeartbeat), ['Wave1: A3:rig · 530 tools · 118m9s'])
  assert.equal(summaryLine(afterHeartbeat), `${claudeWorkflowSummaryPrefix} 已完成 3/4 · 在跑 1`)
})

// 2026-09-27 探针回放：刚开跑的条目还没有 toolCalls，若退回心跳 usage（整个工作流累计）会显示 5 tools，
// 下一张表到了又变成自己的 2 tools，数字倒退。
test('once the workflow table is known a progress line never falls back to the workflow-wide tool count', () => {
  const t0 = 1_000_000
  let now = t0
  const tracker = startWorkflow({ now: () => now })
  tracker.handleEvent(workflowProgress('A1:fast', 0, 40, {
    phase: 'Wave1',
    live: [['Wave1', 'A1:fast', 'start', { startedAt: t0 }], ['Wave1', 'A2:mid', 'start', { startedAt: t0 }]],
  }))
  now = t0 + 10_500
  const early = tracker.handleEvent(workflowProgress('A1:fast', 5, 10_500, { phase: 'Wave1' }))
  assert.deepEqual(progressLines(early.activity?.agents[0]?.activity), ['Wave1: A1:fast · 10.5s'])

  now = t0 + 14_300
  const later = tracker.handleEvent(workflowProgress('A1:fast', 7, 14_300, {
    phase: 'Wave1',
    live: [['Wave1', 'A1:fast', 'progress', { startedAt: t0, toolCalls: 2 }], ['Wave1', 'A2:mid', 'progress', { startedAt: t0, toolCalls: 5 }]],
  }))
  assert.deepEqual(progressLines(later.activity?.agents[0]?.activity), ['Wave1: A1:fast · 2 tools · 14.3s'])
})

test('queued Workflow agents are counted in the summary but never get a progress line of their own', () => {
  const tracker = startWorkflow()
  tracker.handleEvent(workflowProgress('A1:core', 3, 30_000, { phase: 'Wave1' }))
  // CLI 把刚入队的 agent 放在批次末尾，description 因而指向一个还没开跑的 agent。
  const update = tracker.handleEvent(workflowProgress('A4:audio', 4, 31_000, {
    phase: 'Wave1',
    live: [
      ['Wave1', 'A1:core', 'progress'],
      ['Wave1', 'A2:render', 'start'],
      ['Wave1', 'A3:rig', 'queued'],
      ['Wave1', 'A4:audio', 'queued'],
    ],
  }))

  const activity = update.activity?.agents[0]?.activity
  assert.deepEqual(progressLines(activity), ['Wave1: A1:core · 3 tools · 30.0s'])
  assert.equal(summaryLine(activity), `${claudeWorkflowSummaryPrefix} 已完成 0/4 · 在跑 2 · 排队 2`)
})

// 2026-09-27 对抗审查实测：列名字的汇总在 217~584px 的列里会折成两行，桌面活动框限高 3 行、底部对齐，
// 折行会把最新那条心跳行挤出框。只报计数，在跑的是谁由上面的心跳行交代。
test('the Workflow summary reports counts only so it stays one short line, in English too', () => {
  const live: WorkflowAgentState[] = [
    ['Scan', 'scan:a', 'done'],
    ['Scan', 'scan:b', 'error'],
    ['Scan', 'scan:c', 'progress'],
    ['Scan', 'scan:d', 'progress'],
    ['Scan', 'scan:e', 'start'],
    ['Scan', 'scan:f (throttle-retry)', 'progress'],
    ['Scan', 'scan:g', 'queued'],
  ]

  const english = startWorkflow({ language: 'en' })
  const en = english.handleEvent(workflowProgress('scan:c', 9, 9_000, { phase: 'Scan', live }))
  assert.equal(summaryLine(en.activity?.agents[0]?.activity),
    `${claudeWorkflowSummaryPrefix} 1/7 done · 4 running · 1 failed · 1 queued`)

  const chinese = startWorkflow()
  const zh = chinese.handleEvent(workflowProgress('scan:c', 9, 9_000, { phase: 'Scan', live }))
  const summary = summaryLine(zh.activity?.agents[0]?.activity)
  assert.equal(summary, `${claudeWorkflowSummaryPrefix} 已完成 1/7 · 在跑 4 · 失败 1 · 排队 1`)
  assert.ok(!summary?.includes('scan:'), '汇总行不列 agent 名字')
})

// 2026-09-27 对抗审查：CLI 2.1.280 没给 label 时取 prompt 前 60 字，模板化 prompt 或循环里复用同一个 label
// 都会撞名；心跳不带 index，分不清是哪一个发的。此前那行借用 index 最大那个的计数，它结束后数字还会倒退。
test('Workflow agents sharing a label share one line that borrows none of their counters', () => {
  const t0 = 1_000_000
  let now = t0 + 60_000
  const tracker = startWorkflow({ now: () => now })
  const three = tracker.handleEvent(workflowProgress('review', 132, 1_200_000, {
    phase: 'Review',
    live: [
      ['Review', 'review', 'progress', { startedAt: t0 - 1_140_000, toolCalls: 80 }],
      ['Review', 'review', 'progress', { startedAt: t0 - 540_000, toolCalls: 40 }],
      ['Review', 'review', 'progress', { startedAt: t0, toolCalls: 12 }],
    ],
  }))
  const activity = three.activity?.agents[0]?.activity
  assert.deepEqual(progressLines(activity), ['Review: review ×3'])
  assert.equal(summaryLine(activity), `${claudeWorkflowSummaryPrefix} 已完成 0/3 · 在跑 3`)

  now += 6_000
  const two = tracker.handleEvent(workflowProgress('review', 140, 1_206_000, {
    phase: 'Review',
    live: [
      ['Review', 'review', 'progress', { startedAt: t0 - 1_140_000, toolCalls: 85 }],
      ['Review', 'review', 'progress', { startedAt: t0 - 540_000, toolCalls: 43 }],
      ['Review', 'review', 'done', { startedAt: t0, toolCalls: 12, durationMs: 66_000 }],
    ],
  }))
  assert.deepEqual(progressLines(two.activity?.agents[0]?.activity), ['Review: review ×2'])

  // 只剩一个同名 agent 在跑时身份不再含糊，计数回来。
  const one = tracker.handleEvent(workflowProgress('review', 150, 1_212_000, {
    phase: 'Review',
    live: [
      ['Review', 'review', 'done', { startedAt: t0 - 1_140_000, toolCalls: 90, durationMs: 1_206_000 }],
      ['Review', 'review', 'progress', { startedAt: t0 - 540_000, toolCalls: 48 }],
      ['Review', 'review', 'done', { startedAt: t0, toolCalls: 12, durationMs: 66_000 }],
    ],
  }))
  assert.deepEqual(progressLines(one.activity?.agents[0]?.activity), ['Review: review · 48 tools · 10m6s'])
})

// 2026-09-27 对抗审查实测：常驻进程的追踪器跨回合存活、从不淘汰条目，结束的 Workflow 仍攥着整张 CLI 原始表
// （每个 agent 约 1KB，20 个工作流 × 50 个 agent 留下 1.48MB），而结束后再没有任何路径读它。
test('a finished Workflow lets go of the raw workflow_progress table', async () => {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  const tracker = startWorkflow()
  let entry: Record<string, unknown> | undefined = {
    type: 'workflow_agent', index: 0, label: 'A1:core', phaseTitle: 'Wave1', state: 'progress', agentId: 'agent-0',
    promptPreview: 'x'.repeat(400),
  }
  const table = new WeakRef(entry)
  tracker.handleEvent({ ...workflowProgress('A1:core', 3, 30_000, { phase: 'Wave1' }), workflow_progress: [entry] })
  entry = undefined
  tracker.handleEvent({ type: 'system', subtype: 'task_notification', task_id: 'wf_native', status: 'completed' })

  await new Promise((resolve) => setImmediate(resolve))
  gc()
  assert.equal(table.deref(), undefined)
})

test('a Workflow that never attached workflow_progress keeps the plain progress lines without a summary', () => {
  const tracker = startWorkflow()
  const update = tracker.handleEvent(workflowProgress('draft:a', 10, 60_000))

  const activity = update.activity?.agents[0]?.activity
  assert.equal(summaryLine(activity), undefined)
  assert.deepEqual(progressLines(activity), ['Drafts: draft:a · 10 tools · 1m0s'])
})

test('preview lines stay bounded so a long-running sub-agent cannot grow without limit', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  for (let index = 0; index < 40; index += 1) {
    tracker.handleEvent(taskProgress(`Running step ${index}`, index + 1, index * 1000))
  }

  const activity = progressLines(tracker.snapshot().agents[0]?.activity)
  assert.ok(activity.length > 0, 'the latest actions must still be visible')
  assert.ok(activity.length <= 8, `preview should stay bounded, got ${activity.length}`)
  assert.match(activity.at(-1)!, /Running step 39/u)
})

// 症状：用户报「面板一直没动」——已运行 26 分钟，三条进度还停在 3.3s/10.7s。
// 根因：2026-08-09 实测 CLI 的 task_progress 只在子代理"完成一次工具调用"时发，
//       子代理执行一条长命令期间整整 155 秒零事件（39.6s → 195.1s）。面板忠实
//       反映最后一次心跳，于是看起来像死了。
// 因此面板必须自带一行本地推算的已运行时长，静默期靠它证明子代理还活着。
test('a running sub-agent carries a locally-computed elapsed line', () => {
  let now = 1_000_000
  const tracker = createClaudeAgentStatusTracker({ now: () => now })
  tracker.handleEvent(taskStarted())

  now += 252_000
  const line = elapsedLine(tracker.snapshot().agents[0]?.activity)
  assert.ok(line, 'a running sub-agent must show how long it has been running')
  assert.match(line, /4/u, `expected 4 minutes in ${line}`)
  assert.match(line, /12/u, `expected 12 seconds in ${line}`)
})

test('the elapsed line keeps moving while the CLI stays silent', () => {
  let now = 1_000_000
  const tracker = createClaudeAgentStatusTracker({ now: () => now })
  tracker.handleEvent(taskStarted())

  const first = elapsedLine(tracker.snapshot().agents[0]?.activity)
  now += 155_000
  const second = elapsedLine(tracker.snapshot().agents[0]?.activity)

  assert.notEqual(first, second, 'a silent CLI must not freeze the panel')
})

test('the elapsed line is always last so the renderer tail-slice keeps it visible', () => {
  let now = 1_000_000
  const tracker = createClaudeAgentStatusTracker({ now: () => now })
  tracker.handleEvent(taskStarted())
  for (let index = 0; index < 5; index += 1) {
    now += 1_000
    tracker.handleEvent(taskProgress(`Running step ${index}`, index + 1, index * 1000))
  }

  const activity = tracker.snapshot().agents[0]?.activity ?? []
  assert.ok(
    activity.at(-1)!.startsWith(claudeAgentElapsedPrefix),
    `elapsed must be the last line, got ${activity.at(-1)}`,
  )
})

test('the elapsed line honours the English locale', () => {
  let now = 1_000_000
  const tracker = createClaudeAgentStatusTracker({ now: () => now, language: 'en' })
  tracker.handleEvent(taskStarted())

  now += 252_000
  const line = elapsedLine(tracker.snapshot().agents[0]?.activity)
  assert.ok(line)
  assert.doesNotMatch(line, /[一-龥]/u, `English locale must not emit CJK: ${line}`)
})

test('task_updated with a terminal status retires the sub-agent from the running panel', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskProgress('Running Count total files', 3, 28570))
  const update = tracker.handleEvent(taskUpdated('completed'))

  assert.equal(update.handled, true)
  assert.ok(update.activity, 'completion must refresh the panel')
  assert.equal(update.activity.agents.length, 0)
  assert.equal(tracker.hasRunningAgents(), false)
})

test('task_notification settles the sub-agent when no task_updated arrives', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  const update = tracker.handleEvent(taskNotification('completed'))

  assert.equal(update.handled, true)
  assert.equal(tracker.hasRunningAgents(), false)
  assert.equal(update.activity?.agents.length, 0)
})

// 2026-08-16 实测 claude 2.1.206：打断整轮时，CLI 在 9ms 内对每个在跑的子代理发
// task_updated {"status":"killed"} + task_notification {"status":"stopped"}，
// 并真的掐死它派生的进程（marker 进程数 4 → 0）。正常跑完时发的则是明确的 "completed"。
// 这两个值当时都没有分支，落进 default 被当成"已完成"——等于把被杀的子代理报成干完了活。
test('a killed sub-agent is reported as interrupted rather than completed', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskUpdated('killed'))

  assert.equal(tracker.getAgent(taskId)?.status, 'interrupted')
  assert.equal(tracker.hasRunningAgents(), false)
})

test('a stopped sub-agent notification is reported as interrupted rather than completed', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskNotification('stopped'))

  assert.equal(tracker.getAgent(taskId)?.status, 'interrupted')
  assert.equal(tracker.hasRunningAgents(), false)
})

test('a failed sub-agent is reported as errored rather than silently completed', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskUpdated('failed'))

  assert.equal(tracker.getAgent(taskId)?.status, 'errored')
  assert.equal(tracker.hasRunningAgents(), false)
})

test('parallel sub-agents are tracked independently', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent({
    ...taskStarted(),
    task_id: 'second-task',
    description: 'Audit theme tokens',
    subagent_type: 'general-purpose',
  })

  const running = tracker.snapshot().agents
  assert.equal(running.length, 2)
  assert.deepEqual(
    running.map((agent) => agent.role),
    ['Explore', 'general-purpose'],
  )

  tracker.handleEvent(taskUpdated('completed'))
  const remaining = tracker.snapshot().agents
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.threadId, 'second-task')
})

// 2026-08-09 实测：CLI 把后台 shell 命令也走 system:task_* 上报，task_type=local_bash 且
// 不带 subagent_type。若不区分，一条后台命令会在面板上冒充成一个"子智能体"。
const backgroundBashStarted = () => ({
  type: 'system',
  subtype: 'task_started',
  task_id: 'bs5i7r4qh',
  tool_use_id: 'toolu_01BackgroundBash',
  description: 'Sleep 15s then echo marker',
  task_type: 'local_bash',
  uuid: '11111111-2222-3333-4444-555555555555',
  session_id: sessionId,
})

test('a backgrounded shell command is not mistaken for a sub-agent', () => {
  const tracker = createClaudeAgentStatusTracker()
  const update = tracker.handleEvent(backgroundBashStarted())

  assert.equal(update.activity, undefined, 'local_bash must not open a sub-agent panel')
  assert.equal(tracker.snapshot().agents.length, 0)
  assert.equal(tracker.hasRunningAgents(), false)
})

test('a backgrounded shell command finishing does not disturb a real sub-agent', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(backgroundBashStarted())
  tracker.handleEvent({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'bs5i7r4qh',
    patch: { status: 'completed', end_time: 1786249729950 },
  })

  assert.equal(tracker.hasRunningAgents(), true, 'the real sub-agent must stay running')
  assert.equal(tracker.snapshot().agents.length, 1)
  assert.equal(tracker.snapshot().agents[0]?.threadId, taskId)
})

test('progress from a backgrounded shell command is not promoted to a sub-agent', () => {
  const tracker = createClaudeAgentStatusTracker()
  const update = tracker.handleEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'bs5i7rqh',
    task_type: 'local_bash',
    description: 'Running Sleep 15s',
    usage: { tool_uses: 1, duration_ms: 1000 },
  })

  assert.equal(update.handled, true)
  assert.equal(update.activity, undefined)
  assert.equal(tracker.snapshot().agents.length, 0)
})

test('unrelated system events are left for the existing pipeline to handle', () => {
  const tracker = createClaudeAgentStatusTracker()

  for (const event of [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'system', subtype: 'status' },
    { type: 'assistant', message: { id: 'msg_1', content: [] } },
    { type: 'result', subtype: 'success' },
  ]) {
    const update = tracker.handleEvent(event)
    assert.equal(update.handled, false, `${JSON.stringify(event)} must not be swallowed`)
    assert.equal(update.activity, undefined)
  }
})

test('malformed sub-agent events degrade silently instead of throwing', () => {
  const tracker = createClaudeAgentStatusTracker()

  for (const event of [
    null,
    undefined,
    'not-an-object',
    { type: 'system', subtype: 'task_started' },
    { type: 'system', subtype: 'task_progress', task_id: taskId },
    { type: 'system', subtype: 'task_updated', task_id: taskId, patch: 'nope' },
  ]) {
    assert.doesNotThrow(() => tracker.handleEvent(event))
  }

  assert.equal(tracker.snapshot().agents.length, 0)
})

test('progress for an unknown task still registers it so late joiners are visible', () => {
  const tracker = createClaudeAgentStatusTracker()
  const update = tracker.handleEvent(taskProgress('Running orphan step', 1, 1000))

  assert.equal(update.handled, true)
  assert.equal(update.activity?.agents.length, 1)
  assert.equal(update.activity?.agents[0]?.threadId, taskId)
})

// 症状：模型每派发一次 Task/Agent，「正在运行的子智能体」面板就多出一条永不退役的「子代理」，
//       真实子代理完成后它仍在"已运行 …"，15s 心跳一直重绘，直到整轮结束才被收掉。
// 根因：2026-09-08 发布审计实测——providers 在 tool_use 到达时先按 tool_use_id 建一条合成
//       条目兜底（Fable 新 CLI 有时不发 system:task_*），但 claude 2.1.263 正常派发时仍会发
//       task_started，且带着同一个 tool_use_id；两条目键不同，谁也不认识谁。
// 被否决：只给 Workflow 建合成条目——Task/Agent 同样会撞上不发 task_* 的 CLI；
//         按 tool_use_id 关联才能兜底与真实两头都对。
test('a synthetic dispatch entry is replaced once the CLI reports task_started for the same tool_use_id', () => {
  const tracker = createClaudeAgentStatusTracker()
  const syntheticId = syntheticClaudeAgentId(toolUseId)
  tracker.beginSynthetic(syntheticId, 'Task')
  assert.equal(tracker.snapshot().agents.length, 1)

  const update = tracker.handleEvent(taskStarted())
  assert.equal(update.activity?.agents.length, 1, 'one dispatch must render as one entry')
  assert.equal(update.activity?.agents[0]?.threadId, taskId)
  assert.equal(tracker.getAgent(syntheticId), undefined)

  tracker.handleEvent(taskNotification('completed'))
  assert.equal(tracker.hasRunningAgents(), false, 'nothing may keep the ticker alive after the real sub-agent settles')
  assert.equal(tracker.completeSynthetic(syntheticId), false)
})

test('a progress heartbeat arriving before task_started also retires the synthetic entry', () => {
  const tracker = createClaudeAgentStatusTracker()
  const syntheticId = syntheticClaudeAgentId(toolUseId)
  tracker.beginSynthetic(syntheticId, 'Agent')

  const update = tracker.handleEvent(taskProgress('Running Count total files', 1, 5159))
  assert.equal(update.activity?.agents.length, 1)
  assert.equal(update.activity?.agents[0]?.threadId, taskId)
  assert.equal(tracker.getAgent(syntheticId), undefined)
})

test('a synthetic Workflow entry stays visible without task_* events and completes at turn end', () => {
  const tracker = createClaudeAgentStatusTracker()
  const syntheticId = syntheticClaudeAgentId('toolu_01WorkflowOnly')
  const begun = tracker.beginSynthetic(syntheticId, 'Workflow')
  assert.equal(begun.agents.length, 1)
  assert.equal(begun.agents[0]?.nickname, 'Workflow')
  assert.equal(tracker.hasRunningAgents(), true)

  assert.equal(tracker.completeSynthetic(syntheticId), true)
  assert.equal(tracker.snapshot().agents.length, 0)
  assert.equal(tracker.hasRunningAgents(), false)
})

test('the synthetic sub-agent nickname honours the English locale', () => {
  const tracker = createClaudeAgentStatusTracker({ language: 'en' })
  const begun = tracker.beginSynthetic(syntheticClaudeAgentId('toolu_01TaskOnly'), 'Task')

  const nickname = begun.agents[0]?.nickname ?? ''
  assert.ok(nickname.length > 0)
  assert.doesNotMatch(nickname, /[一-龥]/u, `English locale must not emit CJK: ${nickname}`)
})

// 症状：后台派发（run_in_background）的 Agent/Task 在启动回执到达的瞬间从面板消失，
//       之后的进度与真实终态全部丢弃，用户看不到它还在跑、也看不到它跑完。
// 根因：2026-09-08 发布审计实测 claude 2.1.263 的顺序是 tool_use → system:task_started（此时合成
//       条目已被别名到原生 task_id）→ user tool_result「Async agent launched successfully」；
//       tool_result 分支把已被原生任务认领的条目当成完成，随后的 task_progress / task_notification
//       撞上「终态不复活」守卫被丢弃。前台 Agent 不受影响：它的 tool_result 在 task_notification 之后。
test('a background Agent launch receipt does not settle the sub-agent the CLI already registered', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.beginSynthetic(syntheticClaudeAgentId(toolUseId), 'Agent')
  tracker.handleEvent(taskStarted())
  tracker.handleEvent({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully. (This tool result is internal metadata, do not repeat it to the user.)' },
  ] } })

  assert.equal(tracker.hasRunningAgents(), true, 'a launch receipt is not a terminal state')
  const progress = tracker.handleEvent(taskProgress('Running Count total files', 1, 5159))
  assert.equal(progress.activity?.agents.length, 1, 'progress after the receipt must still render')
  tracker.handleEvent(taskNotification('completed'))
  assert.equal(tracker.hasRunningAgents(), false)
  assert.equal(tracker.getAgent(taskId)?.status, 'completed')
})

// 症状：模型停止输出的瞬间，仍在后台跑的子代理面板整个消失，之后再也不回来
//   （2026-09-10 用户实测：三个 run_in_background Agent 在根回合 end_turn 后又各跑了 6～12 分钟）。
// 根因：background 集合只登记 Workflow 的回执；普通后台 Agent 的「Async agent launched」回执
//   走了 continue 不登记，回合结束的 finishTurn(keep) 不管 keep 真假都把它们结算成 completed，
//   之后的 task_progress 撞「终态不复活」守卫被丢。
test('a background Agent survives the root turn boundary until its native terminal event', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.beginSynthetic(syntheticClaudeAgentId(toolUseId), 'Agent')
  tracker.handleEvent(taskStarted())
  tracker.handleEvent({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste it to the user.)' },
  ] } })

  assert.equal(tracker.hasBackgroundAgents(), true, 'the launch receipt is the evidence that this agent outlives the turn')
  tracker.finishTurn(true)
  assert.equal(tracker.hasRunningAgents(), true, 'finishTurn must not settle a background agent the CLI is still running')
  assert.equal(tracker.snapshot().agents.length, 1)
  const progress = tracker.handleEvent(taskProgress('Editing lineup.ts', 3, 120_000))
  assert.equal(progress.activity?.agents.length, 1, 'progress after the turn boundary must still render')
  tracker.handleEvent(taskNotification('completed'))
  assert.equal(tracker.hasRunningAgents(), false)
  assert.equal(tracker.getAgent(taskId)?.status, 'completed')
})

// 子 agent 实际用的模型只出现在 sidechain 的 assistant 行里（system:task_* 不带），
// 通过 parent_tool_use_id ↔ tool_use_id 关联到条目。
const sidechainAssistant = (parentToolUseId: string, model: string) => ({
  type: 'assistant',
  parent_tool_use_id: parentToolUseId,
  session_id: sessionId,
  message: {
    model,
    id: 'msg_child',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
  },
})

test('a sidechain assistant line attaches the real model to the sub-agent it belongs to', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())

  const update = tracker.handleEvent(sidechainAssistant(toolUseId, 'claude-haiku-4-5-20251001'))
  // sidechain 行仍不能被当成主 Agent 的事件消费（pitfall #223）。
  assert.equal(update.handled, false)
  assert.equal(update.activity?.agents[0]?.model, 'claude-haiku-4-5-20251001')
  assert.equal(tracker.snapshot().agents[0]?.model, 'claude-haiku-4-5-20251001')

  // 同一模型重复到达不再推快照，避免每条子 agent 输出都刷一次面板。
  const repeat = tracker.handleEvent(sidechainAssistant(toolUseId, 'claude-haiku-4-5-20251001'))
  assert.equal(repeat.handled, false)
  assert.equal(repeat.activity, undefined)
})

test('a sidechain assistant line for an unknown parent tool call changes nothing', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())

  const update = tracker.handleEvent(sidechainAssistant('toolu_unknown', 'claude-opus-5'))
  assert.equal(update.handled, false)
  assert.equal(update.activity, undefined)
  assert.equal(tracker.snapshot().agents[0]?.model, undefined)
})

test('a synthetic Workflow entry also picks up its model from the sidechain', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.beginSynthetic(syntheticClaudeAgentId('toolu_workflow'), 'Workflow')

  const update = tracker.handleEvent(sidechainAssistant('toolu_workflow', 'claude-sonnet-5'))
  assert.equal(update.handled, false)
  assert.equal(update.activity?.agents[0]?.model, 'claude-sonnet-5')
})

// 2026-09-25 用户实测：主回合用 SendMessage 续跑一个已完成的子代理，回执 toolUseResult 带
// resumedAgentId，面板整段空白。
test('SendMessage 续跑已完成的子代理时面板重新显示它', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskNotification('completed'))
  assert.equal(tracker.hasRunningAgents(), false)

  const resumed = tracker.handleEvent({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: [{ type: 'text', text: JSON.stringify({ success: true, resumedAgentId: taskId }) }] }] },
  })
  assert.equal(resumed.activity?.agents.length, 1)
  assert.equal(resumed.activity?.agents[0].status, 'running')
  assert.equal(tracker.hasBackgroundAgents(), true)

  // 续跑后 CLI 的 task_started / progress 不能再被终态守卫丢掉
  const started = tracker.handleEvent(taskStarted())
  assert.equal(started.activity?.agents[0].status, 'running')
  tracker.handleEvent(taskNotification('completed'))
  assert.equal(tracker.hasRunningAgents(), false)
})

test('已完成子代理再次收到 task_started 时复活', () => {
  const tracker = createClaudeAgentStatusTracker()
  tracker.handleEvent(taskStarted())
  tracker.handleEvent(taskNotification('completed'))
  const update = tracker.handleEvent(taskStarted())
  assert.equal(update.activity?.agents.length, 1)
  assert.equal(update.activity?.agents[0].status, 'running')
})
