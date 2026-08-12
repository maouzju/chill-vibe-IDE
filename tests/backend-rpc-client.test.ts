import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import {
  backendRpcChannels,
  createBackendRpcEvent,
  createBackendRpcFailure,
  createBackendRpcHostRequest,
  createBackendRpcResponse,
  isBackendRpcHostResponse,
  isBackendRpcRequest,
  type BackendRpcMessage,
} from '../electron/backend-rpc-protocol.js'
import { createBackendProxy, createBackendRpcClient } from '../electron/backend-rpc-client.js'

type FakeBackend = {
  inspectGitWorkspace: (request: { workspacePath: string }) => Promise<{ changes: string[] }>
  saveState: (state: unknown) => Promise<void>
  subscribeChatStream: (streamId: string, subscriptionId: string) => Promise<{ subscribed: boolean }>
}

const createFakeTransport = () => {
  const sent: BackendRpcMessage[] = []
  let messageListener: ((message: unknown) => void) | null = null
  let closeListener: ((reason: string) => void) | null = null

  return {
    sent,
    transport: {
      postMessage: (message: BackendRpcMessage) => {
        sent.push(message)
      },
      onMessage: (listener: (message: unknown) => void) => {
        messageListener = listener
      },
      onClose: (listener: (reason: string) => void) => {
        closeListener = listener
      },
    },
    receive: (message: unknown) => {
      messageListener?.(message)
    },
    closeTransport: (reason = 'backend process exited') => {
      closeListener?.(reason)
    },
    lastRequest: () => {
      for (let index = sent.length - 1; index >= 0; index -= 1) {
        const message = sent[index]
        if (isBackendRpcRequest(message)) {
          return message
        }
      }
      return null
    },
  }
}

test('a proxied property call becomes one request message and resolves with the reply', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const backend = createBackendProxy<FakeBackend>(fake.transport)

  const pending = backend.inspectGitWorkspace({ workspacePath: 'D:/repo' })

  const request = fake.lastRequest()
  assert.notEqual(request, null, 'calling a proxy method must post a request')
  assert.equal(request?.method, 'inspectGitWorkspace')
  assert.deepEqual(request?.args, [{ workspacePath: 'D:/repo' }])

  fake.receive(createBackendRpcResponse(request!.id, { changes: ['a.ts'] }))

  assert.deepEqual(await pending, { changes: ['a.ts'] })
})

test('every property access returns the same callable, and inspection hooks stay undefined', () => {
  const fake = createFakeTransport()
  const backend = createBackendProxy<Record<string, unknown>>(fake.transport)

  assert.equal(typeof backend.anythingAtAll, 'function')
  assert.equal(backend.anythingAtAll, backend.anythingAtAll, 'method identity must be stable')

  // `await someProxy` looks up `then`; if that returned a callable the whole
  // object would masquerade as a thenable and hang the awaiter forever.
  assert.equal((backend as { then?: unknown }).then, undefined)
  assert.equal((backend as Record<symbol, unknown>)[Symbol.iterator], undefined)
  assert.equal(fake.sent.length, 0, 'inspection must not post anything')
})

test('a failed call rejects with a real Error, ZodError issues included', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const backend = createBackendProxy<FakeBackend>(fake.transport)

  const pending = backend.saveState({ broken: true })
  const request = fake.lastRequest()

  let zodError: unknown
  try {
    z.object({ columns: z.array(z.string()) }).parse({ columns: 5 })
  } catch (error) {
    zodError = error
  }

  fake.receive(createBackendRpcFailure(request!.id, zodError))

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof Error, true, 'a rejection must stay an Error across the boundary')
    assert.equal((error as Error).name, 'ZodError')
    assert.equal(Array.isArray((error as { issues?: unknown[] }).issues), true)
    return true
  })
})

test('an unmatched or duplicated response id is ignored instead of throwing', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const backend = createBackendProxy<FakeBackend>(fake.transport)

  const pending = backend.saveState({})
  const request = fake.lastRequest()

  fake.receive(createBackendRpcResponse(9999, 'not mine'))
  fake.receive(createBackendRpcResponse(request!.id, undefined))
  fake.receive(createBackendRpcResponse(request!.id, 'late duplicate'))
  fake.receive({ type: 'nonsense' })

  assert.equal(await pending, undefined)
})

test('a configured timeout rejects the call and forgets the pending entry', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const client = createBackendRpcClient<FakeBackend>(fake.transport, { timeoutMs: 25 })

  const pending = client.proxy.saveState({})
  assert.equal(client.pendingRequestCount(), 1)

  await assert.rejects(pending, /timed out/i)
  assert.equal(client.pendingRequestCount(), 0, 'a timed-out call must not leak a pending entry')

  // A late reply for a timed-out id must be a silent no-op, not a crash.
  fake.receive(createBackendRpcResponse(fake.lastRequest()!.id, 'too late'))
  client.close()
})

