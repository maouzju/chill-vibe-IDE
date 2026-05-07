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
import { captureWorkspaceSnapshot, diffWorkspaceSnapshot } from './git-workspace.js'
import { launchProviderRun } from './providers.js'

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
  backlog: StreamEnvelope[]
  listeners: Set<Response>
  subscribers: Set<StreamSubscriber>
  child?: ChildProcess
  latestSessionId?: string
  terminal: boolean
  stopRequested: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
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

  createStream(request: ChatRequest) {
    const id = request.streamId ?? crypto.randomUUID()
    if (this.streams.has(id)) {
      throw new Error('Stream already exists.')
    }

    const record: StreamRecord = {
      id,
      backlog: [],
      listeners: new Set(),
      subscribers: new Set(),
      latestSessionId: normalizeSessionId(request.sessionId),
      terminal: false,
      stopRequested: false,
    }

    this.streams.set(id, record)
    void this.startProvider(record, request)

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

  stop(streamId: string) {
    const stream = this.streams.get(streamId)

    if (!stream || stream.terminal) {
      return false
    }

    stream.stopRequested = true
    stream.child?.kill()
    this.finalize(stream, 'done', { stopped: true })
    return true
  }

  closeAll() {
    for (const stream of this.streams.values()) {
      stream.child?.kill()
      stream.listeners.forEach((response) => response.end())
      stream.listeners.clear()
      stream.subscribers.clear()
    }
    this.streams.clear()
  }

  private async startProvider(stream: StreamRecord, request: ChatRequest) {
    let workspaceSnapshot = null

    try {
      workspaceSnapshot = await captureWorkspaceSnapshot(request.workspacePath)
    } catch {
      workspaceSnapshot = null
    }

    const touchedPaths = new Set<string>()

    const child = await launchProviderRun(request, {
      onSession: (sessionId) => {
        stream.latestSessionId = normalizeSessionId(sessionId) ?? stream.latestSessionId
        this.emit(stream, 'session', { sessionId })
      },
      onDelta: (content) => this.emit(stream, 'delta', { content }),
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
          void this.finalizeWithWorkspaceEdits(stream, request, workspaceSnapshot, touchedPaths, 'done', {})
        }
      },
      onError: (message, hint, recovery) => {
        if (stream.stopRequested) {
          return
        }

        void this.finalizeWithWorkspaceEdits(
          stream,
          request,
          workspaceSnapshot,
          touchedPaths,
          'error',
          buildStreamErrorPayload(message, hint, recovery, stream.latestSessionId ?? request.sessionId),
        )
      },
    })

    if (!child) {
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
    request: ChatRequest,
    snapshot: Awaited<ReturnType<typeof captureWorkspaceSnapshot>>,
    touchedPaths: Set<string>,
    event: T,
    data: StreamEventMap[T],
  ) {
    if (stream.terminal) {
      return
    }

    try {
      const diff = await diffWorkspaceSnapshot(
        snapshot,
        request.workspacePath,
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
