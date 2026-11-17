import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for the unsolicited turn to settle.')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

import { ClaudeSessionPool, type ClaudeSessionPoolChild } from '../server/claude-session-pool.ts'
import {
  createClaudeUnsolicitedTurnAttachment,
  isClaudeSidechainLine,
  isClaudeTurnStartLine,
} from '../server/providers.ts'

// Replay of a synthetic stdout replay for `claude --input-format stream-json`
// process: a background task started in turn one finished after the turn had
// already ended, and the CLI woke itself up and produced a whole new turn with
// no stdin prompt. The fake-CLI keepalive test only proves our plumbing can
// carry such a wake-up; this one proves the shape the CLI emits
// (leading task/init/status diagnostics before any assistant content) survives
// the pool + turn parser and settles instead of hanging the card in streaming.
const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-unsolicited-real-wake.jsonl',
)

const createRecordingSink = () => {
  const record = {
    sessions: [] as string[],
    deltas: [] as string[],
    errors: [] as string[],
    done: false,
  }

  return {
    record,
    sink: {
      onSession: (sessionId: string) => record.sessions.push(sessionId),
      onDelta: (content: string) => record.deltas.push(content),
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: () => {
        record.done = true
      },
      onError: (message: string) => record.errors.push(message),
    },
  }
}

const createStubChild = () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child: ClaudeSessionPoolChild = {
    stdout,
    stderr,
    stdin: { write: () => true, end: () => {} },
    kill: () => true,
    on: () => undefined,
    once: () => undefined,
  }
  return { child, stdout }
}

test('real CLI background wake-up replays into a settled turn', async () => {
  const lines = (await readFile(fixturePath, 'utf8')).split('\n').filter((line) => line.trim())
  assert.ok(lines.length > 0, 'fixture must not be empty')

  const { record, sink } = createRecordingSink()
  let settled = 0

  const pool = new ClaudeSessionPool({
    idleTimeoutMs: 60_000,
    shouldWakeOnLine: isClaudeTurnStartLine,
    onUnsolicited: (entry, attach) => {
      attach(
        createClaudeUnsolicitedTurnAttachment({
          entry,
          sink,
          killChild: () => {},
          onSettled: () => {
            settled += 1
          },
        }),
      )
    },
  })

  const { child, stdout } = createStubChild()
  const acquired = await pool.acquireForTurn({
    key: 'card-real',
    signature: 'sig',
    sessionId: 'session-real',
    spawn: async () => child,
    meta: { language: 'zh-CN', workspacePath: '.', model: 'claude-opus-4-8' },
  })
  assert.ok(acquired)

  // The pool stays idle (no beginTurn): feed the recorded wake-up through the
  // real stdout pipe exactly as the CLI emitted it. The first line is a task
  // diagnostic, not assistant content.
  for (const line of lines) {
    stdout.write(`${line}\n`)
  }
  await waitFor(() => record.done || record.errors.length > 0)

  assert.equal(record.errors.length, 0, `unexpected errors: ${record.errors.join(' | ')}`)
  assert.ok(
    record.deltas.join('').includes('background probe completed'),
    `assistant text missing, got: ${record.deltas.join('')}`,
  )
  assert.equal(record.done, true, 'turn must reach onDone (card would stay streaming otherwise)')
  assert.equal(settled, 1, 'turn must settle exactly once')

  pool.closeAll()
})