test('a per-method timeout override wins over the default', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const client = createBackendRpcClient<FakeBackend>(fake.transport, {
    timeoutMs: 25,
    // 长跑方法（安装 CLI、拉模型）必须能不受默认超时约束，否则跨进程改造
    // 会把"慢"变成"失败"。
    resolveTimeoutMs: (method) => (method === 'saveState' ? null : undefined),
  })

  const slow = client.proxy.saveState({})
  const quick = client.proxy.subscribeChatStream('s', 'sub')

  await assert.rejects(quick, /timed out/i)
  assert.equal(client.pendingRequestCount(), 1, 'the opted-out call must still be pending')

  const remaining = fake.sent.filter(isBackendRpcRequest).find((entry) => entry.method === 'saveState')
  fake.receive(createBackendRpcResponse(remaining!.id, undefined))
  assert.equal(await slow, undefined)
})

test('losing the transport rejects every pending call and fails fast afterwards', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const client = createBackendRpcClient<FakeBackend>(fake.transport)

  const first = client.proxy.saveState({})
  const second = client.proxy.inspectGitWorkspace({ workspacePath: 'D:/repo' })
  assert.equal(client.pendingRequestCount(), 2)

  fake.closeTransport('backend process exited (code 1)')

  await assert.rejects(first, /backend process exited \(code 1\)/)
  await assert.rejects(second, /backend process exited \(code 1\)/)
  assert.equal(client.pendingRequestCount(), 0)

  // 拆解之后再调用不能再挂起：每个 IPC handler 都 await 它，挂起 = 整窗静默失效。
  const postCloseCount = fake.sent.length
  await assert.rejects(client.proxy.saveState({}), /backend process exited/)
  assert.equal(fake.sent.length, postCloseCount, 'a closed client must not keep posting')
})

test('backend events reach registered handlers and stop after unregistering', () => {
  const fake = createFakeTransport()
  const client = createBackendRpcClient<FakeBackend>(fake.transport)

  const seen: unknown[] = []
  const stop = client.onEvent(backendRpcChannels.chatStreamEvent, (payload) => {
    seen.push(payload)
  })

  fake.receive(
    createBackendRpcEvent(backendRpcChannels.chatStreamEvent, {
      subscriptionId: 'sub-1',
      event: 'delta',
      data: { content: 'hello' },
    }),
  )
  // An event nobody listens to is a stale channel, not an error.
  fake.receive(createBackendRpcEvent('channel-nobody-owns', { x: 1 }))

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { subscriptionId: 'sub-1', event: 'delta', data: { content: 'hello' } })

  stop()
  fake.receive(createBackendRpcEvent(backendRpcChannels.chatStreamEvent, { subscriptionId: 'sub-1' }))
  assert.equal(seen.length, 1, 'events kept arriving after unregistering')
})

test('backend-initiated requests are answered, including when the handler throws', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const client = createBackendRpcClient<FakeBackend>(fake.transport)

  client.onRequest(backendRpcChannels.remoteCommand, async (payload) => {
    return (payload as { kind: string }).kind === 'send'
  })
  client.onRequest(backendRpcChannels.workspaceAdminCommand, () => {
    throw new Error('no window could take it')
  })

  fake.receive(createBackendRpcHostRequest(1, backendRpcChannels.remoteCommand, { kind: 'send' }))
  fake.receive(createBackendRpcHostRequest(2, backendRpcChannels.workspaceAdminCommand, {}))
  fake.receive(createBackendRpcHostRequest(3, 'channel-nobody-owns', {}))

  await new Promise((resolve) => setImmediate(resolve))

  const replies = fake.sent.filter(isBackendRpcHostResponse)
  assert.equal(replies.length, 3, 'every host request must get exactly one reply')

  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  const delivered = byId.get(1)
  const rejected = byId.get(2)
  const unhandled = byId.get(3)

  assert.equal(delivered?.ok === true && delivered.value, true)
  assert.equal(rejected?.ok, false)
  assert.match(String(rejected?.ok === false && rejected.error.message), /no window could take it/)
  assert.equal(unhandled?.ok, false, 'an unhandled channel must fail loudly, not hang the backend')
})

test('opting into payload validation catches a callback before it is posted', { timeout: 10_000 }, async () => {
  const fake = createFakeTransport()
  const client = createBackendRpcClient<Record<string, (...args: unknown[]) => Promise<unknown>>>(
    fake.transport,
    { validatePayloads: true },
  )

  await assert.rejects(
    client.proxy.subscribeChatStream('stream-1', () => undefined),
    (error: unknown) => {
      assert.match(String((error as Error).message), /args\[1\]/)
      assert.match(String((error as Error).message), /function/)
      return true
    },
  )

  assert.equal(fake.sent.length, 0, 'an uncloneable payload must never reach the port')
  assert.equal(client.pendingRequestCount(), 0)
})
