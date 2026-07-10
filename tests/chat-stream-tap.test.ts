import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildActiveStreamViews,
  createChatStreamTapRegistry,
  type ChatStreamTapEvent,
  type TappableStreamRecord,
} from '../server/chat-stream-tap.ts'
import type { StreamEnvelope } from '../server/chat-manager.ts'

const deltaEnvelope = (content: string): StreamEnvelope => ({
  event: 'delta',
  data: { content },
})

test('tap registry broadcasts stream events to every listener with stream identity', () => {
  const registry = createChatStreamTapRegistry()
  const received: ChatStreamTapEvent[] = []
  registry.tap((event) => received.push(event))

  registry.broadcast({ streamId: 's-1', cardId: 'card-1', envelope: deltaEnvelope('hello') })

  assert.equal(received.length, 1)
  assert.equal(received[0]?.streamId, 's-1')
  assert.equal(received[0]?.cardId, 'card-1')
  assert.deepEqual(received[0]?.envelope, deltaEnvelope('hello'))
})

test('tap registry stops delivering after unsubscribe', () => {
  const registry = createChatStreamTapRegistry()
  const received: ChatStreamTapEvent[] = []
  const untap = registry.tap((event) => received.push(event))

  untap()
  registry.broadcast({ streamId: 's-1', envelope: deltaEnvelope('after') })

  assert.equal(received.length, 0)
  assert.equal(registry.size, 0)
})

test('a throwing tap listener does not break other listeners', () => {
  const registry = createChatStreamTapRegistry()
  const received: string[] = []
  registry.tap(() => {
    throw new Error('boom')
  })
  registry.tap((event) => received.push(event.streamId))

  registry.broadcast({ streamId: 's-2', envelope: deltaEnvelope('x') })

  assert.deepEqual(received, ['s-2'])
})

test('buildActiveStreamViews exposes only non-terminal streams with copied backlog', () => {
  const backlog = [deltaEnvelope('a'), deltaEnvelope('b')]
  const records: TappableStreamRecord[] = [
    { id: 's-live', cardId: 'card-1', terminal: false, backlog },
    { id: 's-done', cardId: 'card-2', terminal: true, backlog: [deltaEnvelope('z')] },
  ]

  const views = buildActiveStreamViews(records)

  assert.equal(views.length, 1)
  assert.equal(views[0]?.streamId, 's-live')
  assert.equal(views[0]?.cardId, 'card-1')
  assert.deepEqual(views[0]?.backlog, backlog)
  // The view must be a snapshot: later mutations of the live backlog array
  // must not leak into an already-taken view.
  backlog.push(deltaEnvelope('c'))
  assert.equal(views[0]?.backlog.length, 2)
})
