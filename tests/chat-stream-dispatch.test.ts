import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatchChatStreamEvent } from '../src/api.ts'

test('user_message and unknown stream events must not fall through to the error handler', () => {
  // 桌面桥的事件分发原本把一切未匹配事件当 error 兜底；新增的 user_message
  // 事件（供手机监工镜像用户需求）到达电脑端时必须被安静忽略，不能把
  // 正常对话渲染成"出错"。
  const errors: unknown[] = []
  dispatchChatStreamEvent('user_message', { content: '谢谢' }, {
    onError: (payload) => errors.push(payload),
  })
  dispatchChatStreamEvent('some_future_event', {}, {
    onError: (payload) => errors.push(payload),
  })
  assert.equal(errors.length, 0)
})

test('real error events still reach the error handler with a recoverable default', () => {
  const received: Array<{ message?: string; recoverable?: boolean }> = []
  dispatchChatStreamEvent('error', { message: 'boom' }, {
    onError: (payload) => {
      received.push(payload)
    },
  })
  assert.equal(received.length, 1)
  assert.equal(received[0]?.message, 'boom')
  assert.equal(received[0]?.recoverable, false)
})

test('known events dispatch to their matching handlers', () => {
  const seen: string[] = []
  const donePayloads: unknown[] = []
  dispatchChatStreamEvent('delta', { content: 'hi' }, {
    onDelta: () => seen.push('delta'),
  })
  dispatchChatStreamEvent('done', { completion: 'background-pending' }, {
    onDone: (payload) => {
      seen.push('done')
      donePayloads.push(payload)
    },
  })
  assert.deepEqual(seen, ['delta', 'done'])
  assert.deepEqual(donePayloads, [{ completion: 'background-pending' }])
})

test('context usage events reach their own handler and never the error handler', () => {
  // 上下文占用事件（docs/specs/context-usage-auto-compact）一回合会来很多次，
  // 漏接只是指示器不动，但落进 error 兜底就会把正常回合渲染成"出错"。
  const usage: unknown[] = []
  const errors: unknown[] = []
  dispatchChatStreamEvent('context_usage', { used: 44289, size: 200000 }, {
    onContextUsage: (payload) => usage.push(payload),
    onError: (payload) => errors.push(payload),
  })
  dispatchChatStreamEvent('context_usage', { reset: true }, {
    onError: (payload) => errors.push(payload),
  })
  assert.deepEqual(usage, [{ used: 44289, size: 200000 }])
  assert.equal(errors.length, 0)
})
