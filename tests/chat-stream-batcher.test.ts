import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createChatStreamBatcher } from '../electron/chat-stream-batcher.ts'

type Delivery = { key: number; items: unknown[] }

// 手动驱动的调度器：把「16ms 窗口」变成测试里可确定触发的一步，
// 避免真实计时器带来的不稳定。
const createManualScheduler = () => {
  const pending: Array<() => void> = []
  return {
    schedule: (callback: () => void) => {
      pending.push(callback)
    },
    runAll: () => {
      const queued = pending.splice(0, pending.length)
      queued.forEach((callback) => callback())
    },
    get scheduledCount() {
      return pending.length
    },
  }
}

test('chat stream batcher merges a burst into a single delivery and preserves order', () => {
  const scheduler = createManualScheduler()
  const deliveries: Delivery[] = []
  const batcher = createChatStreamBatcher({
    schedule: scheduler.schedule,
    deliver: (key, items) => {
      deliveries.push({ key, items: [...items] })
    },
  })

  for (let index = 0; index < 40; index += 1) {
    batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'delta', data: { content: `chunk-${index}` } })
  }

  assert.equal(scheduler.scheduledCount, 1, '一个窗口内的连续事件只应排一次 flush')
  assert.equal(deliveries.length, 0, 'flush 触发前不应发送')

  scheduler.runAll()

  assert.equal(deliveries.length, 1, '40 条事件应合并成一次跨进程发送')
  assert.equal(deliveries[0].items.length, 40)
  assert.deepEqual(
    (deliveries[0].items as Array<{ data: { content: string } }>).map((item) => item.data.content),
    Array.from({ length: 40 }, (_unused, index) => `chunk-${index}`),
    '合并绝不能打乱流式顺序',
  )
})

test('chat stream batcher keeps separate renderers isolated', () => {
  const scheduler = createManualScheduler()
  const deliveries: Delivery[] = []
  const batcher = createChatStreamBatcher({
    schedule: scheduler.schedule,
    deliver: (key, items) => {
      deliveries.push({ key, items: [...items] })
    },
  })

  batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'delta', data: 'a1' })
  batcher.enqueue(2, { subscriptionId: 'sub-b', event: 'delta', data: 'b1' })
  batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'delta', data: 'a2' })

  scheduler.runAll()

  assert.equal(deliveries.length, 2, '不同 webContents 必须各自成批，不能混投')
  const first = deliveries.find((delivery) => delivery.key === 1)
  const second = deliveries.find((delivery) => delivery.key === 2)
  assert.deepEqual(first?.items.map((item) => (item as { data: string }).data), ['a1', 'a2'])
  assert.deepEqual(second?.items.map((item) => (item as { data: string }).data), ['b1'])
})

test('chat stream batcher starts a fresh window after each flush', () => {
  const scheduler = createManualScheduler()
  const deliveries: Delivery[] = []
  const batcher = createChatStreamBatcher({
    schedule: scheduler.schedule,
    deliver: (key, items) => {
      deliveries.push({ key, items: [...items] })
    },
  })

  batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'delta', data: 'first' })
  scheduler.runAll()
  batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'delta', data: 'second' })

  assert.equal(scheduler.scheduledCount, 1, 'flush 之后的新事件应重新排一次 flush')
  scheduler.runAll()

  assert.deepEqual(
    deliveries.map((delivery) => (delivery.items[0] as { data: string }).data),
    ['first', 'second'],
  )
})

// 症状：整轮结束后卡片可能停在最后几个字未刷新。
// 根因：批处理窗口未清空时渲染进程被销毁/取消订阅，队列里的尾部事件会永远留在内存里。
// 为什么必须有 dropSender：webContents 销毁后再 send 会抛错，且残留队列是内存泄漏。
test('chat stream batcher can drop a destroyed renderer queue without delivering', () => {
  const scheduler = createManualScheduler()
  const deliveries: Delivery[] = []
  const batcher = createChatStreamBatcher({
    schedule: scheduler.schedule,
    deliver: (key, items) => {
      deliveries.push({ key, items: [...items] })
    },
  })

  batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'delta', data: 'gone' })
  batcher.enqueue(2, { subscriptionId: 'sub-b', event: 'delta', data: 'kept' })
  batcher.dropSender(1)

  scheduler.runAll()

  assert.equal(deliveries.length, 1, '已销毁的渲染进程不应再收到投递')
  assert.equal(deliveries[0].key, 2)
})

test('chat stream batcher flushes pending work immediately on demand', () => {
  const scheduler = createManualScheduler()
  const deliveries: Delivery[] = []
  const batcher = createChatStreamBatcher({
    schedule: scheduler.schedule,
    deliver: (key, items) => {
      deliveries.push({ key, items: [...items] })
    },
  })

  batcher.enqueue(1, { subscriptionId: 'sub-a', event: 'result', data: 'terminal' })
  batcher.flushNow()

  assert.equal(deliveries.length, 1, 'flushNow 应立刻投递，不等窗口到期')
  scheduler.runAll()
  assert.equal(deliveries.length, 1, '已经投递过的批次不应被计划中的 flush 重复发送')
})
