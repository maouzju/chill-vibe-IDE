import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactStreamEnvelopeForBacklog,
  appendStreamEnvelopeToBacklog,
  buildStreamErrorPayload,
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
