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
import { captureWorkspaceSnapshot, diffWorkspaceSnapshot } from './git-workspace.js'
import { createClaudeUnsolicitedTurnAttachment, launchProviderRun } from './providers.js'

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
}

export type UnsolicitedStreamNotification = {
  cardId: string
  streamId: string
}

const cleanupDelayMs = 5 * 60 * 1000
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

  constructor(options?: {
    // Keepalive is host-opt-in: the Electron desktop backend enables it so
    // background tasks survive between turns; the plain web server keeps the
    // single-shot behavior (it has no push channel for unsolicited streams).
    enableClaudeKeepalive?: boolean
    onUnsolicitedStream?: (notification: UnsolicitedStreamNotification) => void
    providerLauncher?: typeof launchProviderRun
    workspaceSnapshotter?: typeof captureWorkspaceSnapshot
    workspaceDiffer?: typeof diffWorkspaceSnapshot
  }) {
    this.onUnsolicitedStream = options?.onUnsolicitedStream
    this.providerLauncher = options?.providerLauncher ?? launchProviderRun
    this.workspaceSnapshotter = options?.workspaceSnapshotter ?? captureWorkspaceSnapshot
    this.workspaceDiffer = options?.workspaceDiffer ?? diffWorkspaceSnapshot
    this.claudePool = options?.enableClaudeKeepalive
      ? new ClaudeSessionPool({
          onUnsolicited: (entry, attach) => {
            void this.handleUnsolicitedClaudeTurn(entry, attach).catch(() => {
              // If the unsolicited stream could not be set up, the pool's idle
              // timer recycles the process; nothing else to clean up here.
            })
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

  stop(streamId: string) {
    const stream = this.streams.get(streamId)

    if (!stream || stream.terminal) {
      return false
    }

    stream.stopRequested = true
    if (stream.stopHook) {
      stream.stopHook()
    } else {
      stream.child?.kill()
    }
    this.finalize(stream, 'done', { stopped: true })
    return true
  }

  closeAll() {
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
      stopHook: () => this.claudePool?.releaseEntry(entry.key, entry.child),
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
        onDone: () => {
          if (!record.stopRequested) {
            void this.finalizeWithWorkspaceEdits(
              record,
              workspacePath,
              workspaceSnapshot,
              touchedPaths,
              'done',
              {},
            )
          }
        },
        onError: (message, hint, recovery) => {
          if (record.stopRequested) {
            return
          }

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
    })

    attach(attachment)
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
      workspaceSnapshot = await this.workspaceSnapshotter(request.workspacePath)
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
      onDone: () => {
        if (!stream.stopRequested) {
          void this.finalizeWithWorkspaceEdits(stream, request.workspacePath, workspaceSnapshot, touchedPaths, 'done', {})
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

  private emit<T extends StreamName>(stream: StreamRecord, event: T, data: StreamEventMap[T]) {
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
    this.emit(stream, event, data)

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

    try {
      const diff = await this.workspaceDiffer(
        snapshot,
        workspacePath,
        touchedPaths,
      )

      if (diff.files.length > 0) {
        this.emit(stream, 'activity', {
          itemId: `workspace_edits:${stream.id}`,
          kind: 'edits',
          status: 'completed',
          files: diff.files,
        })
      }
    } catch {
      // Ignore workspace diff errors so the chat stream can still settle normally.
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
