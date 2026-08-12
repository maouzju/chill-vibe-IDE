import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import {
  backendRpcChannels,
  createBackendRpcEvent,
  createBackendRpcFailure,
  createBackendRpcIdFactory,
  createBackendRpcRequest,
  createBackendRpcResponse,
  deserializeBackendError,
  findUncloneableValue,
  isBackendRpcEvent,
  isBackendRpcRequest,
  isBackendRpcResponse,
  isStructuredCloneable,
  serializeBackendError,
} from '../electron/backend-rpc-protocol.js'

test('request ids are monotonic per factory and never collide inside one factory', () => {
  const nextId = createBackendRpcIdFactory()
  const other = createBackendRpcIdFactory()

  const ids = [nextId(), nextId(), nextId()]

  assert.deepEqual(ids, [1, 2, 3])
  assert.equal(other(), 1, 'each factory owns its own counter')
})

test('the three message kinds are mutually exclusive and survive a JSON round trip', () => {
  const request = createBackendRpcRequest(7, 'inspectGitWorkspace', [{ workspacePath: 'D:/repo' }])
  const response = createBackendRpcResponse(7, { changes: [] })
  const event = createBackendRpcEvent(backendRpcChannels.chatStreamEvent, {
    subscriptionId: 'sub-1',
    event: 'delta',
    data: { content: 'hi' },
  })

  assert.equal(isBackendRpcRequest(request), true)
  assert.equal(isBackendRpcResponse(request), false)
  assert.equal(isBackendRpcEvent(request), false)

  assert.equal(isBackendRpcResponse(response), true)
  assert.equal(isBackendRpcRequest(response), false)

  assert.equal(isBackendRpcEvent(event), true)
  assert.equal(isBackendRpcRequest(event), false)

  assert.deepEqual(JSON.parse(JSON.stringify(request)), request)
  assert.equal(request.method, 'inspectGitWorkspace')
  assert.deepEqual(request.args, [{ workspacePath: 'D:/repo' }])

  assert.equal(isBackendRpcRequest({ type: 'backend-rpc/request' }), false)
  assert.equal(isBackendRpcRequest(null), false)
  assert.equal(isBackendRpcRequest('backend-rpc/request'), false)
})

test('a plain Error keeps name, message and stack across the boundary', () => {
  const original = new Error('workspace path escaped the sandbox')
  original.name = 'WorkspaceBoundaryError'

  const restored = deserializeBackendError(serializeBackendError(original))

  assert.equal(restored instanceof Error, true, 'the receiver must get a real Error instance')
  assert.equal(restored.name, 'WorkspaceBoundaryError')
  assert.equal(restored.message, 'workspace path escaped the sandbox')
  assert.equal(restored.stack, original.stack, 'the backend-side stack is the only useful one')
})

test('a ZodError keeps its issues, which is what the 60+ .parse() call sites throw', () => {
  const schema = z.object({ workspacePath: z.string().min(1) })
  let thrown: unknown
  try {
    schema.parse({ workspacePath: 123 })
  } catch (error) {
    thrown = error
  }

  assert.equal(thrown instanceof z.ZodError, true, 'fixture did not produce a ZodError')

  const wire = serializeBackendError(thrown)
  // 结构化克隆会把 Error 退化成 {}（backend.ts:592-597 记录过同类事故），
  // 所以载荷必须是**纯数据**，而且 JSON 往返之后 issues 还得在。
  const restored = deserializeBackendError(JSON.parse(JSON.stringify(wire)))

  assert.equal(restored instanceof Error, true)
  assert.equal(restored.name, 'ZodError')
  const issues = (restored as unknown as { issues?: unknown[] }).issues
  assert.equal(Array.isArray(issues), true, 'ZodError.issues was lost across the boundary')
  assert.equal(issues?.length, 1)
  assert.equal((issues?.[0] as { path?: unknown[] }).path?.[0], 'workspacePath')
})

test('non-Error rejections still arrive as an Error instead of an empty object', () => {
  const fromString = deserializeBackendError(serializeBackendError('Stream not found.'))
  assert.equal(fromString instanceof Error, true)
  assert.equal(fromString.message, 'Stream not found.')

  const fromNothing = deserializeBackendError(serializeBackendError(undefined))
  assert.equal(fromNothing instanceof Error, true)
  assert.notEqual(fromNothing.message.trim(), '')

  const fromGarbage = deserializeBackendError({ nope: true })
  assert.equal(fromGarbage instanceof Error, true)
  assert.notEqual(fromGarbage.message.trim(), '')
})

test('error side channels that cannot be cloned are dropped instead of poisoning the payload', () => {
  const error = new Error('write failed') as Error & { code?: string; retry?: unknown }
  error.code = 'EPERM'
  error.retry = () => undefined

  const wire = serializeBackendError(error)

  assert.equal(isStructuredCloneable(wire), true, 'the wire payload itself must be cloneable')
  const restored = deserializeBackendError(wire) as Error & { code?: string; retry?: unknown }
  assert.equal(restored.code, 'EPERM', 'fs-style error codes are read by call sites')
  assert.equal(restored.retry, undefined, 'a function must not be smuggled through')
})

test('the cloneability probe accepts real payload shapes including cycles', () => {
  const cyclic: Record<string, unknown> = { name: 'card' }
  cyclic.self = cyclic

  for (const value of [
    undefined,
    null,
    0,
    '',
    true,
    new Date(0),
    /x/g,
    new Uint8Array([1, 2, 3]),
    new Map([['a', { b: 1 }]]),
    new Set([1, 2]),
    [{ nested: [{ deep: true }] }],
    cyclic,
  ]) {
    assert.equal(findUncloneableValue(value), null, `rejected a cloneable value: ${String(value)}`)
  }
})

test('the cloneability probe names the exact path of a function or promise', () => {
  const report = findUncloneableValue({ options: { onDone: () => undefined } }, 'args[0]')

  assert.notEqual(report, null, 'a callback argument must be caught before it is posted')
  assert.equal(report?.path, 'args[0].options.onDone')
  assert.equal(report?.reason, 'function')

  const promiseReport = findUncloneableValue([Promise.resolve(1)], 'args')
  assert.equal(promiseReport?.path, 'args[0]')
  assert.equal(promiseReport?.reason, 'Promise')

  assert.equal(isStructuredCloneable({ ok: 1 }), true)
  assert.equal(isStructuredCloneable({ ok: () => 1 }), false)
})

test('a failure response carries a serialized error, never a raw Error object', () => {
  const failure = createBackendRpcFailure(11, new Error('boom'))

  assert.equal(isBackendRpcResponse(failure), true)
  assert.equal(failure.id, 11)
  assert.equal(failure.ok, false)
  assert.equal(isStructuredCloneable(failure), true)
  assert.equal(failure.ok === false && failure.error.message, 'boom')
})
