import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ChatManager,
  defaultMaxConcurrentProviderRuns,
  resolveMaxConcurrentProviderRuns,
  type StreamEnvelope,
} from '../server/chat-manager.ts'
import type { ChatRequest } from '../shared/schema.ts'

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, 'condition did not become true before the deadline')
}

const createRequest = (workspacePath: string, streamId: string): ChatRequest => ({
  streamId,
  cardId: `card-${streamId}`,
  provider: 'codex',
  prompt: `prompt ${streamId}`,
  workspacePath,
  attachments: [],
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
})

const fakeChild = {
  kill: () => true,
} as unknown as ChildProcess

const deterministicWorkspaceDeps = {
  workspaceSnapshotter: async () => null,
  workspaceDiffer: async () => ({ files: [] }),
}

test('provider run guard queues beyond the limit and starts the next stream after a slot is released', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-chat-concurrency-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  const launched: string[] = []
  const sinks: Array<{ onDone: () => void }> = []
  const manager = new ChatManager({
    ...deterministicWorkspaceDeps,
    maxConcurrentProviderRuns: 2,
    providerLauncher: async (request, sink) => {
      launched.push(request.streamId ?? '')
      sinks.push(sink)
      return fakeChild
    },
  })
  t.after(() => manager.closeAll())

  manager.createStream(createRequest(workspacePath, 'stream-1'))
  manager.createStream(createRequest(workspacePath, 'stream-2'))
  manager.createStream(createRequest(workspacePath, 'stream-3'))

  const queuedBacklog: StreamEnvelope[] = []
  manager.subscribe('stream-3', (payload) => queuedBacklog.push(payload))

  await waitFor(() => launched.length >= 2)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.deepEqual(launched, ['stream-1', 'stream-2'])
  assert.equal(
    queuedBacklog.some(
      (payload) =>
        payload.event === 'log' &&
        'message' in payload.data &&
        payload.data.message.includes('已排队'),
    ),
    true,
  )

  sinks[0]?.onDone()
  await waitFor(() => launched.length === 3)
  assert.deepEqual(launched, ['stream-1', 'stream-2', 'stream-3'])

})

test('provider run limit accepts positive integer overrides and rejects malformed values', () => {
  assert.equal(resolveMaxConcurrentProviderRuns('3'), 3)
  assert.equal(resolveMaxConcurrentProviderRuns(8), 8)
  assert.equal(resolveMaxConcurrentProviderRuns('0'), defaultMaxConcurrentProviderRuns)
  assert.equal(resolveMaxConcurrentProviderRuns('-2'), defaultMaxConcurrentProviderRuns)
  assert.equal(resolveMaxConcurrentProviderRuns('2tasks'), defaultMaxConcurrentProviderRuns)
  assert.equal(resolveMaxConcurrentProviderRuns(''), defaultMaxConcurrentProviderRuns)
})

test('provider launch failures release capacity and surface a terminal stream error', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-chat-launch-error-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  const launched: string[] = []
  const failedBacklog: StreamEnvelope[] = []
  const manager = new ChatManager({
    ...deterministicWorkspaceDeps,
    maxConcurrentProviderRuns: 1,
    providerLauncher: async (request) => {
      launched.push(request.streamId ?? '')
      if (request.streamId === 'stream-fails') {
        throw new Error('spawn failed')
      }
      return fakeChild
    },
  })
  t.after(() => manager.closeAll())

  manager.createStream(createRequest(workspacePath, 'stream-fails'))
  manager.subscribe('stream-fails', (payload) => failedBacklog.push(payload))
  manager.createStream(createRequest(workspacePath, 'stream-next'))

  await waitFor(() => launched.length === 2)
  await waitFor(() => failedBacklog.some((payload) => payload.event === 'error'))

  assert.deepEqual(launched, ['stream-fails', 'stream-next'])
  assert.equal(
    failedBacklog.some(
      (payload) =>
        payload.event === 'error' &&
        'message' in payload.data &&
        payload.data.message.includes('spawn failed'),
    ),
    true,
  )
})

test('stopping a queued stream prevents it from launching after capacity becomes available', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-chat-queued-stop-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  const launched: string[] = []
  const sinks: Array<{ onDone: () => void }> = []
  const manager = new ChatManager({
    ...deterministicWorkspaceDeps,
    maxConcurrentProviderRuns: 1,
    providerLauncher: async (request, sink) => {
      launched.push(request.streamId ?? '')
      sinks.push(sink)
      return fakeChild
    },
  })
  t.after(() => manager.closeAll())

  manager.createStream(createRequest(workspacePath, 'stream-active'))
  manager.createStream(createRequest(workspacePath, 'stream-queued'))

  await waitFor(() => launched.length >= 1)
  assert.equal(manager.stop('stream-queued'), true)
  sinks[0]?.onDone()
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.deepEqual(launched, ['stream-active'])
})
