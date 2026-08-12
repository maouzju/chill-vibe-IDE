import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'

import { createDesktopBackend } from '../electron/backend.ts'
import { createChatStreamSubscriptionRegistry } from '../electron/chat-stream-subscriptions.ts'
import { ChatManager } from '../server/chat-manager.ts'
import type { launchProviderRun } from '../server/providers.ts'
import type { ChatRequest } from '../shared/schema.ts'

type ProviderSink = Parameters<typeof launchProviderRun>[1]

type CapturedEvent = {
  subscriptionId: string
  event: string
  data: unknown
}

const buildRequest = (streamId: string): ChatRequest => ({
  streamId,
  provider: 'codex',
  prompt: '',
  workspacePath: os.tmpdir(),
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

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, message)
}

const createBackendHarness = () => {
  const events: CapturedEvent[] = []
  let sink: ProviderSink | null = null

  const manager = new ChatManager({
    // 这条用例只关心订阅协议本身。不注入的话 startProvider 会先跑真实 git 快照，
    // 实测（2026-08-02）74ms~3.5s 波动，能吃掉等待预算并假红。
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
    providerLauncher: async (_request, providedSink) => {
      sink = providedSink
      return null
    },
  })

  const backend = createDesktopBackend({
    createChatManager: () => manager,
    onChatStreamEvent: (event) => {
      events.push(event)
    },
  })

  return {
    backend,
    manager,
    events,
    getSink: () => sink,
  }
}

test('subscribeChatStream reports a missing stream through a serializable result', () => {
  const harness = createBackendHarness()

  const result = harness.backend.subscribeChatStream('no-such-stream', 'sub-missing')

  assert.deepEqual(result, { subscribed: false })
  assert.equal(harness.events.length, 0)

  harness.manager.closeAll()
})

test('a subscribed stream pushes events over the independent event channel', async () => {
  const harness = createBackendHarness()
  harness.manager.createStream(buildRequest('stream-events'))
  await waitFor(() => harness.getSink() !== null, 'provider sink was never handed over')

  const result = harness.backend.subscribeChatStream('stream-events', 'sub-events')
  assert.deepEqual(result, { subscribed: true })

  harness.getSink()?.onDelta('hello', 'item-1')

  const deltas = harness.events.filter((entry) => entry.event === 'delta')
  assert.equal(deltas.length, 1)
  assert.equal(deltas[0]?.subscriptionId, 'sub-events')
  assert.deepEqual(deltas[0]?.data, { content: 'hello', itemId: 'item-1' })

  harness.manager.closeAll()
})

test('unsubscribeChatStream stops delivery and repeated unsubscribe is a no-op', async () => {
  const harness = createBackendHarness()
  harness.manager.createStream(buildRequest('stream-unsub'))
  await waitFor(() => harness.getSink() !== null, 'provider sink was never handed over')

  assert.deepEqual(harness.backend.subscribeChatStream('stream-unsub', 'sub-unsub'), {
    subscribed: true,
  })

  harness.getSink()?.onDelta('before', 'item-1')
  assert.equal(harness.events.filter((entry) => entry.event === 'delta').length, 1)

  harness.backend.unsubscribeChatStream('sub-unsub')
  harness.getSink()?.onDelta('after', 'item-2')
  assert.equal(
    harness.events.filter((entry) => entry.event === 'delta').length,
    1,
    'events kept arriving after unsubscribe',
  )

  // 重复退订 / 退订一个从未登记过的 id 都必须是安静的 no-op：清理路径有三处
  // （webContents 销毁、渲染端显式退订、will-quit），互相之间会重叠。
  harness.backend.unsubscribeChatStream('sub-unsub')
  harness.backend.unsubscribeChatStream('never-registered')

  harness.manager.closeAll()
})

