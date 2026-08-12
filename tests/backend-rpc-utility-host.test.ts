import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

import {
  backendRpcChannels,
  createBackendRpcHostResponse,
  createBackendRpcInit,
  createBackendRpcRequest,
  isBackendRpcEvent,
  isBackendRpcFatal,
  isBackendRpcHostRequest,
  isBackendRpcResponse,
  type BackendRpcMessage,
} from '../electron/backend-rpc-protocol.js'
import { createBackendRpcClient } from '../electron/backend-rpc-client.js'
import {
  createBackendUtilityHost,
  formatUtilityHostCrashLine,
  resolveUtilityHostLogPath,
} from '../electron/utility-host.js'

type HostBackendDeps = Parameters<Parameters<typeof createBackendUtilityHost>[0]['loadBackend']>[0]

const createFakePort = () => {
  const sent: BackendRpcMessage[] = []
  let listener: ((message: unknown) => void) | null = null

  return {
    sent,
    transport: {
      postMessage: (message: BackendRpcMessage) => {
        sent.push(message)
      },
      onMessage: (next: (message: unknown) => void) => {
        listener = next
      },
    },
    receive: (message: unknown) => {
      listener?.(message)
    },
    responses: () => sent.filter(isBackendRpcResponse),
    events: () => sent.filter(isBackendRpcEvent),
    hostRequests: () => sent.filter(isBackendRpcHostRequest),
    fatals: () => sent.filter(isBackendRpcFatal),
  }
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const createHostHarness = (
  overrides: {
    directoryExists?: (directory: string) => boolean
    backend?: Record<string, unknown>
    loadBackend?: (deps: HostBackendDeps) => unknown
    hostRequestTimeoutMs?: number
  } = {},
) => {
  const port = createFakePort()
  const chdirCalls: string[] = []
  const appliedEnv: Record<string, string> = {}
  const fatalLog: Array<{ scope: string; error: unknown }> = []
  let capturedDeps: HostBackendDeps | null = null

  const host = createBackendUtilityHost({
    transport: port.transport,
    loadBackend: (deps) => {
      capturedDeps = deps
      if (overrides.loadBackend) {
        return overrides.loadBackend(deps) as never
      }
      return (overrides.backend ?? {}) as never
    },
    directoryExists: overrides.directoryExists ?? (() => true),
    chdir: (directory) => {
      chdirCalls.push(directory)
    },
    applyEnv: (env) => {
      Object.assign(appliedEnv, env)
    },
    logFatal: (scope, error) => {
      fatalLog.push({ scope, error })
    },
    ...(overrides.hostRequestTimeoutMs === undefined
      ? {}
      : { hostRequestTimeoutMs: overrides.hostRequestTimeoutMs }),
  })

  return {
    host,
    port,
    chdirCalls,
    appliedEnv,
    fatalLog,
    getDeps: () => capturedDeps,
  }
}

test('a working directory that exists is applied before the backend module is loaded', { timeout: 10_000 }, async () => {
  const order: string[] = []
  const port = createFakePort()
  createBackendUtilityHost({
    transport: port.transport,
    loadBackend: () => {
      order.push('load-backend')
      return {} as never
    },
    directoryExists: () => true,
    chdir: (directory) => {
      order.push(`chdir:${directory}`)
    },
    applyEnv: () => {
      order.push('apply-env')
    },
  })

  port.receive(
    createBackendRpcInit({
      workingDirectory: 'D:/Git/chill-vibe',
      env: { CHILL_VIBE_DATA_DIR: 'D:/data' },
    }),
  )
  port.receive(createBackendRpcRequest(1, 'anything', []))
  await flush()

  assert.deepEqual(order, ['apply-env', 'chdir:D:/Git/chill-vibe', 'load-backend'])
})

test('a null working directory keeps the inherited cwd and still starts the host', { timeout: 10_000 }, async () => {
  const harness = createHostHarness({ backend: { ping: () => 'pong' } })

  harness.port.receive(createBackendRpcInit({ workingDirectory: null }))
  harness.port.receive(createBackendRpcRequest(1, 'ping', []))
  await flush()

  assert.deepEqual(harness.chdirCalls, [], 'packaged builds inherit the fork cwd; do not chdir to nothing')
  const reply = harness.port.responses()[0]
  assert.equal(reply?.ok, true)
  assert.equal(reply?.ok === true && reply.value, 'pong')
})

test('a missing working directory fails loudly instead of drifting the data directory', { timeout: 10_000 }, async () => {
  const harness = createHostHarness({
    directoryExists: () => false,
    backend: { ping: () => 'pong' },
  })

  harness.port.receive(createBackendRpcInit({ workingDirectory: 'D:/gone' }))
  harness.port.receive(createBackendRpcRequest(1, 'ping', []))
  await flush()

  assert.deepEqual(harness.chdirCalls, [], 'never chdir into a directory that does not exist')

  const fatal = harness.port.fatals()[0]
  assert.notEqual(fatal, undefined, 'the parent must be told, or the backend dies silently')
  assert.match(fatal!.error.message, /D:\/gone/)

  const reply = harness.port.responses()[0]
  assert.equal(reply?.ok, false, 'calls must fail, not run against the wrong data directory')
  assert.match(String(reply?.ok === false && reply.error.message), /D:\/gone/)
  assert.equal(harness.getDeps(), null, 'the backend module must never load after a failed init')
})

test('a chdir that throws is reported as an init failure, not swallowed', { timeout: 10_000 }, async () => {
  const port = createFakePort()
  createBackendUtilityHost({
    transport: port.transport,
    loadBackend: () => ({}) as never,
    directoryExists: () => true,
    chdir: () => {
      throw new Error('EACCES: permission denied')
    },
  })

  port.receive(createBackendRpcInit({ workingDirectory: 'D:/locked' }))
  port.receive(createBackendRpcRequest(1, 'ping', []))
  await flush()

  const reply = port.responses()[0]
  assert.equal(reply?.ok, false)
  assert.match(String(reply?.ok === false && reply.error.message), /EACCES/)
})

test('requests that arrive before init are answered once init lands', { timeout: 10_000 }, async () => {
  const harness = createHostHarness({ backend: { ping: () => 'pong' } })

  harness.port.receive(createBackendRpcRequest(1, 'ping', []))
  await flush()
  assert.equal(harness.port.responses().length, 0, 'do not answer before the cwd/env are settled')

  harness.port.receive(createBackendRpcInit({ workingDirectory: null }))
  await flush()

  const reply = harness.port.responses()[0]
  assert.equal(reply?.id, 1)
  assert.equal(reply?.ok === true && reply.value, 'pong')
})

test('method dispatch forwards arguments, awaits promises and names unknown methods', { timeout: 10_000 }, async () => {
  const seen: unknown[][] = []
  const harness = createHostHarness({
    backend: {
      inspectGitWorkspace: async (...args: unknown[]) => {
        seen.push(args)
        return { changes: ['a.ts'] }
      },
      notAFunction: 42,
    },
  })

  harness.port.receive(createBackendRpcInit({ workingDirectory: null }))
  harness.port.receive(createBackendRpcRequest(1, 'inspectGitWorkspace', [{ workspacePath: 'D:/repo' }, true]))
  harness.port.receive(createBackendRpcRequest(2, 'thisDoesNotExist', []))
  harness.port.receive(createBackendRpcRequest(3, 'notAFunction', []))
  await flush()

  assert.deepEqual(seen, [[{ workspacePath: 'D:/repo' }, true]])

  const byId = new Map(harness.port.responses().map((reply) => [reply.id, reply]))
  const succeeded = byId.get(1)
  const unknownMethod = byId.get(2)
  const notCallable = byId.get(3)

  assert.deepEqual(succeeded?.ok === true && succeeded.value, { changes: ['a.ts'] })
  assert.equal(unknownMethod?.ok, false)
  assert.match(
    String(unknownMethod?.ok === false && unknownMethod.error.message),
    /thisDoesNotExist/,
  )
  assert.equal(notCallable?.ok, false, 'a non-callable property must not be invoked')
})

test('a backend module that fails to load answers with the load error', { timeout: 10_000 }, async () => {
  const harness = createHostHarness({
    loadBackend: () => {
      throw new Error('Cannot find module ./backend.js')
    },
  })

  harness.port.receive(createBackendRpcInit({ workingDirectory: null }))
  harness.port.receive(createBackendRpcRequest(1, 'ping', []))
  await flush()

  const reply = harness.port.responses()[0]
  assert.equal(reply?.ok, false)
  assert.match(String(reply?.ok === false && reply.error.message), /Cannot find module/)
})

test('push channels become events carrying pure data', { timeout: 10_000 }, async () => {
  const harness = createHostHarness({ backend: {} })
  harness.port.receive(createBackendRpcInit({ workingDirectory: null }))
  harness.port.receive(createBackendRpcRequest(1, 'noSuchMethodJustToLoad', []))
  await flush()

  const deps = harness.getDeps()
  assert.notEqual(deps, null, 'the host must hand its own deps to the backend factory')

  deps!.onChatStreamEvent?.({ subscriptionId: 'sub-1', event: 'delta', data: { content: 'hi' } })
  deps!.onFileWatchEvent?.({ subscriptionId: 'watch-1' })
  deps!.onUnsolicitedStream?.({ cardId: 'card-1', streamId: 'stream-1' })

  const channels = harness.port.events().map((event) => event.channel)
  assert.deepEqual(channels, [
    backendRpcChannels.chatStreamEvent,
    backendRpcChannels.fileWatchEvent,
    backendRpcChannels.unsolicitedStream,
  ])
  assert.deepEqual(harness.port.events()[0]?.payload, {
    subscriptionId: 'sub-1',
    event: 'delta',
    data: { content: 'hi' },
  })
})

test('dispatch callbacks round-trip to the parent and degrade to false when it never answers', { timeout: 10_000 }, async () => {
  const harness = createHostHarness({ backend: {}, hostRequestTimeoutMs: 25 })
  harness.port.receive(createBackendRpcInit({ workingDirectory: null }))
  harness.port.receive(createBackendRpcRequest(1, 'noSuchMethodJustToLoad', []))
  await flush()

  const deps = harness.getDeps()
  const delivered = deps!.dispatchRemoteCommand?.({ kind: 'send' } as never)
  const admin = deps!.dispatchWorkspaceAdminCommand?.({ kind: 'admin' } as never)

  const requests = harness.port.hostRequests()
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.channel, backendRpcChannels.remoteCommand)
  assert.equal(requests[1]?.channel, backendRpcChannels.workspaceAdminCommand)

  harness.port.receive(createBackendRpcHostResponse(requests[0]!.id, true))
  assert.equal(await delivered, true)

  // 没人回它时必须收敛成 false（HTTP 层据此回 503），而不是让请求永远挂着。
  assert.equal(await admin, false)
})

