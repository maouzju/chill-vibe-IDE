import assert from 'node:assert/strict'
import test from 'node:test'

import {
  backendRpcChannels,
  createBackendRpcEvent,
  createBackendRpcHostRequest,
  createBackendRpcResponse,
  isBackendRpcHostResponse,
  isBackendRpcInit,
  isBackendRpcRequest,
  type BackendRpcMessage,
} from '../electron/backend-rpc-protocol.ts'
import { backendNotStartedMessage, createBackendHost } from '../electron/backend-host.ts'

type FakeBackend = {
  fetchState: () => Promise<{ ok: boolean }>
  flushStateWrites: () => Promise<void>
}

const createFakeChild = () => {
  const messages: BackendRpcMessage[] = []
  let messageListener: ((message: unknown) => void) | null = null
  let exitListener: ((code: number | null) => void) | null = null
  let killCount = 0

  return {
    messages,
    killCount: () => killCount,
    child: {
      postMessage: (message: BackendRpcMessage) => {
        messages.push(message)
      },
      onMessage: (listener: (message: unknown) => void) => {
        messageListener = listener
      },
      onExit: (listener: (code: number | null) => void) => {
        exitListener = listener
      },
      kill: () => {
        killCount += 1
      },
    },
    receive: (message: unknown) => {
      messageListener?.(message)
    },
    exit: (code: number | null = 1) => {
      exitListener?.(code)
    },
    requests: () => messages.filter(isBackendRpcRequest),
    hostResponses: () => messages.filter(isBackendRpcHostResponse),
  }
}

