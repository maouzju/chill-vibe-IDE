import assert from 'node:assert/strict'
import test from 'node:test'
import { createClaudeAgentRuntime } from '../server/claude-agent-runtime.ts'
import type { StreamAgentsActivity } from '../shared/schema.ts'

test('进程级 Workflow 计时跨回合继续，空闲终态和进程释放停止推送', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 })
  const updates: StreamAgentsActivity[] = []
  const runtime = createClaudeAgentRuntime({ language: 'zh-CN', publish: (a) => updates.push(a), readCompletionBoundary: () => 'background-pending' })
  const line = (e: unknown) => runtime.onLine(JSON.stringify(e))
  try {
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Workflow' }] } })
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Workflow launched in background. Task ID: w1\n' }] } })
    t.mock.timers.tick(90_000)
    line({ type: 'result', subtype: 'success' })
    t.mock.timers.tick(120_000)
    assert.equal(updates.at(-1)?.agents[0]?.activity?.at(-1), '⏳ 已运行 3分30秒')
    line({ type: 'stream_event', event: { type: 'message_start' } })
    line({ type: 'result', subtype: 'success' })
    t.mock.timers.tick(30_000)
    assert.equal(updates.at(-1)?.agents[0]?.activity?.at(-1), '⏳ 已运行 4分0秒')
    line({ type: 'system', subtype: 'task_notification', task_id: 'w1', status: 'completed' })
    assert.deepEqual(updates.at(-1)?.agents, [])
    const count = updates.length
    t.mock.timers.tick(60_000)
    assert.equal(updates.length, count)
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'two', name: 'Workflow' }] } })
    runtime.dispose()
    assert.deepEqual(updates.at(-1)?.agents, [])
    const disposedCount = updates.length
    t.mock.timers.tick(60_000)
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'late', name: 'Workflow' }] } })
    assert.equal(updates.length, disposedCount)
  } finally {
    runtime.dispose()
    t.mock.timers.reset()
  }
})

// 症状：后一回合因上游 API 报错结束（result.is_error）时，前一回合仍在后台跑的 Workflow 被标成
//       中断并从面板消失；它真正完成时的 task_notification 又撞上终态守卫被丢弃，面板再也不恢复。
// 根因：2026-09-08 发布审计——is_error 分支用 settleAll 把所有运行中条目一律置为 interrupted，
//       没有区分归属于本回合的条目与跨回合保留的后台条目；后台条目的终态只能由原生事件决定。
test('a failed later turn does not interrupt a background Workflow that is still running', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 })
  const updates: StreamAgentsActivity[] = []
  const runtime = createClaudeAgentRuntime({ language: 'zh-CN', publish: (a) => updates.push(a), readCompletionBoundary: () => 'background-pending' })
  const line = (e: unknown) => runtime.onLine(JSON.stringify(e))
  try {
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Workflow' }] } })
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Workflow launched in background. Task ID: w1\n' }] } })
    line({ type: 'result', subtype: 'success' })
    assert.equal(updates.at(-1)?.agents.length, 1)

    line({ type: 'stream_event', event: { type: 'message_start' } })
    line({ type: 'result', subtype: 'error_during_execution', is_error: true })
    assert.equal(updates.at(-1)?.agents.length, 1, 'the background Workflow must survive an unrelated failed turn')

    t.mock.timers.tick(30_000)
    line({ type: 'system', subtype: 'task_notification', task_id: 'w1', status: 'completed' })
    assert.deepEqual(updates.at(-1)?.agents, [])
  } finally {
    runtime.dispose()
    t.mock.timers.reset()
  }
})

test('原生明确终态优先于旧后台回执，不为普通文本或 sidechain 建计时器', () => {
  const updates: StreamAgentsActivity[] = []
  const runtime = createClaudeAgentRuntime({ language: 'en', publish: (a) => updates.push(a), readCompletionBoundary: () => 'terminal' })
  const event = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Workflow' }] } }
  try {
    runtime.onLine('noise')
    runtime.onLine(JSON.stringify({ ...event, parent_tool_use_id: 'child' }))
    assert.equal(updates.length, 0)
    runtime.onLine(JSON.stringify(event))
    runtime.onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'Workflow launched in background. Task ID: w1\n' }] } }))
    runtime.onLine(JSON.stringify({ type: 'result', subtype: 'success' }))
    assert.deepEqual(updates.at(-1)?.agents, [])
  } finally { runtime.dispose() }
})

// 症状：模型停止输出的瞬间沉底面板消失（2026-09-10 用户实测）。这台机器上 Stop 钩子快照解析失败，
//   boundary 只会是 unknown，此时 keep 完全取决于 tracker 是否认得后台条目。
test('a background Agent keeps running across the root turn when the Stop boundary is unknown', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 })
  const updates: StreamAgentsActivity[] = []
  const runtime = createClaudeAgentRuntime({ language: 'zh-CN', publish: (a) => updates.push(a), readCompletionBoundary: () => 'unknown' })
  const line = (e: unknown) => runtime.onLine(JSON.stringify(e))
  const taskId = 'aa3d60cc650c2864b'
  try {
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { run_in_background: true, subagent_type: 'general-purpose', description: '桶 A' } }] } })
    line({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: 'toolu_bg', description: '桶 A', subagent_type: 'general-purpose', task_type: 'local_agent' })
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste it to the user.)' }] }] } })
    line({ type: 'result', subtype: 'success' })
    assert.equal(updates.at(-1)?.agents.length, 1, 'the root turn ending must not unmount a background Agent')
    assert.equal(updates.at(-1)?.agents[0]?.status, 'running')
    t.mock.timers.tick(30_000)
    line({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: 'toolu_bg', subagent_type: 'general-purpose', description: 'Editing lineup.ts' })
    assert.equal(updates.at(-1)?.agents.length, 1, 'progress after the turn boundary must still render')
    line({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: 'toolu_bg', status: 'completed' })
    assert.deepEqual(updates.at(-1)?.agents, [])
  } finally {
    runtime.dispose()
    t.mock.timers.reset()
  }
})
