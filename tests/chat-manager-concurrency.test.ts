import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'

import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import type { ChatRequest } from '../shared/schema.ts'

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, 'condition did not become true before the deadline')
}

const createRequest = (streamId: string): ChatRequest => ({
  streamId,
  cardId: `card-${streamId}`,
  provider: 'codex',
  prompt: `prompt ${streamId}`,
  workspacePath: 'D:/parallel-workspace',
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

test('ChatManager starts twelve provider runs immediately without a concurrency queue', async (t) => {
  const previousLimit = process.env.CHILL_VIBE_MAX_CONCURRENT_PROVIDER_RUNS
  process.env.CHILL_VIBE_MAX_CONCURRENT_PROVIDER_RUNS = '1'
  t.after(() => {
    if (previousLimit === undefined) {
      delete process.env.CHILL_VIBE_MAX_CONCURRENT_PROVIDER_RUNS
    } else {
      process.env.CHILL_VIBE_MAX_CONCURRENT_PROVIDER_RUNS = previousLimit
    }
  })

  const launched: string[] = []
  const backlogs = new Map<string, StreamEnvelope[]>()
  const manager = new ChatManager({
    ...deterministicWorkspaceDeps,
    providerLauncher: async (request) => {
      launched.push(request.streamId ?? '')
      return fakeChild
    },
  })
  t.after(() => manager.closeAll())

  for (let index = 1; index <= 12; index += 1) {
    const streamId = `stream-${index}`
    manager.createStream(createRequest(streamId))
    const backlog: StreamEnvelope[] = []
    backlogs.set(streamId, backlog)
    manager.subscribe(streamId, (payload) => backlog.push(payload))
  }

  await waitFor(() => launched.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.deepEqual(
    launched,
    Array.from({ length: 12 }, (_, index) => `stream-${index + 1}`),
  )
  assert.equal(
    [...backlogs.values()].some((backlog) =>
      backlog.some(
        (payload) =>
          payload.event === 'log' &&
          'message' in payload.data &&
          payload.data.message.includes('已排队'),
      )),
    false,
  )
})

test('a provider launch failure terminates only its own stream while peers still start', async (t) => {
  const launched: string[] = []
  const failedBacklog: StreamEnvelope[] = []
  const manager = new ChatManager({
    ...deterministicWorkspaceDeps,
    providerLauncher: async (request) => {
      launched.push(request.streamId ?? '')
      if (request.streamId === 'stream-fails') {
        throw new Error('spawn failed')
      }
      return fakeChild
    },
  })
  t.after(() => manager.closeAll())

  manager.createStream(createRequest('stream-fails'))
  manager.subscribe('stream-fails', (payload) => failedBacklog.push(payload))
  manager.createStream(createRequest('stream-peer'))

  await waitFor(() => launched.length === 2)
  await waitFor(() => failedBacklog.some((payload) => payload.event === 'error'))

  assert.deepEqual(launched, ['stream-fails', 'stream-peer'])
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
