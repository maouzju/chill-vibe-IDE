import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema'
import {
  getFallbackRetryDelayMs,
  isDuplicateTrailingErrorMessage,
  stripConsecutiveDuplicateErrorMessages,
} from '../src/fallback-retry'
import { ideReducer } from '../src/state'
import { createDefaultState } from '../shared/default-state'

const minute = 60_000

let seq = 0
const msg = (role: ChatMessage['role'], content: string, meta?: Record<string, string>): ChatMessage => ({
  id: `m${++seq}`,
  role,
  content,
  createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  ...(meta ? { meta } : {}),
})
const duration = () => msg('system', '', { kind: 'run-duration', durationMs: '1000' })

test('fallback retry starts at 5 minutes, grows by 5 per failed retry, caps at 30', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 20].map((n) => getFallbackRetryDelayMs(n) / minute),
    [5, 10, 15, 20, 25, 30, 30, 30],
  )
  assert.equal(getFallbackRetryDelayMs(0), 5 * minute)
})

test('a repeated error separated only by run-duration/empty bubbles counts as a duplicate', () => {
  const messages = [msg('user', 'do it'), msg('system', 'API Error: 503'), duration(), msg('assistant', '')]
  assert.equal(isDuplicateTrailingErrorMessage(messages, msg('system', 'API Error: 503 ')), true)
  assert.equal(isDuplicateTrailingErrorMessage(messages, msg('system', 'API Error: 500')), false)
  // Real progress in between means the second error is new information.
  assert.equal(
    isDuplicateTrailingErrorMessage([...messages, msg('assistant', 'partial work')], msg('system', 'API Error: 503')),
    false,
  )
})

test('stripping keeps the first error of each consecutive run and leaves everything else', () => {
  const user = msg('user', 'go')
  const e1 = msg('system', 'boom')
  const d1 = duration()
  const e2 = msg('system', 'boom')
  const d2 = duration()
  const e3 = msg('system', 'boom')
  const reply = msg('assistant', 'done')
  const e4 = msg('system', 'boom')
  const stripped = stripConsecutiveDuplicateErrorMessages([user, e1, d1, e2, d2, e3, reply, e4])
  assert.deepEqual(stripped.map((m) => m.id), [user.id, e1.id, d1.id, d2.id, reply.id, e4.id])
  const clean = [user, e1, reply]
  assert.equal(stripConsecutiveDuplicateErrorMessages(clean), clean)
})

test('appendMessages drops a consecutive duplicate error instead of stacking it', () => {
  const state = createDefaultState('workspace')
  const column = state.columns[0]!
  const cardId = Object.keys(column.cards)[0]!
  const append = (s: typeof state, m: ChatMessage) =>
    ideReducer(s, { type: 'appendMessages', columnId: column.id, cardId, messages: [m] })
  let next = append(state, msg('user', 'go'))
  next = append(next, msg('system', 'API Error: 503'))
  next = append(next, duration())
  next = append(next, msg('system', 'API Error: 503'))
  const contents = next.columns[0]!.cards[cardId]!.messages.map((m) => m.content)
  assert.equal(contents.filter((c) => c === 'API Error: 503').length, 1)
})

test('stripDuplicateErrorMessages action cleans legacy duplicates once the session recovers', () => {
  const state = createDefaultState('workspace')
  const column = state.columns[0]!
  const cardId = Object.keys(column.cards)[0]!
  const card = column.cards[cardId]!
  const seeded = {
    ...state,
    columns: [{ ...column, cards: { ...column.cards, [cardId]: { ...card, messages: [msg('user', 'go'), msg('system', 'x'), duration(), msg('system', 'x')] } } }],
  }
  const next = ideReducer(seeded, { type: 'stripDuplicateErrorMessages', columnId: column.id, cardId })
  assert.equal(next.columns[0]!.cards[cardId]!.messages.filter((m) => m.content === 'x').length, 1)
})

test('real-world shapes: assistant "API Error" bubbles and differing request ids still count as the same error', () => {
  // 2026-10-16 state.json 实测：CLI 把报错写成 assistant 气泡，IDE 又追一条同文 system；
  // 中转站每次失败的 request id 都不同，但对用户是同一句报错。
  const user = msg('user', 'go')
  const a1 = msg('assistant', 'API Error: 503 No accounts are currently available. (request id: 20261016154921071-73a29cf6) (request id: abc)')
  const d1 = duration()
  const a2 = msg('assistant', 'API Error: 503 No accounts are currently available. (request id: 20261016155302453-6620ec70) (request id: def)')
  const a3 = msg('assistant', 'API Error: Connection dropped (ECONNRESET)')
  const s3 = msg('system', 'API Error: Connection dropped (ECONNRESET)')
  const other = msg('assistant', 'API Error: 429 rejected')
  const reply = msg('assistant', 'done')
  const stripped = stripConsecutiveDuplicateErrorMessages([user, a1, d1, a2, a3, s3, other, reply])
  assert.deepEqual(stripped.map((m) => m.id), [user.id, a1.id, d1.id, a3.id, other.id, reply.id])
  // A normal assistant reply that merely mentions an error is never treated as an error bubble.
  const prose = [user, msg('assistant', 'The log says API Error: x'), msg('assistant', 'The log says API Error: x')]
  assert.equal(stripConsecutiveDuplicateErrorMessages(prose), prose)
})