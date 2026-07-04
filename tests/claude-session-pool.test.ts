import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import {
  ClaudeSessionPool,
  type ClaudeSessionPoolChild,
  type ClaudeTurnAttachment,
} from '../server/claude-session-pool.ts'

type FakeChild = ClaudeSessionPoolChild & {
  stdoutStream: PassThrough
  stderrStream: PassThrough
  stdinChunks: string[]
  killed: boolean
  emitExit: (code: number | null) => void
}

const createFakeChild = (): FakeChild => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const stdinChunks: string[] = []

  const child = {
    stdout,
    stderr,
    stdin: {
      write: (chunk: string) => {
        stdinChunks.push(chunk)
        return true
      },
      end: () => {},
    },
    kill: () => {
      if (child.killed) {
        return true
      }
      child.killed = true
      queueMicrotask(() => emitter.emit('close', null))
      return true
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener)
      return child
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.once(event, listener)
      return child
    },
    stdoutStream: stdout,
    stderrStream: stderr,
    stdinChunks,
    killed: false,
    emitExit: (code: number | null) => {
      child.killed = true
      emitter.emit('close', code)
    },
  }

  return child as FakeChild
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

type AttachmentLog = {
  lines: string[]
  stderrLines: string[]
  closures: Array<number | null>
}

const createAttachment = (): { attachment: ClaudeTurnAttachment; log: AttachmentLog } => {
  const log: AttachmentLog = { lines: [], stderrLines: [], closures: [] }
  return {
    attachment: {
      onLine: (line) => log.lines.push(line),
      onStderrLine: (line) => log.stderrLines.push(line),
      onProcessClosed: (code) => log.closures.push(code),
    },
    log,
  }
}

const createPool = (overrides?: {
  onUnsolicited?: ConstructorParameters<typeof ClaudeSessionPool>[0]['onUnsolicited']
  idleTimeoutMs?: number
}) => {
  return new ClaudeSessionPool({
    onUnsolicited: overrides?.onUnsolicited ?? (() => {}),
    idleTimeoutMs: overrides?.idleTimeoutMs,
  })
}

test('acquireForTurn spawns a new process for an unknown card', async () => {
  const pool = createPool()
  const child = createFakeChild()
  let spawnCount = 0

  const acquired = await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => {
      spawnCount += 1
      return child
    },
  })

  assert.ok(acquired)
  assert.equal(acquired.reused, false)
  assert.equal(spawnCount, 1)
  pool.dispose()
})

test('acquireForTurn reuses a live idle process when signature and session match', async () => {
  const pool = createPool()
  const first = createFakeChild()

  const initial = await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => first,
  })
  assert.ok(initial)

  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.updateSessionId('card-1', 'session-1')
  pool.endTurn('card-1')

  let spawnedAgain = false
  const second = await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: 'session-1',
    spawn: async () => {
      spawnedAgain = true
      return createFakeChild()
    },
  })

  assert.ok(second)
  assert.equal(second.reused, true)
  assert.equal(spawnedAgain, false)
  assert.equal(first.killed, false)
  pool.dispose()
})

test('acquireForTurn kills and respawns when the reuse signature changes', async () => {
  const pool = createPool()
  const first = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => first,
  })
  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.updateSessionId('card-1', 'session-1')
  pool.endTurn('card-1')

  const replacement = createFakeChild()
  const second = await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-b',
    sessionId: 'session-1',
    spawn: async () => replacement,
  })

  assert.ok(second)
  assert.equal(second.reused, false)
  assert.equal(first.killed, true)
  pool.dispose()
})

test('acquireForTurn kills and respawns when the requested session does not match', async () => {
  const pool = createPool()
  const first = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => first,
  })
  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.updateSessionId('card-1', 'session-1')
  pool.endTurn('card-1')

  const second = await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: 'session-other',
    spawn: async () => createFakeChild(),
  })

  assert.ok(second)
  assert.equal(second.reused, false)
  assert.equal(first.killed, true)
  pool.dispose()
})

test('turn lines route to the active attachment and endTurn keeps the process alive', async () => {
  const pool = createPool()
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })

  const { attachment, log } = createAttachment()
  pool.beginTurn('card-1', attachment)

  child.stdoutStream.write('{"type":"system"}\n')
  child.stderrStream.write('warning line\n')
  await waitFor(() => log.lines.length === 1 && log.stderrLines.length === 1)

  assert.deepEqual(log.lines, ['{"type":"system"}'])
  assert.deepEqual(log.stderrLines, ['warning line'])

  pool.endTurn('card-1')
  assert.equal(child.killed, false)
  assert.equal(pool.hasEntry('card-1'), true)
  pool.dispose()
})

