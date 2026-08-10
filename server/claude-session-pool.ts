import { randomUUID } from 'node:crypto'
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
  stdin: {
    write: (chunk: string) => boolean
    end: () => void
    // 真实的 child.stdin 是 Socket，管道断裂时只会异步 emit 'error'。声明成可选，
    // 是因为测试替身可以是纯对象——但真实进程上这个监听必须挂上，见 wireChild。
    on?: (event: 'error', listener: (error: Error) => void) => unknown
  } | null
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
  // 本轮已发出 interrupt control_request。turn 依然 active：CLI 的收尾输出
  // （partial assistant → 合成 user 帧 → result）必须照常流给 provider 的 parser，
  // 由它正常收口并 endTurn。截断这条通道会让 parser 永远等不到 result。
  interruptRequested: boolean
  interruptDrainTimer: ReturnType<typeof setTimeout> | undefined
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

// Ceiling on idle lines held for a not-yet-woken stream. A long-lived process
// can emit task bookkeeping for hours; keep the tail rather than growing without
// bound.
const MAX_BUFFERED_IDLE_LINES = 2_000

// 中断收尾的兜底上限。
// 症状：第一版取 2s，端到端实测（2026-08-09）直接误杀了一个健康进程——
//   CLI 正在刷输出时 control_response 花了 4.3s 才回，兜底先到，进程被 kill。
// 根因：2s 落在了正常耗时分布中间。空闲 CLI 回 1-2ms，繁忙 CLI 可到数秒，
//   这个阈值必须远离正常值域，否则它不是兜底而是竞速（同 Known Pitfall 243）。
// 为什么不能靠"收到 control_response 就解除"：pool 刻意不解析 stream-json 语义，
//   那是 providers.ts 的职责；这里只认 endTurn 这个明确的收口信号。
// 用户手感不受影响：UI 侧在 stop() 当刻就已收尾，这个定时器只决定进程能否被复用。
const DEFAULT_INTERRUPT_DRAIN_TIMEOUT_MS = 30_000


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
  private readonly onIdleClose?: (
    entry: ClaudeSessionPoolEntryView,
    code: number | null,
  ) => void
  private readonly shouldWakeOnLine: (line: string) => boolean
  private readonly shouldIgnoreIdleLine: (line: string) => boolean
  private readonly interruptDrainTimeoutMs: number
  private readonly idleTimeoutMs: number
  private disposed = false

  constructor(options: {
    onUnsolicited: (
      entry: ClaudeSessionPoolEntryView,
      attach: (attachment: ClaudeTurnAttachment) => void,
    ) => void
    onIdleClose?: (entry: ClaudeSessionPoolEntryView, code: number | null) => void
    // Decides whether an idle stdout line actually starts a turn. The pool has
    // no stream-json knowledge of its own, so the host injects the predicate;
    // without one every line wakes a stream (the pre-gate behavior).
    shouldWakeOnLine?: (line: string) => boolean
    // Sidechain/progress lines that belong to a child Agent should neither wake
    // the owner card nor be replayed into a later genuine top-level turn.
    shouldIgnoreIdleLine?: (line: string) => boolean
    idleTimeoutMs?: number
    // 软中断后等 CLI 吐完收尾输出的上限。实测原生响应 1-2ms，收尾行紧随其后；
    // 超时说明这个进程已经不听话了，必须退回硬 kill——用户点停止的心理预期是
    // 「点了就停」，不能因为协议路径卡住就把卡片挂在一个永不结束的中断态上。
    interruptDrainTimeoutMs?: number
  }) {
    this.onUnsolicited = options.onUnsolicited
    this.onIdleClose = options.onIdleClose
    this.shouldWakeOnLine = options.shouldWakeOnLine ?? (() => true)
    this.shouldIgnoreIdleLine = options.shouldIgnoreIdleLine ?? (() => false)
    this.idleTimeoutMs = options.idleTimeoutMs ?? resolveDefaultIdleTimeoutMs()
    this.interruptDrainTimeoutMs =
      options.interruptDrainTimeoutMs ?? DEFAULT_INTERRUPT_DRAIN_TIMEOUT_MS
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
      interruptRequested: false,
      interruptDrainTimer: undefined,
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
    entry.interruptRequested = false
    this.clearInterruptDrainTimer(entry)
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
    // 中断的收尾已经走完正常通道到达这里，兜底 kill 必须随之解除，
    // 否则它会在几秒后杀掉一个已经健康回到 idle 的进程。
    entry.interruptRequested = false
    this.clearInterruptDrainTimer(entry)
    this.armIdleTimer(entry)
  }

  // 软中断：往 CLI 的 stdin 写一行 control_request，让它 abort 当前 turn，
  // 进程、session 与完整上下文全程存活（原生实测：三轮对话两次中断共用一个 session_id）。
  // 症状：旧实现点停止直接 child.kill()，把整个 CLI 连同进程内正在跑的 Workflow 子 agent
  //   一并砍掉，原生会话被留在半死状态，只能整个作废重来（Known Pitfall 118 的
  //   「打断后清 sessionId」补偿正是为了绕开这个脏状态）。
  // 根因：Chill Vibe 从来没接过 stream-json 的控制通道，停止只有 OS 信号一条路可走。
  // 为什么不能换写法：这条通道依赖 keepalive 的 `--input-format stream-json` 让 stdin 常驻可写。
  //   写不进去（无 stdin / 进程已关 / 根本没有活动 turn）必须如实返回 false 让调用方硬 kill 兜底，
  //   绝不能静默吞掉——那等于停止按钮失灵，比退化回 kill 更糟。
  interruptTurn(key: string, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (
      !entry ||
      (expectedChild && entry.child !== expectedChild) ||
      entry.closed ||
      entry.state !== 'turn-active' ||
      !entry.child.stdin
    ) {
      return false
    }

    const line = JSON.stringify({
      type: 'control_request',
      request_id: `chill-vibe-interrupt-${randomUUID()}`,
      request: { subtype: 'interrupt' },
    })

    try {
      entry.child.stdin.write(`${line}\n`)
    } catch {
      return false
    }

    // 刻意不动 state / attachment：收尾输出继续走正常 turn 通道，provider 的
    // parser 看到 result 后自己 onSettled → endTurn，进程干净地回到 idle。
    // 迟到的 delta 由 host 侧的 terminal 守卫拦掉（stream 早已 finalize），
    // 这里再截一道只会让 parser 悬空。
    entry.interruptRequested = true
    this.armInterruptDrainTimer(entry)
    return true
  }

  updateSessionId(key: string, sessionId: string, expectedChild?: ClaudeSessionPoolChild) {
    const entry = this.entries.get(key)
    if (entry && (!expectedChild || entry.child === expectedChild) && sessionId.trim()) {
      entry.sessionId = sessionId.trim()
    }
  }

  updateMeta(
    key: string,
    patch: Record<string, unknown>,
    expectedChild?: ClaudeSessionPoolChild,
  ) {
    const entry = this.entries.get(key)
    if (entry && (!expectedChild || entry.child === expectedChild)) {
      entry.meta = { ...entry.meta, ...patch }
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

    // 症状：2026-08-10 全天 7 次整窗口闪退，内存充足（空闲 13-16GB、应用仅 470MB），
    //   无 crash dump、无 Windows 事件、无退出日志。按构建二分，故障只出现在
    //   8/9 23:28 及之后的包——第一个会主动往 stdin 写字节的版本；更早的包只在
    //   系统提交内存顶满（空闲 4-7GB）时才死，是完全另一类故障。
    // 根因：child.stdin 是 Socket，管道断裂的 EPIPE **只以异步 'error' 事件出现**，
    //   `stdin.write()` 外层的 try/catch 根本接不到；而这里过去只接了 stdout/stderr/close，
    //   stdin 上一个监听器都没有。Node 对无人监听的 stream 'error' 直接 throw，
    //   升级成 uncaughtException 把宿主进程整个带走，连写 dump 都来不及——正是"三缺"现场。
    // 为什么不能只在调用点补 try/catch：异步 error 不经过调用点的栈，补多少个都拦不住。
    //   唯一有效的位置就是这里：建进程时挂一次，interruptTurn / writeUserMessage 等
    //   所有写入路径一并受保护。
    entry.child.stdin?.on?.('error', () => {
      // 管道断裂本身不是需要处置的错误：进程真的退出时 'close' 会照常收尾并清理
      // entry。这里只负责吸收事件，阻止它冒泡成未捕获异常。
    })

    entry.child.once('close', (code) => this.handleChildClose(entry, code))
  }

  private armInterruptDrainTimer(entry: PoolEntry) {
    this.clearInterruptDrainTimer(entry)
    entry.interruptDrainTimer = setTimeout(() => {
      entry.interruptDrainTimer = undefined
      if (!entry.interruptRequested || entry.state !== 'turn-active') {
        return
      }
      // 收尾迟迟不来说明这个 CLI 已经不听协议了。软中断的前提就此不成立，
      // 退回硬 kill —— 宁可牺牲进程复用，也不能让卡片挂在永不结束的中断态上。
      this.removeEntry(entry, { kill: true })
    }, this.interruptDrainTimeoutMs)
    entry.interruptDrainTimer.unref?.()
  }

  private clearInterruptDrainTimer(entry: PoolEntry) {
    if (entry.interruptDrainTimer) {
      clearTimeout(entry.interruptDrainTimer)
      entry.interruptDrainTimer = undefined
    }
  }

  private handleStdoutLine(entry: PoolEntry, line: string) {
    if (entry.state === 'turn-active' && entry.attachment) {
      if (this.shouldIgnoreIdleLine(line)) {
        return
      }
      entry.attachment.onLine(line)
      return
    }

    this.armIdleTimer(entry)

    // Child-Agent sidechain output can outlive the parent turn. It proves the
    // pooled process is active, but it is not owner-card content and must not be
    // buffered into a later genuine task-notification turn.
    if (this.shouldIgnoreIdleLine(line)) {
      return
    }

    // Idle output: the CLI woke itself (e.g. a background task finished and the
    // agent resumed). Buffer eligible lines until the host attaches a stream.
    entry.bufferedStdout.push(line)
    if (entry.bufferedStdout.length > MAX_BUFFERED_IDLE_LINES) {
      entry.bufferedStdout.splice(0, entry.bufferedStdout.length - MAX_BUFFERED_IDLE_LINES)
    }
    // Background-task bookkeeping (`task_updated`, `background_tasks_changed`,
    // …) arrives while idle without the agent being re-invoked. Waking a stream
    // on those would park the card in `streaming` with nothing behind it until
    // the stall watchdog fires minutes later, so only a line that genuinely
    // starts a turn opens the stream. The bookkeeping stays buffered and is
    // replayed on attach.
    if (!this.shouldWakeOnLine(line)) {
      return
    }

    if (!entry.pendingUnsolicited) {
      entry.pendingUnsolicited = true
      this.onUnsolicited(
        this.toEntryView(entry),
        (attachment) => this.attachUnsolicited(entry, attachment),
      )
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
    this.clearInterruptDrainTimer(entry)
    entry.stdoutReader?.close()
    entry.stderrReader?.close()

    const wasCurrentEntry = this.entries.get(entry.key) === entry
    if (wasCurrentEntry) {
      this.entries.delete(entry.key)
    }

    if (entry.state === 'turn-active' && entry.attachment) {
      entry.attachment.onProcessClosed(code)
      entry.attachment = null
      return
    }

    if (
      wasCurrentEntry &&
      !entry.pendingUnsolicited &&
      entry.meta.backgroundWorkPending === true
    ) {
      this.onIdleClose?.(this.toEntryView(entry), code)
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
      this.removeEntry(entry, { kill: true, notifyPendingIdleClose: true })
    }, this.idleTimeoutMs)
  }

  private clearIdleTimer(entry: PoolEntry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private toEntryView(entry: PoolEntry): ClaudeSessionPoolEntryView {
    return {
      key: entry.key,
      sessionId: entry.sessionId,
      meta: entry.meta,
      child: entry.child,
    }
  }

  private removeEntry(
    entry: PoolEntry,
    options: { kill: boolean; notifyPendingIdleClose?: boolean },
  ) {
    this.clearIdleTimer(entry)
    this.clearInterruptDrainTimer(entry)

    if (
      options.notifyPendingIdleClose &&
      entry.state === 'idle' &&
      !entry.pendingUnsolicited &&
      entry.meta.backgroundWorkPending === true
    ) {
      this.onIdleClose?.(this.toEntryView(entry), null)
      entry.meta = { ...entry.meta, backgroundWorkPending: false }
    }

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
