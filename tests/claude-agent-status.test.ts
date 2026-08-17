import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claudeAgentElapsedPrefix,
  createClaudeAgentStatusTracker,
} from '../server/claude-agent-status'

// 面板底部那行本地推算的"已运行"不是 CLI 活动，断言真实进度行时要先滤掉。
const progressLines = (activity: string[] | undefined) =>
  (activity ?? []).filter((line) => !line.startsWith(claudeAgentElapsedPrefix))

const elapsedLine = (activity: string[] | undefined) =>
  (activity ?? []).find((line) => line.startsWith(claudeAgentElapsedPrefix))

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