test('a Zod failure inside the backend reaches the main-process caller with its issues', { timeout: 10_000 }, async () => {
  const hostPort = createFakePort()
  const clientPort = createFakePort()

  // Wire the two fake ports into each other so this exercises the real
  // client + host pair, not a hand-written stand-in for either side.
  const hostTransport = {
    postMessage: (message: BackendRpcMessage) => {
      hostPort.sent.push(message)
      clientPort.receive(message)
    },
    onMessage: hostPort.transport.onMessage,
  }
  const clientTransport = {
    postMessage: (message: BackendRpcMessage) => {
      clientPort.sent.push(message)
      hostPort.receive(message)
    },
    onMessage: clientPort.transport.onMessage,
    onClose: () => undefined,
  }

  createBackendUtilityHost({
    transport: hostTransport,
    loadBackend: () =>
      ({
        saveState: (state: unknown) => z.object({ columns: z.array(z.string()) }).parse(state),
      }) as never,
    directoryExists: () => true,
    chdir: () => undefined,
    applyEnv: () => undefined,
  })

  const client = createBackendRpcClient<{ saveState: (state: unknown) => Promise<unknown> }>(
    clientTransport,
  )

  clientTransport.postMessage(createBackendRpcInit({ workingDirectory: null }))

  await assert.rejects(client.proxy.saveState({ columns: 5 }), (error: unknown) => {
    assert.equal(error instanceof Error, true)
    assert.equal((error as Error).name, 'ZodError')
    const issues = (error as { issues?: unknown[] }).issues
    assert.equal(Array.isArray(issues), true, 'ZodError.issues did not survive the real round trip')
    assert.equal((issues?.[0] as { path?: unknown[] }).path?.[0], 'columns')
    return true
  })

  assert.deepEqual(await client.proxy.saveState({ columns: ['a'] }), { columns: ['a'] })
})

test('the crash log lands beside main.log and records the stack, not just the message', () => {
  assert.equal(
    resolveUtilityHostLogPath('D:/data'),
    path.join('D:/data', 'logs', 'utility-host.log'),
  )
  assert.equal(
    resolveUtilityHostLogPath(undefined),
    path.join(process.cwd(), '.chill-vibe', 'logs', 'utility-host.log'),
  )

  const error = new Error('boom')
  const line = formatUtilityHostCrashLine('uncaughtException', error, new Date(0))

  assert.match(line, /uncaughtException/)
  assert.match(line, /boom/)
  assert.match(line, /1970-01-01T00:00:00\.000Z/)
  assert.match(line, /Error: boom\s+at /, 'without the stack the log cannot locate the failure')
  assert.equal(line.endsWith(os.EOL) || line.endsWith('\n'), true)
})