test('the registry tells the renderer when the stream does not exist', async () => {
  const delivered: Array<{ target: string; payload: CapturedEvent }> = []
  const unsubscribed: string[] = []

  const registry = createChatStreamSubscriptionRegistry<string>({
    subscribe: () => ({ subscribed: false }),
    unsubscribe: (subscriptionId) => {
      unsubscribed.push(subscriptionId)
    },
    deliver: (target, payload) => {
      delivered.push({ target, payload })
    },
  })

  const result = await registry.subscribe('gone', 'sub-1', 7, 'renderer-a')

  assert.deepEqual(result, { subscribed: false })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.target, 'renderer-a')
  assert.equal(delivered[0]?.payload.event, 'error')
  assert.deepEqual(delivered[0]?.payload.data, { message: 'Stream not found.' })
  assert.equal(registry.size(), 0, 'a failed subscribe must not leave a ghost subscription')
  assert.deepEqual(unsubscribed, [])
})

// 跨进程之后 `deps.subscribe` 的返回值是 Promise。旧写法同步读 `result.subscribed`，
// 在一个 Promise 上读它恒为 undefined → `!result.subscribed` 恒真 → 每一条订阅都会
// 立刻收到 "Stream not found." 并被就地删掉，聊天流全线静默失效。
test('a promised subscribe result is awaited before the not-found branch is taken', async () => {
  const delivered: Array<{ target: string; payload: CapturedEvent }> = []

  const registry = createChatStreamSubscriptionRegistry<string>({
    subscribe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { subscribed: true }
    },
    unsubscribe: () => undefined,
    deliver: (target, payload) => {
      delivered.push({ target, payload })
    },
  })

  const result = await registry.subscribe('live', 'sub-async-ok', 4, 'renderer-async')

  assert.deepEqual(result, { subscribed: true })
  assert.deepEqual(delivered, [], 'a live stream was reported as missing')
  assert.equal(registry.size(), 1, 'a successful subscription was dropped')

  const missingDelivered: Array<{ target: string; payload: CapturedEvent }> = []
  const missing = createChatStreamSubscriptionRegistry<string>({
    subscribe: async () => ({ subscribed: false }),
    unsubscribe: () => undefined,
    deliver: (target, payload) => {
      missingDelivered.push({ target, payload })
    },
  })

  await missing.subscribe('gone', 'sub-async-missing', 4, 'renderer-async')
  assert.equal(missingDelivered.length, 1, 'the missing-stream branch became dead code')
  assert.deepEqual(missingDelivered[0]?.payload.data, { message: 'Stream not found.' })
  assert.equal(missing.size(), 0)
})

// 后端进程崩溃重启后，ChatManager 的 backlog 和所有 streamId 都随旧进程消失了。
// 渲染进程必须收到与"流不存在"完全相同的信号（App.tsx 已经把它落回 idle），否则
// 每张卡都会永久停在 streaming —— 而这次窗口还活着，比闪退更难查。
test('invalidateAll tells every subscriber the stream is gone without calling the dead backend', () => {
  const delivered: Array<{ target: string; payload: CapturedEvent }> = []
  const unsubscribed: string[] = []

  const registry = createChatStreamSubscriptionRegistry<string>({
    subscribe: () => ({ subscribed: true }),
    unsubscribe: (subscriptionId) => {
      unsubscribed.push(subscriptionId)
    },
    deliver: (target, payload) => {
      delivered.push({ target, payload })
    },
  })

  void registry.subscribe('a', 'sub-a', 1, 'renderer-1')
  void registry.subscribe('b', 'sub-b', 2, 'renderer-2')

  registry.invalidateAll()

  assert.deepEqual(
    delivered.map((entry) => [entry.target, entry.payload.subscriptionId, entry.payload.event]),
    [
      ['renderer-1', 'sub-a', 'error'],
      ['renderer-2', 'sub-b', 'error'],
    ],
  )
  assert.deepEqual(delivered[0]?.payload.data, { message: 'Stream not found.' })
  assert.equal(registry.size(), 0)
  assert.deepEqual(
    unsubscribed,
    [],
    'the old backend is gone and the new one never knew these ids; unsubscribing them is a wasted RPC',
  )
})

