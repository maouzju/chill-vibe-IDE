import type { ChildProcess } from 'node:child_process'

import type { Request, Response } from 'express'

import type {
  ChatRequest,
  StreamActivity,
  StreamAssistantMessage,
  StreamErrorEvent,
  StreamErrorHint,
  StreamEventMap,
} from '../shared/schema.js'
import {
  ClaudeSessionPool,
  type ClaudeSessionPoolEntryView,
  type ClaudeTurnAttachment,
} from './claude-session-pool.js'
import {
  buildActiveStreamViews,
  createChatStreamTapRegistry,
  type ActiveStreamView,
  type ChatStreamTapEvent,
} from './chat-stream-tap.js'
import {
  captureWorkspaceSnapshot,
  captureWorkspaceSnapshotTimeoutMs,
  diffWorkspaceSnapshot,
} from './git-workspace.js'
import {
  createClaudeUnsolicitedTurnAttachment,
  isClaudeSidechainLine,
  isClaudeTurnStartLine,
  launchProviderRun,
  tryInterruptProviderTurn,
} from './providers.js'

type StreamName = keyof StreamEventMap

export type StreamEnvelope = {
  event: StreamName
  data: StreamEventMap[StreamName]
}

type StreamActivityEnvelope = {
  event: 'activity'
  data: StreamActivity
}

type StreamAssistantMessageEnvelope = {
  event: 'assistant_message'
  data: StreamAssistantMessage
}

type StreamSubscriber = (payload: StreamEnvelope) => void

type StreamRecord = {
  id: string
  cardId?: string
  backlog: StreamEnvelope[]
  listeners: Set<Response>
  subscribers: Set<StreamSubscriber>
  child?: ChildProcess
  // Unsolicited keepalive turns have no ChildProcess handle; stopping them
  // tears down the pooled process through this hook instead.
  stopHook?: () => void
  latestSessionId?: string
  terminal: boolean
  stopRequested: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
  // Set while finalizeWithWorkspaceEdits awaits the git diff. stop() uses it to
  // hand its terminal `done` to that in-flight settle instead of racing it.
  workspaceDiffInFlight?: boolean
}

export type UnsolicitedStreamNotification = {
  cardId: string
  streamId: string
}

export type ChatStreamStopResult = {
  stopped: boolean
  // 0 表示终态已经同步发出；> 0 表示终态被刻意推迟（正在等收尾 workspace diff），
  // 且最长不超过这么久。渲染进程据此放宽它自己的"服务端没回应"本地兜底。
  settlingWithinMs: number
}

const cleanupDelayMs = 5 * 60 * 1000
// 症状 — 上一版让 stop() 挂一个 3s 宽限定时器等收尾 diff，超时就自己发 done；
//   于是 diff 慢于 3s 时 edits 改动卡被静默丢弃，结果与完全不修一模一样。
// 根因 — 宽限定时器与 diff 完成是**两个独立竞速**，中间存在"diff 明明完成了、
//   结果却被扔掉"的窗口：定时器回调先置 terminal，await 之后的 `!stream.terminal`
//   守卫随即挡掉 emit。而 3s 这个值本身就选错了 —— tests/chat-manager-stop-race
//   记着真实 workspace diff 实测 74ms~3.5s（2026-08-02），"兜底"落在正常耗时分布
//   中间，正常波动就会触发。
// 为什么不能只是把 3s 调大 — 那只是把窗口挪远，竞速结构还在。改成给 diff 自身设
//   硬超时后，"拿到结果"与"放弃"成为**同一个决策点**：要么 edits 在 done 之前发出，
//   要么根本没产生过 edits，不存在"完成了却被丢弃"的中间态。
const workspaceDiffHardTimeoutMs = 12_000
// 发消息前的工作区基线也必须有上界：它跑在主进程主线程上，2026-08-12 实测这台机器
// 单次 git spawn 最坏 6910ms，足以单独触发 Windows 的"窗口无响应"判定。取值与
// git-workspace 的 captureWorkspaceSnapshotTimeoutMs 同源：要的是"有上界"（此前是
// 无穷），阈值必须远离正常耗时分布，否则代价是这一轮丢掉兜底改动卡。
const workspaceSnapshotHardTimeoutMs = captureWorkspaceSnapshotTimeoutMs

