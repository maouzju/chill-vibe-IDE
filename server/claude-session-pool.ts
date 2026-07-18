import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'

// Long-lived Claude CLI process pool, keyed by card. The pool only understands
// process lifecycle and line routing; it never parses stream-json semantics.
// Turn parsing stays in providers.ts and is attached per turn. While a process
// is idle (between turns) any stdout means the CLI woke itself up — typically a
// background task finishing and re-invoking the agent — and is surfaced through
// the onUnsolicited callback so the host can attach a fresh stream to the card.

export type ClaudeSessionPoolChild = {
  stdout: Readable | null
  stderr: Readable | null
  stdin: { write: (chunk: string) => boolean; end: () => void } | null
  kill: () => boolean
  on: (event: 'close', listener: (code: number | null) => void) => unknown
  once: (event: 'close', listener: (code: number | null) => void) => unknown
}

export type ClaudeTurnAttachment = {
  onLine: (line: string) => void
  onStderrLine: (line: string) => void
  onProcessClosed: (code: number | null) => void
}

export type ClaudeSessionPoolEntryView = {
  key: string
  sessionId: string | null
  meta: Record<string, unknown>
  child: ClaudeSessionPoolChild
}

type PoolEntry = {
  key: string
  child: ClaudeSessionPoolChild
  signature: string
  sessionId: string | null
  meta: Record<string, unknown>
  state: 'idle' | 'turn-active'
  attachment: ClaudeTurnAttachment | null
  // Idle output buffered between the unsolicited wake-up and the host attach.
  pendingUnsolicited: boolean
  bufferedStdout: string[]
  bufferedStderr: string[]
  closedCode: number | null
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | undefined
  stdoutReader: Interface | null
  stderrReader: Interface | null
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000

const resolveDefaultIdleTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.CHILL_VIBE_CLAUDE_KEEPALIVE_IDLE_MS ?? '', 10)
  if (Number.isFinite(parsed) && parsed >= 50) {
    return parsed
  }
  return DEFAULT_IDLE_TIMEOUT_MS
}

export class ClaudeSessionPool {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly acquireGenerations = new Map<string, number>()
  private readonly onUnsolicited: (
    entry: ClaudeSessionPoolEntryView,
    attach: (attachment: ClaudeTurnAttachment) => void,
  ) => void
  private readonly idleTimeoutMs: number
  private disposed = false

  constructor(options: {
    onUnsolicited: (
      entry: ClaudeSessionPoolEntryView,
      attach: (attachment: ClaudeTurnAttachment) => void,
    ) => void
    idleTimeoutMs?: number
  }) {
    this.onUnsolicited = options.onUnsolicited
    this.idleTimeoutMs = options.idleTimeoutMs ?? resolveDefaultIdleTimeoutMs()
  }

  hasEntry(key: string) {
    return this.entries.has(key)
  }

  getSessionId(key: string) {
    return this.entries.get(key)?.sessionId ?? null
  }

  isTurnActive(key: string) {
    return this.entries.get(key)?.state === 'turn-active'
  }

  async acquireForTurn(options: {
    key: string
    signature: string
    sessionId: string | undefined
    spawn: () => Promise<ClaudeSessionPoolChild | null>
    meta?: Record<string, unknown>
  }): Promise<{ child: ClaudeSessionPoolChild; reused: boolean } | null> {
    const generation = (this.acquireGenerations.get(options.key) ?? 0) + 1
    this.acquireGenerations.set(options.key, generation)
    const existing = this.entries.get(options.key)

    if (existing) {
      const requestedSessionId = options.sessionId?.trim() || null
      const reusable =
        !existing.closed &&
        existing.state === 'idle' &&
        !existing.pendingUnsolicited &&
        existing.signature === options.signature &&
        requestedSessionId !== null &&
        existing.sessionId === requestedSessionId

      if (reusable) {
        return { child: existing.child, reused: true }
      }

      this.removeEntry(existing, { kill: true })
    }

    const child = await options.spawn()
    if (!child) {
      return null
    }

    if (this.disposed || this.acquireGenerations.get(options.key) !== generation) {
      child.kill()
      return null
    }

    const entry: PoolEntry = {
      key: options.key,
      child,
      signature: options.signature,
      sessionId: options.sessionId?.trim() || null,
      meta: options.meta ?? {},
      state: 'idle',
      attachment: null,
      pendingUnsolicited: false,
      bufferedStdout: [],
      bufferedStderr: [],
      closedCode: null,
      closed: false,
      idleTimer: undefined,
      stdoutReader: null,
      stderrReader: null,
    }

    this.entries.set(options.key, entry)
    this.wireChild(entry)
    this.armIdleTimer(entry)
    return { child, reused: false }
  }

  beginTurn(key: string, attachment: ClaudeTurnAttachment, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (!entry || (expectedChild && entry.child !== expectedChild)) {
      return false
    }

    entry.state = 'turn-active'
    entry.attachment = attachment
    entry.pendingUnsolicited = false
    entry.bufferedStdout = []
    entry.bufferedStderr = []
    this.clearIdleTimer(entry)
    return true
  }

  endTurn(key: string, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (!entry || (expectedChild && entry.child !== expectedChild)) {
      return
    }

    entry.state = 'idle'
    entry.attachment = null
    entry.pendingUnsolicited = false
    entry.bufferedStdout = []
    entry.bufferedStderr = []
    this.armIdleTimer(entry)
  }

