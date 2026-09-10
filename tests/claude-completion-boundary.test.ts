import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import type { ChatRequest } from '../shared/schema.ts'
import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import {
  ClaudeSessionPool,
  type ClaudeSessionPoolChild,
} from '../server/claude-session-pool.ts'
import {
  buildClaudeCompletionBoundaryHookCommand,
  clearClaudeCompletionBoundarySnapshot,
  readClaudeCompletionBoundary,
} from '../server/claude-completion-boundary.ts'
import { createClaudeTurnParser } from '../server/providers.ts'

test('ChatManager 的后台计时推送不创建 unsolicited 聊天流', async (t) => {
  const notifications: unknown[] = []
  const manager = new ChatManager({ enableClaudeKeepalive: true, onUnsolicitedStream: (n) => notifications.push(n) })
  t.after(() => manager.closeAll())
  const pool = (manager as unknown as { claudePool: ClaudeSessionPool }).claudePool
  const stdout = new PassThrough()
  const emitter = new EventEmitter()
  const child: ClaudeSessionPoolChild = {
    stdout, stderr: new PassThrough(), stdin: { write: () => true, end: () => {} }, kill: () => true,
    on: (event, cb) => emitter.on(event, cb), once: (event, cb) => emitter.once(event, cb),
  }
  await pool.acquireForTurn({ key: 'runtime-card', signature: 'sig', sessionId: 'session', meta: { language: 'zh-CN' }, spawn: async () => child })
  stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Workflow' }] } }) + '\n')
  assert.equal(notifications.length, 1)
  const first = notifications[0] as { streamId: string; agentStatus: { agents: unknown[] } }
  assert.equal(first.agentStatus.agents.length, 1)
  assert.equal((manager as unknown as { streams: Map<string, unknown> }).streams.size, 0)
  pool.releaseEntry('runtime-card', child)
  const last = notifications.at(-1) as typeof first
  assert.equal(last.streamId, first.streamId)
  assert.deepEqual(last.agentStatus.agents, [])
})

test('Claude Stop snapshot distinguishes native background work from terminal completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-completion-boundary-'))
  const snapshotPath = path.join(root, 'stop.json')

  try {
    await writeFile(snapshotPath, JSON.stringify({
      background_tasks: [
        { id: 'agent-1', type: 'subagent', status: 'running', agent_type: 'general-purpose' },
      ],
      session_crons: [],
    }), 'utf8')
    assert.equal(await readClaudeCompletionBoundary(snapshotPath), 'background-pending')

    await writeFile(snapshotPath, JSON.stringify({
      background_tasks: [],
      session_crons: [{ id: 'cron-1', schedule: '0 9 * * *', recurring: true }],
    }), 'utf8')
    assert.equal(await readClaudeCompletionBoundary(snapshotPath), 'background-pending')

    await writeFile(snapshotPath, JSON.stringify({ background_tasks: [], session_crons: [] }), 'utf8')
    assert.equal(await readClaudeCompletionBoundary(snapshotPath), 'terminal')

    await clearClaudeCompletionBoundarySnapshot(snapshotPath)
    assert.equal(await readClaudeCompletionBoundary(snapshotPath), 'unknown')

    await writeFile(snapshotPath, '{broken', 'utf8')
    assert.equal(await readClaudeCompletionBoundary(snapshotPath), 'unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude Stop hook command quietly writes stdin to the native completion sidecar', () => {
  const windows = buildClaudeCompletionBoundaryHookCommand(
    "C:\\Users\\demo\\stop boundary.json",
    'win32',
  )
  assert.equal(windows.command, 'powershell.exe')
  assert.deepEqual(windows.args.slice(0, 4), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
  ])
  assert.match(windows.args.at(-1) ?? '', /OpenStandardInput.*UTF8Encoding.*ReadToEnd/)
  assert.match(windows.args.at(-1) ?? '', /stop boundary\.json/)

  const posix = buildClaudeCompletionBoundaryHookCommand('/tmp/stop boundary.json', 'linux')
  assert.equal(posix.command, '/bin/sh')
  assert.deepEqual(posix.args.slice(0, 1), ['-c'])
  assert.match(posix.args.at(-1) ?? '', /umask 077/)
  assert.match(posix.args.at(-1) ?? '', /stop boundary\.json/)
})