test('the registry routes events that are emitted during the subscribe call itself', async () => {
  const delivered: Array<{ target: string; payload: CapturedEvent }> = []
  let emitDuringSubscribe: ((payload: CapturedEvent) => void) | null = null

  const registry = createChatStreamSubscriptionRegistry<string>({
    subscribe: (_streamId, subscriptionId) => {
      // ChatManager.subscribe 同步重放 backlog，所以事件会在 subscribe **返回之前**
      // 就到达事件通道。跨进程之后这一点只会更明显（返回值变成 Promise）。
      emitDuringSubscribe?.({ subscriptionId, event: 'delta', data: { content: 'backlog' } })
      return { subscribed: true }
    },
    unsubscribe: () => undefined,
    deliver: (target, payload) => {
      delivered.push({ target, payload })
    },
  })

  emitDuringSubscribe = (payload) => registry.handleEvent(payload)

  await registry.subscribe('live', 'sub-2', 3, 'renderer-b')

  assert.equal(delivered.length, 1, 'backlog replayed during subscribe was dropped')
  assert.equal(delivered[0]?.target, 'renderer-b')
  assert.deepEqual(delivered[0]?.payload.data, { content: 'backlog' })
})

test('the registry cleans up by owner and on shutdown without leaking subscriptions', async () => {
  const unsubscribed: string[] = []
  const delivered: CapturedEvent[] = []

  const registry = createChatStreamSubscriptionRegistry<string>({
    subscribe: () => ({ subscribed: true }),
    unsubscribe: (subscriptionId) => {
      unsubscribed.push(subscriptionId)
    },
    deliver: (_target, payload) => {
      delivered.push(payload)
    },
  })

  await registry.subscribe('a', 'sub-a', 1, 'renderer-1')
  await registry.subscribe('b', 'sub-b', 1, 'renderer-1')
  await registry.subscribe('c', 'sub-c', 2, 'renderer-2')
  assert.equal(registry.size(), 3)

  registry.unsubscribeOwner(1)
  assert.deepEqual([...unsubscribed].sort(), ['sub-a', 'sub-b'])
  assert.equal(registry.size(), 1)

  registry.handleEvent({ subscriptionId: 'sub-a', event: 'delta', data: { content: 'x' } })
  assert.equal(delivered.length, 0, 'a cleaned-up subscription still received events')

  registry.unsubscribe('sub-c')
  assert.deepEqual([...unsubscribed].sort(), ['sub-a', 'sub-b', 'sub-c'])
  assert.equal(registry.size(), 0)

  // will-quit 的兜底清理：此时表已空，不应该再重复退订。
  registry.unsubscribeAll()
  assert.equal(unsubscribed.length, 3)
})

// 登记必须先于 deps.subscribe（backlog 同步重放），这个顺序自带一个代价：
// subscribe 抛错时那条已登记的路由没有任何清理路径能命中它 —— 后端从未登记过
// 这个 id，所以 unsubscribe 是 no-op；渲染进程收到的是一个 rejected invoke，
// 不会再发显式退订。只剩窗口关闭时的 unsubscribeOwner 能兜，在那之前
// handleEvent 会把事件投给一个渲染进程以为已经失败了的订阅。
// 跨进程之后这条路更常走：端口断开 / RPC 超时都会从这里抛出来。
test('a backend subscribe that throws leaves no ghost route behind', async () => {
  const unsubscribed: string[] = []
  const registry = createChatStreamSubscriptionRegistry<string>({
    subscribe: () => {
      throw new Error('backend port is gone')
    },
    unsubscribe: (subscriptionId) => {
      unsubscribed.push(subscriptionId)
    },
    deliver: () => undefined,
  })

  await assert.rejects(
    () => registry.subscribe('live', 'sub-throw', 9, 'renderer-c'),
    /backend port is gone/,
    'the rejection must still reach ipcMain.handle so the renderer gets onError',
  )

  assert.equal(registry.size(), 0, 'a throwing subscribe left a route nothing can clean up')
  assert.deepEqual(unsubscribed, [], 'the backend never registered, so do not call unsubscribe')
})
