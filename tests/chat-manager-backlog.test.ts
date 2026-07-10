import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  compactStreamEnvelopeForBacklog,
  appendStreamEnvelopeToBacklog,
  buildStreamErrorPayload,
  buildUserMessageEnvelope,
  maxBacklogCommandOutputChars,
} from '../server/chat-manager.ts'
import type { StreamEnvelope } from '../server/chat-manager.ts'
import type { StreamActivity } from '../shared/schema.ts'

const makeCommandActivity = (itemId: string, output: string): StreamEnvelope => ({
  event: 'activity',
  data: {
    itemId,
    kind: 'command',
    status: 'in_progress',
    command: 'node noisy.js',
    output,
    exitCode: null,
  },
})

type CommandActivityEnvelope = StreamEnvelope & {
  event: 'activity'
  data: Extract<StreamActivity, { kind: 'command' }>
}

const getCommandActivity = (payload: StreamEnvelope): CommandActivityEnvelope => {
  assert.equal(payload.event, 'activity')
  assert.equal((payload.data as { kind?: unknown }).kind, 'command')
  return payload as CommandActivityEnvelope
}

test('chat stream backlog compacts huge command output before retaining it', () => {
  const hugeOutput = `${'A'.repeat(maxBacklogCommandOutputChars)}${'B'.repeat(20_000)}`

  const compacted = compactStreamEnvelopeForBacklog(makeCommandActivity('cmd-1', hugeOutput))

  const compactedCommand = getCommandActivity(compacted)
  assert.ok(
    compactedCommand.data.output.length < hugeOutput.length,
    'retained command output should be smaller than the raw provider payload',
  )
  assert.ok(
    compactedCommand.data.output.length <= maxBacklogCommandOutputChars + 256,
    'retained command output should stay under a bounded budget plus truncation marker',
  )
  assert.match(compactedCommand.data.output, /truncated/i)
})

test('chat stream backlog coalesces repeated structured activity updates by item id', () => {
  const backlog: StreamEnvelope[] = []

  appendStreamEnvelopeToBacklog(backlog, makeCommandActivity('cmd-1', 'first'))
  appendStreamEnvelopeToBacklog(backlog, makeCommandActivity('cmd-1', 'second'))
  appendStreamEnvelopeToBacklog(backlog, makeCommandActivity('cmd-2', 'third'))

  assert.equal(backlog.length, 2)
  assert.ok(backlog[0])
  const firstCommand = getCommandActivity(backlog[0])
  assert.equal(firstCommand.data.output, 'second')
  assert.ok(backlog[1])
  const secondCommand = getCommandActivity(backlog[1])
  assert.equal(secondCommand.data.output, 'third')
})

test('recoverable resume errors carry the latest known session id', () => {
  assert.deepEqual(
    buildStreamErrorPayload(
      'Selected model is at capacity. Please try a different model.',
      undefined,
      {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
      ' session-1 ',
    ),
    {
      message: 'Selected model is at capacity. Please try a different model.',
      recoverable: true,
      recoveryMode: 'resume-session',
      sessionId: 'session-1',
    },
  )
})

test('user prompts become user_message envelopes so remote monitors can mirror them', () => {
  // 手机监工发的需求（以及电脑端发的）都要能出现在手机详情页的消息流里：
  // createStream 必须把 prompt 作为 user_message 事件进 backlog 并广播。
  assert.deepEqual(buildUserMessageEnvelope('谢谢'), {
    event: 'user_message',
    data: { content: '谢谢' },
  })
  assert.equal(buildUserMessageEnvelope('   '), null)
  assert.equal(buildUserMessageEnvelope(''), null)
})

test('createStream emits the user_message envelope before the provider starts', () => {
  // 顺序保证：user 消息要先于任何 assistant 输出进 backlog，late-joiner
  // 重放 backlog 时才能看到"需求在前、回答在后"的正确时间线。
  const source = readFileSync(new URL('../server/chat-manager.ts', import.meta.url), 'utf8')
  const createStreamBody = source.slice(source.indexOf('createStream('))
  const emitIndex = createStreamBody.indexOf('buildUserMessageEnvelope')
  const startIndex = createStreamBody.indexOf('this.startProvider')
  assert.ok(emitIndex >= 0, 'createStream must broadcast the user prompt envelope')
  assert.ok(emitIndex < startIndex, 'user_message must be emitted before startProvider')
})
