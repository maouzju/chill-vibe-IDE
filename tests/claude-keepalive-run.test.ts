import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import type { ChatRequest } from '../shared/schema.ts'
import {
  ClaudeSessionPool,
  type ClaudeSessionPoolChild,
  type ClaudeSessionPoolEntryView,
  type ClaudeTurnAttachment,
} from '../server/claude-session-pool.ts'
import {
  createClaudeTurnParser,
  createClaudeUnsolicitedTurnAttachment,
} from '../server/providers.ts'

// End-to-end keepalive flow against a real child process: a fake Claude CLI
// that answers a stdin turn, stays alive, wakes itself up later (simulating a
// finished background task re-invoking the agent), and then serves a second
// stdin turn from the same process.
const fakeCliSource = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let turn = 0

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (!message || message.type !== 'user') {
    return
  }

  turn += 1
  if (turn === 1) {
    send({ type: 'system', subtype: 'init', session_id: 'fake-session-1' })
    send({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'turn-one' } },
    })
    send({ type: 'result', subtype: 'success' })
    setTimeout(() => {
      send({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'background-report' },
        },
      })
      send({ type: 'result', subtype: 'success' })
    }, 300)
    return
  }

  send({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'turn-two' } },
  })
  send({ type: 'result', subtype: 'success' })
})

rl.on('close', () => process.exit(0))
`

let tempRoot = ''
let fakeCliPath = ''

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-keepalive-run-'))
  fakeCliPath = path.join(tempRoot, 'fake-claude-cli.cjs')
  await writeFile(fakeCliPath, fakeCliSource, 'utf8')
})

after(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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
      onError: (message: string) => {
        record.errors.push(message)
      },
    },
  }
}

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

const userMessageLine = (text: string) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

test('keepalive flow: turn, unsolicited wake-up, and stdin reuse on one process', async () => {
  const unsolicited: Array<{
    entry: ClaudeSessionPoolEntryView
    attach: (attachment: ClaudeTurnAttachment) => void
  }> = []

  const pool = new ClaudeSessionPool({
    onUnsolicited: (entry, attach) => {
      unsolicited.push({ entry, attach })
    },
  })

  let spawnCount = 0
  const spawnFakeCli = async (): Promise<ClaudeSessionPoolChild | null> => {
    spawnCount += 1
    return spawn(process.execPath, [fakeCliPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as ClaudeSessionPoolChild
  }

  try {
    // ---- Turn 1: spawn + stdin prompt -------------------------------------
    const acquired = await pool.acquireForTurn({
      key: 'card-1',
      signature: 'sig-a',
      sessionId: undefined,
      spawn: spawnFakeCli,
      meta: { language: 'zh-CN', workspacePath: '.', model: '' },
    })
    assert.ok(acquired)
    assert.equal(acquired.reused, false)

    const first = createRecordingSink()
    const firstParser = createClaudeTurnParser({
      request: baseRequest,
      sink: first.sink,
      language: 'zh-CN',
      killChild: () => pool.releaseEntry('card-1'),
      onSettled: () => pool.endTurn('card-1'),
      onSessionId: (sessionId) => pool.updateSessionId('card-1', sessionId),
    })

    pool.beginTurn('card-1', {
      onLine: firstParser.handleLine,
      onStderrLine: firstParser.handleStderrLine,
      onProcessClosed: (code) => {
        if (!firstParser.settled()) {
          firstParser.handleProcessClosed(code)
        }
      },
    })
    assert.equal(pool.writeUserMessage('card-1', userMessageLine('hi')), true)
    firstParser.armWatchdog()

    await waitFor(() => first.record.done)
    assert.deepEqual(first.record.errors, [])
    assert.ok(first.record.deltas.join('').includes('turn-one'))
    assert.deepEqual(first.record.sessions, ['fake-session-1'])
    // The turn settled but the pooled process must stay alive.
    assert.equal(pool.hasEntry('card-1'), true)
    assert.equal(pool.getSessionId('card-1'), 'fake-session-1')

    // ---- Unsolicited wake-up (background task finished) --------------------
    await waitFor(() => unsolicited.length === 1)
    assert.equal(unsolicited[0].entry.key, 'card-1')
    assert.equal(unsolicited[0].entry.sessionId, 'fake-session-1')

    const second = createRecordingSink()
    const unsolicitedAttachment = createClaudeUnsolicitedTurnAttachment({
      entry: unsolicited[0].entry,
      sink: second.sink,
      killChild: () => pool.releaseEntry('card-1'),
      onSettled: () => pool.endTurn('card-1'),
    })
    unsolicited[0].attach(unsolicitedAttachment)

    await waitFor(() => second.record.done)
    assert.deepEqual(second.record.errors, [])
    assert.ok(second.record.deltas.join('').includes('background-report'))
    assert.equal(pool.hasEntry('card-1'), true)

    // ---- Turn 2: reuse the same process over stdin -------------------------
    const reacquired = await pool.acquireForTurn({
      key: 'card-1',
      signature: 'sig-a',
      sessionId: 'fake-session-1',
      spawn: async () => {
        throw new Error('Turn 2 must reuse the pooled process, not respawn.')
      },
    })
    assert.ok(reacquired)
    assert.equal(reacquired.reused, true)
    assert.equal(spawnCount, 1)

    const third = createRecordingSink()
    const thirdParser = createClaudeTurnParser({
      request: { ...baseRequest, sessionId: 'fake-session-1', prompt: 'again' },
      sink: third.sink,
      language: 'zh-CN',
      killChild: () => pool.releaseEntry('card-1'),
      onSettled: () => pool.endTurn('card-1'),
      onSessionId: (sessionId) => pool.updateSessionId('card-1', sessionId),
    })

    pool.beginTurn('card-1', {
      onLine: thirdParser.handleLine,
      onStderrLine: thirdParser.handleStderrLine,
      onProcessClosed: (code) => {
        if (!thirdParser.settled()) {
          thirdParser.handleProcessClosed(code)
        }
      },
    })
    assert.equal(pool.writeUserMessage('card-1', userMessageLine('again')), true)
    thirdParser.armWatchdog()

    await waitFor(() => third.record.done)
    assert.deepEqual(third.record.errors, [])
    assert.ok(third.record.deltas.join('').includes('turn-two'))
  } finally {
    pool.closeAll()
    pool.dispose()
  }
})