test('Claude Stop hook command executes quietly and writes a readable native snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-completion-hook-runtime-'))
  const snapshotPath = path.join(root, "stop boundary's.json")
  const hook = buildClaudeCompletionBoundaryHookCommand(snapshotPath)
  const input = JSON.stringify({
    background_tasks: [{ id: 'agent-runtime', status: 'running' }],
    session_crons: [],
  })

  try {
    const result = spawnSync(hook.command, hook.args, {
      input,
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(readClaudeCompletionBoundary(snapshotPath), 'background-pending')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

test('Claude parser classifies a clean result using the native Stop boundary', () => {
  const completions: unknown[] = []
  const observedBoundaries: string[] = []
  const createParser = (completion: 'background-pending' | 'terminal') => createClaudeTurnParser({
    request,
    language: 'zh-CN',
    killChild: () => {},
    readCompletionBoundary: () => completion,
    onCompletionBoundary: (boundary) => observedBoundaries.push(boundary),
    sink: {
      onSession: () => {},
      onDelta: () => {},
      onLog: () => {},
      onAssistantMessage: () => {},
      onActivity: () => {},
      onDone: (payload?: unknown) => completions.push(payload),
      onError: () => {},
    },
  })

  createParser('background-pending').handleLine(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
  }))
  createParser('terminal').handleLine(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
  }))

  assert.deepEqual(completions, [
    { completion: 'background-pending' },
    { completion: 'terminal' },
  ])
  assert.deepEqual(observedBoundaries, ['background-pending', 'terminal'])
})

test('ChatManager forwards the native completion boundary in the done envelope', async (t) => {
  const streamId = 'stream-background-pending'
  const events: StreamEnvelope[] = []
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
    providerLauncher: async (_request, sink) => {
      queueMicrotask(() => sink.onDone({ completion: 'background-pending' }))
      return { kill: () => true } as unknown as ChildProcess
    },
  })
  t.after(() => manager.closeAll())

  manager.createStream({
    ...request,
    streamId,
    cardId: 'card-background-pending',
  })
  manager.subscribe(streamId, (event) => events.push(event))

  const deadline = Date.now() + 2_000
  while (!events.some((event) => event.event === 'done') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.deepEqual(
    events.find((event) => event.event === 'done'),
    {
      event: 'done',
      data: { completion: 'background-pending' },
    },
  )
})

test('ChatManager emits a terminal error when a pending Claude background process dies while idle', async (t) => {
  const notifications: Array<{ cardId: string; streamId: string }> = []
  const manager = new ChatManager({
    enableClaudeKeepalive: true,
    onUnsolicitedStream: (notification) => notifications.push(notification),
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
  })
  t.after(() => manager.closeAll())
  const pool = (manager as unknown as { claudePool: ClaudeSessionPool }).claudePool
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const child: ClaudeSessionPoolChild = {
    stdout,
    stderr,
    stdin: { write: () => true, end: () => {} },
    kill: () => true,
    on: (event: 'close', listener: (code: number | null) => void) => {
      emitter.on(event, listener)
      return emitter
    },
    once: (event: 'close', listener: (code: number | null) => void) => {
      emitter.once(event, listener)
      return emitter
    },
  }

  await pool.acquireForTurn({
    key: 'card-idle-background-loss',
    signature: 'sig-background-loss',
    sessionId: 'session-background-loss',
    meta: { language: 'zh-CN', backgroundWorkPending: true },
    spawn: async () => child,
  })
  emitter.emit('close', 1)

  const deadline = Date.now() + 2_000
  while (notifications.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const notification = notifications[0]
  assert.ok(notification)

  const events: StreamEnvelope[] = []
  manager.subscribe(notification.streamId, (event) => events.push(event))
  assert.deepEqual(
    events.find((event) => event.event === 'error'),
    {
      event: 'error',
      data: {
        message: 'Claude 后台会话已意外结束，等待中的后台工作无法继续。',
        recoverable: false,
      },
    },
  )
})

// 症状：中文 Windows 上 Stop 钩子落盘的快照 179/179 全部 JSON.parse 失败，边界永远是 unknown
//   （2026-09-10 实测 %TEMP%\chill-vibe-claude-completion，自 09-01 起每一份）。
// 根因：新起的 powershell.exe 以 gb2312 解码 stdin；UTF-8 中文后面若紧跟 \"，反斜杠 0x5C 会被当成
//   GBK 尾字节吞掉，字符串提前终止。此前的用例只喂 ASCII，所以一直绿。
test('Claude Stop hook keeps a UTF-8 snapshot intact when the last message holds CJK and escaped quotes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-completion-hook-utf8-'))
  const snapshotPath = path.join(root, 'stop boundary.json')
  const hook = buildClaudeCompletionBoundaryHookCommand(snapshotPath)
  const lastAssistantMessage = '已确认：他说"好"。结束'
  const input = JSON.stringify({
    hook_event_name: 'Stop',
    last_assistant_message: lastAssistantMessage,
    background_tasks: [{ id: 'aa3d60cc650c2864b', status: 'running' }],
    session_crons: [],
  })

  try {
    const result = spawnSync(hook.command, hook.args, {
      input: Buffer.from(input, 'utf8'),
      windowsHide: true,
    })
    assert.equal(result.status, 0, String(result.stderr) || result.error?.message)
    assert.equal(readClaudeCompletionBoundary(snapshotPath), 'background-pending')
    const written = JSON.parse(await readFile(snapshotPath, 'utf8')) as { last_assistant_message?: string }
    assert.equal(written.last_assistant_message, lastAssistantMessage)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