test('idle task diagnostics alone do not fabricate an unsolicited turn', async () => {
  const lines = (await readFile(fixturePath, 'utf8')).split('\n').filter((line) => line.trim())
  // The synthetic capture leads with three pure task-bookkeeping lines before the CLI
  // actually re-invokes the agent. On their own they mean "a background task
  // changed state", not "a new turn started" — waking a stream on them would put
  // the card into `streaming` with nothing behind it until the stall watchdog
  // fires minutes later.
  const diagnostics = lines.slice(0, 3)
  const turnStart = lines.slice(3)

  let wakeUps = 0
  const { record, sink } = createRecordingSink()
  const pool = new ClaudeSessionPool({
    idleTimeoutMs: 60_000,
    shouldWakeOnLine: isClaudeTurnStartLine,
    onUnsolicited: (entry, attach) => {
      wakeUps += 1
      attach(
        createClaudeUnsolicitedTurnAttachment({
          entry,
          sink,
          killChild: () => {},
          onSettled: () => {},
        }),
      )
    },
  })

  const { child, stdout } = createStubChild()
  assert.ok(
    await pool.acquireForTurn({
      key: 'card-diag',
      signature: 'sig',
      sessionId: 'session-diag',
      spawn: async () => child,
      meta: { language: 'zh-CN', workspacePath: '.', model: 'claude-opus-4-8' },
    }),
  )

  for (const line of diagnostics) {
    stdout.write(`${line}\n`)
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(wakeUps, 0, 'task bookkeeping alone must not wake a stream')

  for (const line of turnStart) {
    stdout.write(`${line}\n`)
  }
  await waitFor(() => record.done || record.errors.length > 0)

  assert.equal(wakeUps, 1, 'the real turn must still wake exactly one stream')
  assert.equal(record.errors.length, 0, `unexpected errors: ${record.errors.join(' | ')}`)
  assert.ok(
    record.deltas.join('').includes('background probe completed'),
    'buffered diagnostics must replay without swallowing the assistant text',
  )
  assert.equal(record.done, true)

  pool.closeAll()
})

test('idle child-agent sidechain output does not start a new owner-card turn', () => {
  const sidechainLine = JSON.stringify({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_parent_agent_call',
    event: {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    },
  })

  assert.equal(
    isClaudeTurnStartLine(sidechainLine),
    false,
    'Explore/Agent sidechain progress must not wake the already-finished parent card',
  )
  assert.equal(isClaudeSidechainLine(sidechainLine), true)
})

test('idle child-agent sidechain output is discarded before a later real wake-up', async () => {
  const receivedLines: string[] = []
  let wakeUps = 0
  const pool = new ClaudeSessionPool({
    idleTimeoutMs: 60_000,
    shouldWakeOnLine: isClaudeTurnStartLine,
    shouldIgnoreIdleLine: isClaudeSidechainLine,
    onUnsolicited: (_entry, attach) => {
      wakeUps += 1
      attach({
        onLine: (line) => receivedLines.push(line),
        onStderrLine: () => {},
        onProcessClosed: () => {},
      })
    },
  })

  const { child, stdout } = createStubChild()
  assert.ok(
    await pool.acquireForTurn({
      key: 'card-sidechain',
      signature: 'sig',
      sessionId: 'session-sidechain',
      spawn: async () => child,
    }),
  )

  const sidechainLine = JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: 'toolu_parent_agent_call',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] },
  })
  stdout.write(`${sidechainLine}\n`)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(wakeUps, 0)

  const topLevelInit = JSON.stringify({
    type: 'system',
    subtype: 'init',
    parent_tool_use_id: null,
  })
  stdout.write(`${topLevelInit}\n`)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(wakeUps, 0, 'system/init is only a preamble and must not open the owner-card stream')

  const topLevelTurnStart = JSON.stringify({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
    },
  })
  stdout.write(`${topLevelTurnStart}\n`)
  await waitFor(() => wakeUps === 1)

  assert.deepEqual(receivedLines, [topLevelInit, topLevelTurnStart])
  pool.closeAll()
})

// 2026-11-16 实测（CLI 2.1.322 + 恒 429 的假中转站）：被 task-notification 唤醒的回合如果
// 首 token 前就失败，全程只有 system/status、system/api_retry、合成 assistant、result(is_error)，
// 没有任何 stream_event/message_start。
const failedWakeFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-unsolicited-failed-wake.jsonl',
)

test('a background wake-up that fails before the first token still surfaces its error', async () => {
  const lines = (await readFile(failedWakeFixturePath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
  assert.ok(
    !lines.some((line) => line.includes('"message_start"')),
    'fixture must reproduce the no-message_start shape',
  )

  const { record, sink } = createRecordingSink()
  let settled = 0
  let wakeUps = 0
  const pool = new ClaudeSessionPool({
    idleTimeoutMs: 60_000,
    shouldWakeOnLine: isClaudeTurnStartLine,
    shouldIgnoreIdleLine: isClaudeSidechainLine,
    onUnsolicited: (entry, attach) => {
      wakeUps += 1
      attach(
        createClaudeUnsolicitedTurnAttachment({
          entry,
          sink,
          killChild: () => {},
          onSettled: () => {
            settled += 1
          },
        }),
      )
    },
  })

  const { child, stdout } = createStubChild()
  assert.ok(
    await pool.acquireForTurn({
      key: 'card-failed-wake',
      signature: 'sig',
      sessionId: 'session-failed-wake',
      spawn: async () => child,
      meta: { language: 'zh-CN', workspacePath: '.', model: 'claude-fable-5-2' },
    }),
  )

  // 重试期间的 bookkeeping 不能提前唤醒：后面没有 result 时卡片会空挂在 streaming。
  for (const line of lines.slice(0, -1)) {
    stdout.write(`${line}\n`)
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(wakeUps, 0, 'retry bookkeeping alone must not wake a stream')

  stdout.write(`${lines.at(-1)}\n`)
  await waitFor(() => record.done || record.errors.length > 0)

  assert.equal(wakeUps, 1, 'the failed result must wake exactly one stream')
  assert.equal(record.done, false, 'a failed wake-up must not be reported as done')
  assert.equal(record.errors.length, 1, 'the API error must reach the card exactly once')
  assert.match(record.errors[0], /429/)
  assert.equal(settled, 1, 'turn must settle exactly once')

  pool.closeAll()
})

test('only a failed top-level result wakes an idle card without message_start', () => {
  const result = (patch: Record<string, unknown>) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...patch })

  assert.equal(isClaudeTurnStartLine(result({ is_error: true, terminal_reason: 'api_error' })), true)
  // 成功的 result 不可能没有先到的 message_start；单独到达只会是迟到的收尾，不能造出空回合。
  assert.equal(isClaudeTurnStartLine(result({})), false)
  assert.equal(
    isClaudeTurnStartLine(result({ is_error: true, parent_tool_use_id: 'toolu_parent_agent_call' })),
    false,
  )
  assert.equal(
    isClaudeTurnStartLine(JSON.stringify({ type: 'system', subtype: 'api_retry', error_status: 429 })),
    false,
  )
})
