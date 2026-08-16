import assert from 'node:assert/strict'
import test from 'node:test'

import { parseClaudeToolResults } from '../server/claude-tool-result.ts'
import { createClaudeTurnParser } from '../server/providers.ts'
import type { ChatRequest, StreamActivity } from '../shared/schema.ts'

// 2026-08-16 实测夹具，claude 2.1.206：
//   claude -p "Use the Bash tool to run exactly: exit 3" --output-format stream-json --verbose
// tool_result 是 **user 事件里的数组元素**，而旧代码只在 `typeof content === 'string'`
// 时才往下走，所以这一整块（含 is_error 与 tool_use_id）从来没被读过。
const failedToolResultMessage = {
  role: 'user',
  content: [
    {
      type: 'tool_result',
      content: 'Exit code 3',
      is_error: true,
      tool_use_id: 'toolu_01NpX3dS52wBjGV3yHKKcGrw',
    },
  ],
}

const successToolResultMessage = {
  role: 'user',
  content: [
    {
      tool_use_id: 'toolu_014QYLZqGeqLsSuc6cDqJNFD',
      type: 'tool_result',
      content: 'hi',
      is_error: false,
    },
  ],
}

test('a failed Bash tool_result exposes its error flag and exit code', () => {
  const [result] = parseClaudeToolResults(failedToolResultMessage)

  assert.equal(result?.toolUseId, 'toolu_01NpX3dS52wBjGV3yHKKcGrw')
  assert.equal(result?.isError, true)
  assert.equal(result?.text, 'Exit code 3')
  // 退出码只在正文里，CLI 不给结构化字段——这是唯一的来源。
  assert.equal(result?.exitCode, 3)
})

test('a successful tool_result reports exit code 0', () => {
  const [result] = parseClaudeToolResults(successToolResultMessage)

  assert.equal(result?.isError, false)
  assert.equal(result?.text, 'hi')
  assert.equal(result?.exitCode, 0)
})

test('a failing non-command tool has no exit code to report', () => {
  // Read/Edit 之类失败时没有退出码概念，编一个 1 出来会让 UI 显示假徽标。
  const [result] = parseClaudeToolResults({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        content: 'File does not exist.',
        is_error: true,
        tool_use_id: 'toolu_read_1',
      },
    ],
  })

  assert.equal(result?.isError, true)
  assert.equal(result?.exitCode, null)
})

test('the legacy string-content shape yields nothing instead of throwing', () => {
  // 旧路径（<local-command-stdout> 标签）仍然要能走，别在这里炸。
  assert.deepEqual(parseClaudeToolResults({ role: 'user', content: 'plain text' }), [])
  assert.deepEqual(parseClaudeToolResults(null), [])
  assert.deepEqual(parseClaudeToolResults({ role: 'user' }), [])
})

test('array content without any tool_result block yields nothing', () => {
  assert.deepEqual(
    parseClaudeToolResults({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
    [],
  )
})

// ---------------------------------------------------------------------------
// 端到端：完整事件序列走生产 parser，命令卡必须带上失败状态与真实退出码
// ---------------------------------------------------------------------------

const request: ChatRequest = {
  provider: 'claude',
  workspacePath: '.',
  model: 'claude-opus-5',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: 'test',
  attachments: [],
}

const runCommandTurn = (toolResultBlock: Record<string, unknown>) => {
  const activities: StreamActivity[] = []
  const parser = createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    sink: {
      onSession: () => {},
      onDelta: () => {},
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: (activity) => activities.push(activity),
      onDone: () => {},
      onError: () => {},
    },
  })

  parser.handleLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_cmd_1', name: 'Bash', input: { command: 'exit 3' } },
        ],
      },
    }),
  )
  parser.handleLine(
    JSON.stringify({ type: 'user', message: { role: 'user', content: [toolResultBlock] } }),
  )

  return activities.filter(
    (activity): activity is Extract<StreamActivity, { kind: 'command' }> =>
      activity.kind === 'command',
  )
}

test('a failing command surfaces as failed with its real exit code', () => {
  const commands = runCommandTurn({
    type: 'tool_result',
    content: 'Exit code 3',
    is_error: true,
    tool_use_id: 'toolu_cmd_1',
  })

  const settled = commands.at(-1)
  assert.equal(settled?.status, 'failed')
  // 旧实现这里恒为 null，退出码徽标因此永远不显示。
  assert.equal(settled?.exitCode, 3)
  assert.equal(settled?.output, 'Exit code 3')
})

test('a succeeding command still settles as completed with exit code 0', () => {
  const commands = runCommandTurn({
    type: 'tool_result',
    content: 'hi',
    is_error: false,
    tool_use_id: 'toolu_cmd_1',
  })

  const settled = commands.at(-1)
  assert.equal(settled?.status, 'completed')
  assert.equal(settled?.exitCode, 0)
  assert.equal(settled?.output, 'hi')
})

test('a tool_result for a different tool_use never settles this command as failed', () => {
  // 并行工具时错配的代价是"另一个工具失败了，这条命令被标红"。
  const commands = runCommandTurn({
    type: 'tool_result',
    content: 'Exit code 9',
    is_error: true,
    tool_use_id: 'toolu_some_other_tool',
  })

  const settled = commands.at(-1)
  assert.equal(settled?.status, 'completed')
  assert.equal(settled?.exitCode, null)
})

test('multiple parallel tool results are all returned with their own ids', () => {
  // 并行 Bash 是常态；靠 tool_use_id 配对才不会互相顶掉（旧的 lastCommand 是单槽）。
  const results = parseClaudeToolResults({
    role: 'user',
    content: [
      { type: 'tool_result', content: 'a', is_error: false, tool_use_id: 'toolu_a' },
      { type: 'tool_result', content: 'Exit code 1', is_error: true, tool_use_id: 'toolu_b' },
    ],
  })

  assert.equal(results.length, 2)
  assert.equal(results[0]?.toolUseId, 'toolu_a')
  assert.equal(results[1]?.exitCode, 1)
})