test('idle stdout triggers onUnsolicited once and replays buffered lines to the late attachment', async () => {
  const unsolicitedKeys: string[] = []
  let pendingAttach: ((attachment: ClaudeTurnAttachment) => void) | null = null

  const pool = createPool({
    onUnsolicited: (entry, attach) => {
      unsolicitedKeys.push(entry.key)
      pendingAttach = attach
    },
  })
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })
  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.endTurn('card-1')

  child.stdoutStream.write('{"type":"assistant","note":"first"}\n')
  child.stdoutStream.write('{"type":"assistant","note":"second"}\n')
  await waitFor(() => unsolicitedKeys.length === 1 && pendingAttach !== null)

  // Additional idle output must not fire the callback again while unattached.
  child.stdoutStream.write('{"type":"assistant","note":"third"}\n')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(unsolicitedKeys.length, 1)

  const late = createAttachment()
  pendingAttach!(late.attachment)
  await waitFor(() => late.log.lines.length === 3)

  assert.deepEqual(late.log.lines, [
    '{"type":"assistant","note":"first"}',
    '{"type":"assistant","note":"second"}',
    '{"type":"assistant","note":"third"}',
  ])

  // The unsolicited turn now behaves like a normal active turn.
  pool.endTurn('card-1')
  assert.equal(child.killed, false)
  pool.dispose()
})

test('process exit during an active turn notifies the attachment', async () => {
  const pool = createPool()
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })
  const { attachment, log } = createAttachment()
  pool.beginTurn('card-1', attachment)

  child.emitExit(1)
  await waitFor(() => log.closures.length === 1)

  assert.deepEqual(log.closures, [1])
  assert.equal(pool.hasEntry('card-1'), false)
  pool.dispose()
})

test('process exit while idle removes the entry without firing onUnsolicited', async () => {
  let unsolicitedCount = 0
  const pool = createPool({
    onUnsolicited: () => {
      unsolicitedCount += 1
    },
  })
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })
  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.endTurn('card-1')

  child.emitExit(0)
  await waitFor(() => pool.hasEntry('card-1') === false)

  assert.equal(unsolicitedCount, 0)
  pool.dispose()
})

test('a pending unsolicited turn that loses its process replays lines then reports closure', async () => {
  let pendingAttach: ((attachment: ClaudeTurnAttachment) => void) | null = null
  const pool = createPool({
    onUnsolicited: (_entry, attach) => {
      pendingAttach = attach
    },
  })
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })
  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.endTurn('card-1')

  child.stdoutStream.write('{"type":"assistant","note":"tail"}\n')
  await waitFor(() => pendingAttach !== null)
  child.emitExit(1)

  const late = createAttachment()
  pendingAttach!(late.attachment)
  await waitFor(() => late.log.closures.length === 1)

  assert.deepEqual(late.log.lines, ['{"type":"assistant","note":"tail"}'])
  assert.deepEqual(late.log.closures, [1])
  pool.dispose()
})

test('writeUserMessage writes one JSON line to stdin for the pooled process', async () => {
  const pool = createPool()
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })

  const written = pool.writeUserMessage('card-1', '{"type":"user"}')
  assert.equal(written, true)
  assert.deepEqual(child.stdinChunks, ['{"type":"user"}\n'])
  pool.dispose()
})

// stdin.write returning false only signals backpressure — Node has already
// queued the chunk. Treating it as failure used to kill the CLI mid-launch for
// long prompts that overflow the pipe's high-water mark.
test('writeUserMessage treats stdin backpressure as success', async () => {
  const pool = createPool()
  const child = createFakeChild()
  child.stdin!.write = (chunk: string) => {
    child.stdinChunks.push(chunk)
    return false
  }

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })

  const written = pool.writeUserMessage('card-1', '{"type":"user","big":"prompt"}')
  assert.equal(written, true, 'backpressure must not be reported as a failed write')
  assert.deepEqual(child.stdinChunks, ['{"type":"user","big":"prompt"}\n'])
  pool.dispose()
})

test('an idle process is recycled after the idle timeout but stdout resets the timer', async () => {
  const pool = createPool({ idleTimeoutMs: 60 })
  const child = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-1',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => child,
  })
  const { attachment } = createAttachment()
  pool.beginTurn('card-1', attachment)
  pool.endTurn('card-1')

  // Keep the entry warm past the original deadline with idle output, then let
  // the unsolicited turn finish so the idle timer arms again.
  await new Promise((resolve) => setTimeout(resolve, 40))
  child.stdoutStream.write('{"type":"assistant","note":"keepwarm"}\n')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(child.killed, false)

  await waitFor(() => child.killed === true, 2_000)
  assert.equal(pool.hasEntry('card-1'), false)
  pool.dispose()
})

test('closeAll kills every pooled process', async () => {
  const pool = createPool()
  const childA = createFakeChild()
  const childB = createFakeChild()

  await pool.acquireForTurn({
    key: 'card-a',
    signature: 'sig-a',
    sessionId: undefined,
    spawn: async () => childA,
  })
  await pool.acquireForTurn({
    key: 'card-b',
    signature: 'sig-b',
    sessionId: undefined,
    spawn: async () => childB,
  })

  pool.closeAll()

  assert.equal(childA.killed, true)
  assert.equal(childB.killed, true)
  assert.equal(pool.hasEntry('card-a'), false)
  assert.equal(pool.hasEntry('card-b'), false)
  pool.dispose()
})