const createHarness = (
  overrides: Partial<Parameters<typeof createBackendHost>[0]> = {},
  init: { workingDirectory: string | null } = { workingDirectory: 'D:/repo' },
) => {
  const children: Array<ReturnType<typeof createFakeChild>> = []
  const lost: Array<{ exitCode: number | null; attempt: number; willRestart: boolean }> = []

  const host = createBackendHost<FakeBackend>({
    fork: () => {
      const next = createFakeChild()
      children.push(next)
      return next.child
    },
    resolveInit: () => init,
    onBackendLost: (info) => {
      lost.push(info)
    },
    // 重启延迟在测试里必须是同步的：否则"没重启"和"还没轮到重启"看起来一样。
    schedule: (callback) => {
      callback()
    },
    ...overrides,
  })

  return { host, children, lost }
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// R7 / 数据目录不漂移：init 必须是端口上的第一条消息。早到的请求会被 utility host
// 缓冲（tests/backend-rpc-utility-host.test.ts 已证明），但缓冲只在 init 最终到达时
// 才会解开 —— 所以 ensureBackend() 在 init 发出之前 resolve 就等于让所有调用永远
// 挂在缓冲里。
test('ensureBackend posts init as the very first port message', { timeout: 10_000 }, async () => {
  const { host, children } = createHarness()

  await host.ensureBackend()

  assert.equal(children.length, 1)
  const first = children[0]?.messages[0]
  assert.ok(isBackendRpcInit(first), 'init was not the first message on the port')
  assert.equal(first.workingDirectory, 'D:/repo')
})

// 症状（跨进程后）：数据目录静默漂移，用户视角是"历史全没了"。
// 打包版的 desktopWorkingDirectory 是 null，host 会正确跳过 chdir 并继承 fork 时的
// cwd；退化成空字符串则把"不要 chdir"表达成了一个路径。
test('an empty working directory is normalized to null instead of a path', { timeout: 10_000 }, async () => {
  const { host, children } = createHarness({}, { workingDirectory: '' })

  await host.ensureBackend()

  const first = children[0]?.messages[0]
  assert.ok(isBackendRpcInit(first))
  assert.equal(first.workingDirectory, null)
})

test('a backend call before ensureBackend fails loudly instead of forking early', { timeout: 10_000 }, async () => {
  const { host, children } = createHarness()

  const tooEarly = host.proxy.fetchState()
  // 先断言"没有 fork"：这才是这条用例真正守的东西。放在 rejects 之后的话，一个
  // 顺手自动启动的实现会让 rejects 永不 settle，测试变成超时而不是一条清晰的红。
  assert.equal(children.length, 0, 'the backend must not be forked before the desktop env is configured')
  await assert.rejects(tooEarly, new RegExp(backendNotStartedMessage))
})

// R4 — dispatchRemoteCommand / dispatchWorkspaceAdminCommand 是 host→main 的**请求**，
// 它们的布尔返回值直接决定 HTTP 503/202。忘了注册的话手机远程监工会静默全部报"无窗口"。
test('the backend gets real answers on the remote-command and workspace-admin channels', { timeout: 10_000 }, async () => {
  const { host, children } = createHarness()
  const delivered: unknown[] = []

  host.onRequest(backendRpcChannels.remoteCommand, (payload) => {
    delivered.push(payload)
    return true
  })
  host.onRequest(backendRpcChannels.workspaceAdminCommand, () => false)

  await host.ensureBackend()

  children[0]?.receive(
    createBackendRpcHostRequest(1, backendRpcChannels.remoteCommand, { kind: 'send-message' }),
  )
  children[0]?.receive(
    createBackendRpcHostRequest(2, backendRpcChannels.workspaceAdminCommand, { kind: 'stop' }),
  )
  await settle()

  const responses = children[0]?.hostResponses() ?? []
  assert.deepEqual(
    responses.map((entry) => [entry.id, entry.ok, entry.ok ? entry.value : null]),
    [
      [1, true, true],
      [2, true, false],
    ],
  )
  assert.deepEqual(delivered, [{ kind: 'send-message' }])
})

test('push channels keep delivering to the same handler after a restart', { timeout: 10_000 }, async () => {
  const { host, children } = createHarness()
  const received: unknown[] = []

  host.onEvent(backendRpcChannels.chatStreamEvent, (payload) => {
    received.push(payload)
  })

  await host.ensureBackend()
  children[0]?.receive(createBackendRpcEvent(backendRpcChannels.chatStreamEvent, { seq: 1 }))

  children[0]?.exit(9)
  await settle()

  assert.equal(children.length, 2, 'the backend was never restarted')
  children[1]?.receive(createBackendRpcEvent(backendRpcChannels.chatStreamEvent, { seq: 2 }))

  assert.deepEqual(received, [{ seq: 1 }, { seq: 2 }])
})

// R5 — 今天后端死 = 整个 app 死（可见）。以后 utility 独立退出而窗口还活着，
// 挂起的调用若不被拒绝就是"永久无响应"，比现在的闪退更难查。
test('a backend crash rejects in-flight calls, reports the loss, and re-inits the new child', { timeout: 10_000 }, async () => {
  const { host, children, lost } = createHarness()

  await host.ensureBackend()
  const inFlight = host.proxy.fetchState()
  assert.equal(children[0]?.requests().length, 1)

  children[0]?.exit(3221225477)
  await assert.rejects(inFlight, /backend process exited/i)

  assert.deepEqual(lost, [{ exitCode: 3221225477, attempt: 1, willRestart: true }])
  assert.equal(children.length, 2)
  assert.ok(isBackendRpcInit(children[1]?.messages[0]), 'the restarted child never received init')

  const afterRestart = host.proxy.fetchState()
  const request = children[1]?.requests()[0]
  assert.ok(request, 'calls after a restart never reached the new child')
  children[1]?.receive(createBackendRpcResponse(request.id, { ok: true }))
  assert.deepEqual(await afterRestart, { ok: true })
})

test('the restart budget is bounded and the last loss says it will not come back', { timeout: 10_000 }, async () => {
  const { host, children, lost } = createHarness({ maxRestarts: 2 })

  await host.ensureBackend()
  children[0]?.exit(1)
  await settle()
  children[1]?.exit(1)
  await settle()
  children[2]?.exit(1)
  await settle()

  assert.equal(children.length, 3, 'the host kept forking past its restart budget')
  assert.deepEqual(
    lost.map((entry) => entry.willRestart),
    [true, true, false],
  )
  await assert.rejects(host.proxy.fetchState(), /not available/i)
})

test('shutdown stops the child and never resurrects it', { timeout: 10_000 }, async () => {
  const { host, children, lost } = createHarness()

  await host.ensureBackend()
  host.shutdown()

  assert.equal(children[0]?.killCount(), 1)

  children[0]?.exit(0)
  await settle()

  assert.equal(children.length, 1, 'a deliberate shutdown must not trigger the restart policy')
  assert.deepEqual(lost, [])
})

test('a shutdown during the restart backoff cancels the pending relaunch', { timeout: 10_000 }, async () => {
  const pendingRelaunches: Array<() => void> = []
  const { host, children } = createHarness({
    schedule: (callback) => {
      pendingRelaunches.push(callback)
    },
  })

  await host.ensureBackend()
  children[0]?.exit(1)
  await settle()

  assert.equal(pendingRelaunches.length, 1, 'the restart was never scheduled')
  assert.equal(children.length, 1)

  host.shutdown()
  pendingRelaunches[0]?.()

  assert.equal(children.length, 1, 'the backoff timer resurrected a deliberately stopped backend')
})

// 退出握手：先让子进程 flush 完再 app.quit()。flushStateWrites 是一次 RPC，
// 所以 shutdown 必须排在它 settle 之后，否则最后一次状态写入随进程一起消失。
test('shutdown after a flush still reaches the child that answered the flush', { timeout: 10_000 }, async () => {
  const { host, children } = createHarness()

  await host.ensureBackend()
  const flushing = host.proxy.flushStateWrites()
  const request = children[0]?.requests()[0]
  assert.equal(request?.method, 'flushStateWrites')

  children[0]?.receive(createBackendRpcResponse(request!.id, undefined))
  await flushing

  host.shutdown()
  assert.equal(children[0]?.killCount(), 1)
})