  updateSessionId(key: string, sessionId: string, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (entry && (!expectedChild || entry.child === expectedChild) && sessionId.trim()) {
      entry.sessionId = sessionId.trim()
    }
  }

  writeUserMessage(key: string, jsonLine: string, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (
      !entry ||
      (expectedChild && entry.child !== expectedChild) ||
      entry.closed ||
      !entry.child.stdin
    ) {
      return false
    }

    try {
      // stdin.write returning false only means backpressure — the chunk is
      // already queued and will drain. Long prompts routinely overflow the
      // pipe's high-water mark, so that return value must not be treated as a
      // failed write (it used to kill the CLI and error the card).
      entry.child.stdin.write(`${jsonLine}\n`)
      return true
    } catch {
      return false
    }
  }

  releaseEntry(key: string, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (entry && (!expectedChild || entry.child === expectedChild)) {
      this.invalidatePendingAcquire(key)
      this.removeEntry(entry, { kill: true })
    } else if (!expectedChild) {
      this.invalidatePendingAcquire(key)
    }
  }

  closeAll() {
    for (const key of this.acquireGenerations.keys()) {
      this.invalidatePendingAcquire(key)
    }
    for (const entry of [...this.entries.values()]) {
      this.removeEntry(entry, { kill: true })
    }
  }

  dispose() {
    this.disposed = true
    this.closeAll()
  }

  private invalidatePendingAcquire(key: string) {
    this.acquireGenerations.set(key, (this.acquireGenerations.get(key) ?? 0) + 1)
  }

  private wireChild(entry: PoolEntry) {
    if (entry.child.stdout) {
      entry.stdoutReader = createInterface({ input: entry.child.stdout })
      entry.stdoutReader.on('line', (line) => this.handleStdoutLine(entry, line))
    }

    if (entry.child.stderr) {
      entry.stderrReader = createInterface({ input: entry.child.stderr })
      entry.stderrReader.on('line', (line) => this.handleStderrLine(entry, line))
    }

    entry.child.once('close', (code) => this.handleChildClose(entry, code))
  }

  private handleStdoutLine(entry: PoolEntry, line: string) {
    if (entry.state === 'turn-active' && entry.attachment) {
      entry.attachment.onLine(line)
      return
    }

    // Idle output: the CLI woke itself (e.g. a background task finished and the
    // agent resumed). Buffer everything until the host attaches a fresh stream.
    entry.bufferedStdout.push(line)
    this.armIdleTimer(entry)

    if (!entry.pendingUnsolicited) {
      entry.pendingUnsolicited = true
      const view: ClaudeSessionPoolEntryView = {
        key: entry.key,
        sessionId: entry.sessionId,
        meta: entry.meta,
        child: entry.child,
      }
      this.onUnsolicited(view, (attachment) => this.attachUnsolicited(entry, attachment))
    }
  }

  private handleStderrLine(entry: PoolEntry, line: string) {
    if (entry.state === 'turn-active' && entry.attachment) {
      entry.attachment.onStderrLine(line)
      return
    }

    // Stray idle diagnostics alone must not fabricate an unsolicited turn.
    entry.bufferedStderr.push(line)
  }

  private attachUnsolicited(entry: PoolEntry, attachment: ClaudeTurnAttachment) {
    entry.state = 'turn-active'
    entry.attachment = attachment
    entry.pendingUnsolicited = false
    this.clearIdleTimer(entry)

    const stdoutBacklog = entry.bufferedStdout
    const stderrBacklog = entry.bufferedStderr
    entry.bufferedStdout = []
    entry.bufferedStderr = []

    for (const line of stderrBacklog) {
      attachment.onStderrLine(line)
    }
    for (const line of stdoutBacklog) {
      attachment.onLine(line)
    }

    if (entry.closed) {
      attachment.onProcessClosed(entry.closedCode)
    }
  }

  private handleChildClose(entry: PoolEntry, code: number | null) {
    entry.closed = true
    entry.closedCode = code
    this.clearIdleTimer(entry)
    entry.stdoutReader?.close()
    entry.stderrReader?.close()

    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }

    if (entry.state === 'turn-active' && entry.attachment) {
      entry.attachment.onProcessClosed(code)
      entry.attachment = null
      return
    }

    // Idle exit with a pending unsolicited wake-up: keep the buffered lines so
    // the late attachment can replay them and then observe the closure. A plain
    // idle exit needs no notification — the next request just spawns fresh.
  }

  private armIdleTimer(entry: PoolEntry) {
    this.clearIdleTimer(entry)

    if (this.disposed || entry.closed || entry.state === 'turn-active') {
      return
    }

    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined
      if (entry.closed || entry.state === 'turn-active') {
        return
      }
      // Quiet for the whole idle window: no background task came back, recycle
      // the process. The next user message simply resumes via `-r <sessionId>`.
      this.removeEntry(entry, { kill: true })
    }, this.idleTimeoutMs)
  }

  private clearIdleTimer(entry: PoolEntry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private removeEntry(entry: PoolEntry, options: { kill: boolean }) {
    this.clearIdleTimer(entry)

    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key)
    }

    if (options.kill && !entry.closed) {
      try {
        entry.child.stdin?.end()
      } catch {
        // The pipe may already be gone; the kill below is the real teardown.
      }
      try {
        entry.child.kill()
      } catch {
        // Best-effort cleanup; the close handler clears remaining state.
      }
    }
  }
}