// 症状 — 上一轮的收尾 diff 超时后，那一串 git 仍在跑，和下一轮的 diff 叠加成 spawn 风暴。
// 根因 — 2026-08-12：旧写法只是 Promise.race，超时只是**放弃等待**，既不 abort 也不 kill；
//   一次 workspace diff 最多派生 3×256 个 git 子进程，而在这台机器上 spawn() 本身就是
//   主线程同步阻塞（p90=1831ms、最坏单次 6910ms）。
// 为什么不能只把 12s 调小 — 那只改变放弃的时刻，不改变"放弃之后还在跑"这个结构。改成
//   传 AbortSignal 给 work 之后，超时既停止等待也真正取消底层工作（runGit 到点 kill 子
//   进程、取消后不再派生新的），这是同一个决策点。
// Promise.race 的 loser 超时后就没人再 await 了，它若之后 reject 就是一条
// unhandled rejection（在 Electron 主进程里会被当成崩溃级日志）。先用 catch 把
// rejection 中和成 null，race 才干净地只剩"拿到结果 / 超时放弃"两个出口——
// 这也正好保留了原来"diff 出错时照常收尾"的语义。
const withHardTimeout = async <T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | null> => {
  const controller = new AbortController()
  const guarded = start(controller.signal).catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      guarded,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(null)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
const maxBacklogSize = 2000
export const maxBacklogCommandOutputChars = 16 * 1024
const backlogCommandOutputHeadChars = 8 * 1024
const backlogCommandOutputTailChars = 8 * 1024

const compactBacklogCommandOutput = (output: string) => {
  if (output.length <= maxBacklogCommandOutputChars) {
    return output
  }

  const omittedChars = output.length - backlogCommandOutputHeadChars - backlogCommandOutputTailChars

  return [
    output.slice(0, backlogCommandOutputHeadChars),
    '',
    `[Output truncated in live stream backlog. ${omittedChars} characters omitted.]`,
    '',
    output.slice(-backlogCommandOutputTailChars),
  ].join('\n')
}

export const compactStreamEnvelopeForBacklog = (payload: StreamEnvelope): StreamEnvelope => {
  if (payload.event !== 'activity') {
    return payload
  }

  const activityPayload = payload as StreamActivityEnvelope
  if (activityPayload.data.kind !== 'command') {
    return payload
  }

  const output = compactBacklogCommandOutput(activityPayload.data.output)
  if (output === activityPayload.data.output) {
    return payload
  }

  return {
    event: payload.event,
    data: {
      ...activityPayload.data,
      output,
    },
  }
}

// 每轮的用户需求以 user_message 事件进 backlog 并镜像给手机监工；空 prompt
// （纯图片轮/续跑轮）不广播。
export const buildUserMessageEnvelope = (prompt: string): StreamEnvelope | null => {
  if (prompt.trim().length === 0) {
    return null
  }

  return { event: 'user_message', data: { content: prompt } }
}

const getBacklogCoalesceKey = (payload: StreamEnvelope) => {
  if (payload.event === 'activity') {
    const activityPayload = payload as StreamActivityEnvelope
    return `${payload.event}:${activityPayload.data.itemId}`
  }

  if (payload.event === 'assistant_message') {
    const assistantPayload = payload as StreamAssistantMessageEnvelope
    return `${payload.event}:${assistantPayload.data.itemId}`
  }

  return null
}

export const appendStreamEnvelopeToBacklog = (
  backlog: StreamEnvelope[],
  payload: StreamEnvelope,
  maxSize = maxBacklogSize,
) => {
  const compactedPayload = compactStreamEnvelopeForBacklog(payload)
  const coalesceKey = getBacklogCoalesceKey(compactedPayload)

  if (coalesceKey) {
    const existingIndex = backlog.findLastIndex(
      (entry) => getBacklogCoalesceKey(entry) === coalesceKey,
    )

    if (existingIndex >= 0) {
      backlog[existingIndex] = compactedPayload
      return compactedPayload
    }
  }

  backlog.push(compactedPayload)
  if (backlog.length > maxSize) {
    backlog.splice(0, backlog.length - maxSize)
  }

  return compactedPayload
}

const normalizeSessionId = (sessionId?: string | null) => {
  const trimmed = sessionId?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const formatProviderStartError = (language: ChatRequest['language'], error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return language === 'en'
    ? `Provider failed to start: ${message}`
    : `Provider 启动失败：${message}`
}

export const buildStreamErrorPayload = (
  message: string,
  hint?: StreamErrorHint,
  recovery?: Pick<StreamErrorEvent, 'recoverable' | 'recoveryMode' | 'transientOnly'>,
  latestSessionId?: string | null,
): StreamErrorEvent => {
  const payload: StreamErrorEvent = { message }

  if (hint) {
    payload.hint = hint
  }

  if (recovery?.recoverable !== undefined) {
    payload.recoverable = recovery.recoverable
  }
  if (recovery?.recoveryMode !== undefined) {
    payload.recoveryMode = recovery.recoveryMode
  }
  if (recovery?.transientOnly !== undefined) {
    payload.transientOnly = recovery.transientOnly
  }

  const normalizedSessionId = normalizeSessionId(latestSessionId)
  if (
    normalizedSessionId &&
    payload.recoverable === true &&
    payload.recoveryMode === 'resume-session'
  ) {
    payload.sessionId = normalizedSessionId
  }

  return payload
}

const writeEvent = <T extends StreamName>(
  response: Response,
  event: T,
  data: StreamEventMap[T],
) => {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

export class ChatManager {
  private readonly streams = new Map<string, StreamRecord>()
  private readonly tapRegistry = createChatStreamTapRegistry()
  private readonly claudePool: ClaudeSessionPool | null
  private readonly onUnsolicitedStream?: (notification: UnsolicitedStreamNotification) => void
  private readonly providerLauncher: typeof launchProviderRun
  private readonly workspaceSnapshotter: typeof captureWorkspaceSnapshot
  private readonly workspaceDiffer: typeof diffWorkspaceSnapshot
  private readonly workspaceDiffTimeoutMs: number
  private readonly workspaceSnapshotTimeoutMs: number
  private closed = false

  constructor(options?: {
    // Keepalive is host-opt-in: the Electron desktop backend enables it so
    // background tasks survive between turns; the plain web server keeps the
    // single-shot behavior (it has no push channel for unsolicited streams).
    enableClaudeKeepalive?: boolean
    onUnsolicitedStream?: (notification: UnsolicitedStreamNotification) => void
    providerLauncher?: typeof launchProviderRun
    workspaceSnapshotter?: typeof captureWorkspaceSnapshot
    workspaceDiffer?: typeof diffWorkspaceSnapshot
    // Injectable so a test can prove the give-up path without waiting out the
    // real bound.
    workspaceDiffTimeoutMs?: number
    workspaceSnapshotTimeoutMs?: number
  }) {
    this.onUnsolicitedStream = options?.onUnsolicitedStream
    this.providerLauncher = options?.providerLauncher ?? launchProviderRun
    this.workspaceSnapshotter = options?.workspaceSnapshotter ?? captureWorkspaceSnapshot
    this.workspaceDiffer = options?.workspaceDiffer ?? diffWorkspaceSnapshot
    this.workspaceDiffTimeoutMs = options?.workspaceDiffTimeoutMs ?? workspaceDiffHardTimeoutMs
    this.workspaceSnapshotTimeoutMs =
      options?.workspaceSnapshotTimeoutMs ?? workspaceSnapshotHardTimeoutMs
    this.claudePool = options?.enableClaudeKeepalive
      ? new ClaudeSessionPool({
          shouldWakeOnLine: isClaudeTurnStartLine,
          shouldIgnoreIdleLine: isClaudeSidechainLine,
          onUnsolicited: (entry, attach) => {
            void this.handleUnsolicitedClaudeTurn(entry, attach).catch(() => {
              // If the unsolicited stream could not be set up, the pool's idle
              // timer recycles the process; nothing else to clean up here.
            })
          },
          onIdleClose: (entry) => {
            void this.handleIdleClaudeBackgroundClose(entry)
          },
        })
      : null
  }

  createStream(request: ChatRequest) {
    const id = request.streamId ?? crypto.randomUUID()
    if (this.streams.has(id)) {
      throw new Error('Stream already exists.')
    }

    const record: StreamRecord = {
      id,
      cardId: request.cardId,
      backlog: [],
      listeners: new Set(),
      subscribers: new Set(),
      latestSessionId: normalizeSessionId(request.sessionId),
      terminal: false,
      stopRequested: false,
    }

    this.streams.set(id, record)

    // 用户需求先于一切 assistant 输出进 backlog：手机监工（含 late-joiner
    // 重放）才能看到"需求在前、回答在后"的正确时间线。
    const userEnvelope = buildUserMessageEnvelope(request.prompt)
    if (userEnvelope) {
      this.emit(record, 'user_message', userEnvelope.data as StreamEventMap['user_message'])
    }

    this.startProviderDirectly(record, request)

    return id
  }

  attach(streamId: string, request: Request, response: Response) {
    const stream = this.streams.get(streamId)

    if (!stream) {
      response.status(404).json({ message: '未找到对应流。' })
      return
    }

    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer)
      stream.cleanupTimer = undefined
    }

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders()

    stream.listeners.add(response)
    response.write('retry: 1500\n\n')

    for (const item of stream.backlog) {
      writeEvent(response, item.event, item.data)
    }

    if (stream.terminal) {
      response.end()
      stream.listeners.delete(response)
      this.scheduleCleanupIfIdle(stream)
      return
    }

    request.on('close', () => {
      stream.listeners.delete(response)
      this.scheduleCleanupIfIdle(stream)
    })
  }

  subscribe(streamId: string, subscriber: StreamSubscriber) {
    const stream = this.streams.get(streamId)

    if (!stream) {
      return null
    }

    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer)
      stream.cleanupTimer = undefined
    }

    stream.subscribers.add(subscriber)

    for (const item of stream.backlog) {
      subscriber(item)
    }

    if (stream.terminal) {
      stream.subscribers.delete(subscriber)
      this.scheduleCleanupIfIdle(stream)
      return () => undefined
    }

    return () => {
      stream.subscribers.delete(subscriber)
      this.scheduleCleanupIfIdle(stream)
    }
  }

  // Global read-only mirror of every stream: the remote monitor observes all
  // sessions at once here, while per-card renderer consumers keep using
  // subscribe(streamId, ...).
  tapAll(listener: (event: ChatStreamTapEvent) => void) {
    return this.tapRegistry.tap(listener)
  }

  listActiveStreams(): ActiveStreamView[] {
    return buildActiveStreamViews(this.streams.values())
  }

  // `settlingWithinMs` 是给渲染进程的时序契约：> 0 表示终态被刻意推迟，最长这么久。
  // 渲染端的"服务端没回应"本地兜底必须据此放宽，否则它会先一步 close 掉 EventSource，
  // 让这次推迟白做（症状：改动卡照样丢失，见 Known Pitfall 244）。
  stop(streamId: string): ChatStreamStopResult {
    const stream = this.streams.get(streamId)

    if (!stream || stream.terminal) {
      return { stopped: false, settlingWithinMs: 0 }
    }

    stream.stopRequested = true
    // 症状：点停止会连整个 Claude CLI 进程一起杀掉，会话作废、进程内正在跑的
    //   Workflow 子 agent 全部陪葬，下一轮只能冷启动（Known Pitfall 118 的
    //   「打断后清 sessionId」正是为绕开被 kill 弄脏的原生会话）。
    // 根因：停止一直只有 OS 信号一条路，CLI 的 stream-json 控制通道从未接过。
    //   2026-08-09 实测：发 control_request/interrupt 后 1-2ms 回 success，
    //   进程存活、session_id 不变、上下文完整，可以立刻接下一轮。
    // 为什么不能只软中断：控制通道依赖 keepalive 的常驻 stdin，写不进去时必须
    //   如实退回硬 kill —— 停止按钮失灵比退化回 kill 严重得多。
    if (!tryInterruptProviderTurn(stream.child)) {
      if (stream.stopHook) {
        stream.stopHook()
      } else {
        stream.child?.kill()
      }
    }

    // 症状：turn 已 onDone、收尾 workspace diff 还挂在 await 上时用户点停止，
    // done 先落地、edits 改动卡后到；renderer onDone 已 close 掉 EventSource，
    // 改动卡和文件清单整个丢失，backlog 里还留下 activity-after-done 的错序，
    // 任何重放路径（SSE 重 attach / subscribe / 手机监工 tapAll）都会看到。
    // 被否决：await 之后直接丢弃 edits——文件确实被改了，丢了用户就无从得知。
    // 这里让停止把终态 done 交给那次 in-flight settle 顺序发出；kill 仍是同步
    // 立即的，只有终态信封被推迟。终态一定会来：那次 settle 自己带硬超时
    // （workspaceDiffHardTimeoutMs），所以这里不需要、也不该再挂第二个竞速定时器。
    if (stream.workspaceDiffInFlight) {
      return { stopped: true, settlingWithinMs: workspaceDiffHardTimeoutMs }
    }

    this.finalize(stream, 'done', { stopped: true })
    return { stopped: true, settlingWithinMs: 0 }
  }

  closeAll() {
    this.closed = true
    this.claudePool?.closeAll()
    for (const stream of this.streams.values()) {
      if (stream.cleanupTimer) {
        clearTimeout(stream.cleanupTimer)
        stream.cleanupTimer = undefined
      }
      stream.child?.kill()
      stream.listeners.forEach((response) => response.end())
      stream.listeners.clear()
      stream.subscribers.clear()
    }
    this.streams.clear()
  }

  // An idle pooled Claude process produced output on its own: a background
  // task finished and the CLI re-invoked the agent. Wrap the new turn in a
  // fresh stream and tell the host so the renderer can attach the card to it.
  private async handleUnsolicitedClaudeTurn(
    entry: ClaudeSessionPoolEntryView,
    attach: (attachment: ClaudeTurnAttachment) => void,
  ) {
    const streamId = crypto.randomUUID()
    const record: StreamRecord = {
      id: streamId,
      cardId: entry.key,
      backlog: [],
      listeners: new Set(),
      subscribers: new Set(),
      // CLI 自己醒来的这一轮同样先试软中断：这里手里就有正确的 key + child，
      // 中断只会落在这一轮上。软中断不成立才回落到 kill 掉池内进程。
      stopHook: () => {
        if (this.claudePool?.interruptTurn(entry.key, entry.child)) {
          return
        }
        this.claudePool?.releaseEntry(entry.key, entry.child)
      },
      latestSessionId: normalizeSessionId(entry.sessionId),
      terminal: false,
      stopRequested: false,
    }
    this.streams.set(streamId, record)

    const workspacePath =
      typeof entry.meta.workspacePath === 'string' ? entry.meta.workspacePath : ''

    let workspaceSnapshot = null
    try {
      workspaceSnapshot = workspacePath ? await this.workspaceSnapshotter(workspacePath) : null
    } catch {
      workspaceSnapshot = null
    }

    const touchedPaths = new Set<string>()

    const attachment = createClaudeUnsolicitedTurnAttachment({
      entry,
      sink: {
        onSession: (sessionId) => {
          record.latestSessionId = normalizeSessionId(sessionId) ?? record.latestSessionId
          this.emit(record, 'session', { sessionId })
        },
        onDelta: (content, itemId) => this.emit(record, 'delta', {
          content,
          ...(itemId ? { itemId } : {}),
        }),
        onLog: (message) => this.emit(record, 'log', { message }),
        onAssistantMessage: (message) => this.emit(record, 'assistant_message', message),
        onActivity: (activity) => {
          if (activity.kind === 'edits' && 'files' in activity) {
            for (const file of activity.files) {
              touchedPaths.add(file.path)
            }
          }
          this.emit(record, 'activity', activity)
        },
        onStats: (event) => this.emit(record, 'stats', event),
        onDone: (payload) => {
          if (!record.stopRequested) {
            void this.finalizeWithWorkspaceEdits(
              record,
              workspacePath,
              workspaceSnapshot,
              touchedPaths,
              'done',
              payload ?? {},
            )
          }
        },
        onError: (message, hint, recovery) => {
          if (record.stopRequested) {
            return
          }

          this.claudePool?.updateMeta(
            entry.key,
            { backgroundWorkPending: false },
            entry.child,
          )

          void this.finalizeWithWorkspaceEdits(
            record,
            workspacePath,
            workspaceSnapshot,
            touchedPaths,
            'error',
            buildStreamErrorPayload(message, hint, recovery, record.latestSessionId),
          )
        },
      },
      killChild: () => this.claudePool?.releaseEntry(entry.key, entry.child),
      onSettled: () => this.claudePool?.endTurn(entry.key, entry.child),
      onCompletionBoundary: (boundary) => this.claudePool?.updateMeta(
        entry.key,
        { backgroundWorkPending: boundary === 'background-pending' },
        entry.child,
      ),
    })

    attach(attachment)
    this.onUnsolicitedStream?.({ cardId: entry.key, streamId })
  }

  private async handleIdleClaudeBackgroundClose(entry: ClaudeSessionPoolEntryView) {
    const knownCardStreamIds = new Set(
      [...this.streams.values()]
        .filter((stream) => stream.cardId === entry.key)
        .map((stream) => stream.id),
    )
    const blockingStreamIds = [...this.streams.values()]
      .filter((stream) => stream.cardId === entry.key && !stream.terminal)
      .map((stream) => stream.id)
    const deadline = Date.now() + 30_000

    while (
      !this.closed &&
      Date.now() < deadline &&
      blockingStreamIds.some((streamId) => this.streams.get(streamId)?.terminal === false)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    // Let the preceding pending-done envelope reach the renderer before the
    // separate terminal-loss notification. A genuinely new stream on the same
    // card means the user already superseded this dead background chain.
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (
      this.closed ||
      [...this.streams.values()].some(
        (stream) => stream.cardId === entry.key && !knownCardStreamIds.has(stream.id),
      )
    ) {
      return
    }

    const language = entry.meta.language === 'en' ? 'en' : 'zh-CN'
    const streamId = crypto.randomUUID()
    const record: StreamRecord = {
      id: streamId,
      cardId: entry.key,
      backlog: [],
      listeners: new Set(),
      subscribers: new Set(),
      latestSessionId: normalizeSessionId(entry.sessionId),
      terminal: false,
      stopRequested: false,
    }
    this.streams.set(streamId, record)

    // 症状：Claude 已进入后台等待后若空闲进程崩溃/超时回收，卡片会永久显示“仍在工作”。
    // 根因：此时没有活动 transport stream，旧 close 路径没有任何事件可送回 renderer。
    // 被否决：只靠重启清状态会无限误报；用一次终端 error stream 收尾，见 native completion SPEC。
    this.finalize(record, 'error', {
      message: language === 'en'
        ? 'The Claude background session ended unexpectedly, so its pending background work cannot continue.'
        : 'Claude 后台会话已意外结束，等待中的后台工作无法继续。',
      recoverable: false,
    })
    this.onUnsolicitedStream?.({ cardId: entry.key, streamId })
  }

  private startProviderDirectly(stream: StreamRecord, request: ChatRequest) {
    void this.startProvider(stream, request).catch((error) => {
      if (stream.stopRequested || stream.terminal) {
        return
      }
      this.finalize(stream, 'error', {
        message: formatProviderStartError(request.language, error),
      })
    })
  }

  private async startProvider(stream: StreamRecord, request: ChatRequest) {
    let workspaceSnapshot = null

    try {
      // 这条跑在**每次发消息之前**。超时必须是安静降级（没有基线 = 这轮少一张兜底
      // 改动卡），绝不能让一个慢 git status 把发送整个卡住。
      workspaceSnapshot = await this.workspaceSnapshotter(request.workspacePath, {
        timeoutMs: this.workspaceSnapshotTimeoutMs,
      })
    } catch {
      workspaceSnapshot = null
    }

    const touchedPaths = new Set<string>()

    const child = await this.providerLauncher(request, {
      onSession: (sessionId) => {
        stream.latestSessionId = normalizeSessionId(sessionId) ?? stream.latestSessionId
        this.emit(stream, 'session', { sessionId })
      },
      onDelta: (content, itemId) => this.emit(stream, 'delta', {
        content,
        ...(itemId ? { itemId } : {}),
      }),
      onLog: (message) => this.emit(stream, 'log', { message }),
      onAssistantMessage: (message) => this.emit(stream, 'assistant_message', message),
      onActivity: (activity) => {
        if (activity.kind === 'edits' && 'files' in activity) {
          for (const file of activity.files) {
            touchedPaths.add(file.path)
          }
        }
        this.emit(stream, 'activity', activity)
      },
      onStats: (event) => this.emit(stream, 'stats', event),
      onDone: (payload) => {
        if (!stream.stopRequested) {
          void this.finalizeWithWorkspaceEdits(
            stream,
            request.workspacePath,
            workspaceSnapshot,
            touchedPaths,
            'done',
            payload ?? {},
          )
        }
      },
      onError: (message, hint, recovery) => {
        if (stream.stopRequested) {
          return
        }

        void this.finalizeWithWorkspaceEdits(
          stream,
          request.workspacePath,
          workspaceSnapshot,
          touchedPaths,
          'error',
          buildStreamErrorPayload(message, hint, recovery, stream.latestSessionId ?? request.sessionId),
        )
      },
    }, { claudeSessionPool: this.claudePool })

    if (!child) {
      return
    }

    if (stream.stopRequested || stream.terminal) {
      child.kill()
      return
    }

    stream.child = child
  }

  private emit<T extends StreamName>(
    stream: StreamRecord,
    event: T,
    data: StreamEventMap[T],
    options?: { terminalEnvelope?: boolean },
  ) {
    // done/error 之后不再放行任何事件。迟到者主要有两类：收尾 workspace diff，
    // 以及被 kill 的子进程最后一段 stdout flush 出来的 delta/activity。renderer
    // 在 onDone 里已经 removeEventListener + close，这些事件谁也收不到，却会在
    // backlog 里留下 activity-after-done 的错序，污染所有重放路径。
    // finalize 先置 terminal 再 emit，所以它自己那一次必须显式放行。
    if (stream.terminal && !options?.terminalEnvelope) {
      return
    }

    const payload = appendStreamEnvelopeToBacklog(stream.backlog, { event, data } as StreamEnvelope)

    for (const listener of stream.listeners) {
      writeEvent(listener, payload.event, payload.data)
    }

    for (const subscriber of stream.subscribers) {
      subscriber(payload)
    }

    this.tapRegistry.broadcast({ streamId: stream.id, cardId: stream.cardId, envelope: payload })
  }

  private finalize<T extends Extract<StreamName, 'done' | 'error'>>(
    stream: StreamRecord,
    event: T,
    data: StreamEventMap[T],
  ) {
    if (stream.terminal) {
      return
    }

    stream.terminal = true
    this.emit(stream, event, data, { terminalEnvelope: true })

    for (const listener of stream.listeners) {
      listener.end()
    }

    stream.listeners.clear()
    this.scheduleCleanupIfIdle(stream)
  }

  private async finalizeWithWorkspaceEdits<T extends Extract<StreamName, 'done' | 'error'>>(
    stream: StreamRecord,
    workspacePath: string,
    snapshot: Awaited<ReturnType<typeof captureWorkspaceSnapshot>>,
    touchedPaths: Set<string>,
    event: T,
    data: StreamEventMap[T],
  ) {
    if (stream.terminal) {
      return
    }

    stream.workspaceDiffInFlight = true

    try {
      // 硬超时必须套在 diff **自己**身上，而不是让等待方另起一个定时器去竞速它。
      // 前者只有一个决策点（拿到结果 / 放弃），后者会产生"diff 完成了但结果被扔掉"
      // 的中间态——那正是上一版丢 edits 改动卡的根因。
      const diff = await withHardTimeout(
        (signal) => this.workspaceDiffer(snapshot, workspacePath, touchedPaths, { signal }),
        this.workspaceDiffTimeoutMs,
      )

      // 终态守卫必须在 await **之后**再查一次：函数入口那次检查早已过期。
      // 只看 terminal（不看 stopRequested）是有意的——被 stop 推迟的流此时仍非
      // 终态，正是要让它的 edits 先发出去；只有 done 真的落地了才闭嘴。
      if (diff && diff.files.length > 0 && !stream.terminal) {
        this.emit(stream, 'activity', {
          itemId: `workspace_edits:${stream.id}`,
          kind: 'edits',
          status: 'completed',
          files: diff.files,
        })
      }
    } finally {
      stream.workspaceDiffInFlight = false
    }

    // 停止在 diff 途中到达过：接管终态，用 stop 的语义收尾而不是这一轮的 payload。
    // 判据用 stopRequested（stop() 入口就置好的既有字段），不再需要一个专门的
    // 定时器句柄来记"停止来过"——少一个字段、少两处清理点、也少一条竞速。
    if (stream.stopRequested) {
      this.finalize(stream, 'done', { stopped: true })
      return
    }

    this.finalize(stream, event, data)
  }

  private scheduleCleanup(stream: StreamRecord) {
    if (stream.cleanupTimer) {
      clearTimeout(stream.cleanupTimer)
    }

    stream.cleanupTimer = setTimeout(() => {
      this.streams.delete(stream.id)
    }, cleanupDelayMs)
  }

  private scheduleCleanupIfIdle(stream: StreamRecord) {
    if (!stream.terminal) {
      return
    }

    if (stream.listeners.size > 0 || stream.subscribers.size > 0) {
      return
    }

    this.scheduleCleanup(stream)
  }
}
