import type { ChildProcess } from 'node:child_process'

import type { Request, Response } from 'express'

import type { ChatRequest, StreamEventMap } from '../shared/schema.js'
import { captureWorkspaceSnapshot, diffWorkspaceSnapshot } from './git-workspace.js'
import { launchProviderRun } from './providers.js'

type StreamName = keyof StreamEventMap

export type StreamEnvelope = {
  event: StreamName
  data: StreamEventMap[StreamName]
}

type StreamSubscriber = (payload: StreamEnvelope) => void

type StreamRecord = {
  id: string
  backlog: StreamEnvelope[]
  listeners: Set<Response>
  subscribers: Set<StreamSubscriber>
  child?: ChildProcess
  terminal: boolean
  stopRequested: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
}

const cleanupDelayMs = 5 * 60 * 1000
const maxBacklogSize = 2000

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
      onSession: (sessionId) => this.emit(stream, 'session', { sessionId }),
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
      onDone: () => {
        if (!stream.stopRequested) {
          void this.finalizeWithWorkspaceEdits(stream, request, workspaceSnapshot, touchedPaths, 'done', {})
        }
      },
      onError: (message, hint, recovery) => {
        if (stream.stopRequested) {
          return
        }

        void this.finalizeWithWorkspaceEdits(stream, request, workspaceSnapshot, touchedPaths, 'error', {
          message,
          hint,
          ...recovery,
        })
      },
    })

    if (!child) {
      return
    }

    stream.child = child
  }

  private emit<T extends StreamName>(stream: StreamRecord, event: T, data: StreamEventMap[T]) {
    const payload: StreamEnvelope = { event, data }
    stream.backlog.push(payload)
    if (stream.backlog.length > maxBacklogSize) {
      stream.backlog.splice(0, stream.backlog.length - maxBacklogSize)
    }

    for (const listener of stream.listeners) {
      writeEvent(listener, event, data)
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
