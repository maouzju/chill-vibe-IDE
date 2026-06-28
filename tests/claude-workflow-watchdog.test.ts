import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatRequest } from '../shared/schema.ts'
import { createClaudeTurnParser } from '../server/providers.ts'

// Regression coverage for the stall watchdog vs. synchronously-awaited background
// tools (the Workflow tool and subagents). In headless `claude -p` mode the CLI
// WAITS for a dispatched Workflow/subagent to finish — emitting no stdout for the
// whole run (default cap 10 min, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) — and the
// result comes back on the same turn. The 120s stall watchdog used to false-kill
// the CLI mid-workflow because Workflow is not a `command` tool and never
// disarmed the watchdog. These tests pin: a Workflow turn stays patient, while an
// ordinary silent turn is still killed.

const baseRequest: ChatRequest = {
  provider: 'claude',
  workspacePath: '.',
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: 'hi',
  attachments: [],
}

const createRecordingSink = () => {
  const record = {
    deltas: [] as string[],
    errors: [] as string[],
    done: false,
    killed: false,
    settled: false,
  }
  return {
    record,
    sink: {
      onSession: () => {},
      onDelta: (content: string) => record.deltas.push(content),
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: () => {
        record.done = true
      },
      onError: (message: string) => {
        record.errors.push(message)
      },
    },
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.')
    }
    await delay(10)
  }
}

const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })
const workflowToolLine = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'tool-workflow-1',
        name: 'Workflow',
        input: { description: 'diagnose', script: 'export const meta = {}' },
      },
    ],
  },
})
const textDeltaLine = (text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  })
const resultLine = JSON.stringify({ type: 'result', subtype: 'success' })

const withShortStallWindow = async (run: () => Promise<void>) => {
  const origStall = process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS
  const origFirst = process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS
  // 50ms is the minimum the env parser accepts; keep the windows tiny so the
  // watchdog would fire well within the test's own 200ms silent wait.
  process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS = '50'
  process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS = '50'
  try {
    await run()
  } finally {
    if (origStall === undefined) delete process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS
    else process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS = origStall
    if (origFirst === undefined) delete process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS
    else process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS = origFirst
  }
}

test('stall watchdog stays patient while a Workflow tool runs (no false kill)', async () => {
  await withShortStallWindow(async () => {
    const { record, sink } = createRecordingSink()
    const parser = createClaudeTurnParser({
      request: baseRequest,
      sink,
      language: 'zh-CN',
      killChild: () => {
        record.killed = true
      },
      onSettled: () => {
        record.settled = true
      },
    })

    parser.armWatchdog()
    parser.handleLine(initLine)
    // The model dispatches a Workflow; the CLI now waits for it, emitting nothing.
    parser.handleLine(workflowToolLine)

    // Stay silent for far longer than the (50ms) stall window.
    await delay(200)

    assert.deepEqual(record.errors, [], 'watchdog must not fire while a Workflow is awaited')
    assert.equal(record.killed, false, 'the pooled CLI must not be killed mid-workflow')
    assert.equal(parser.settled(), false, 'the turn must still be live')

    // The background workflow finishes and its synthesis streams on the same turn.
    parser.handleLine(textDeltaLine('synthesis complete'))
    parser.handleLine(resultLine)
    await waitFor(() => record.done)

    assert.deepEqual(record.errors, [])
    assert.ok(record.deltas.join('').includes('synthesis complete'))
  })
})

test('stall watchdog still kills an ordinary silent turn (control)', async () => {
  await withShortStallWindow(async () => {
    const { record, sink } = createRecordingSink()
    const parser = createClaudeTurnParser({
      request: baseRequest,
      sink,
      language: 'zh-CN',
      killChild: () => {
        record.killed = true
      },
      onSettled: () => {
        record.settled = true
      },
    })

    parser.armWatchdog()
    parser.handleLine(initLine)
    parser.handleLine(textDeltaLine('hello'))
    // No background tool in flight: prolonged silence must trip the watchdog.
    await delay(200)

    assert.ok(record.errors.length > 0, 'watchdog must fire for a genuinely stalled turn')
    assert.equal(record.killed, true)
    assert.equal(parser.settled(), true)
  })
})
