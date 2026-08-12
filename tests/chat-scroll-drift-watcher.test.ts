import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createScrollDriftWatcher,
  scrollDriftEpsilonPx,
  scrollDriftSampleIntervalFrames,
  scrollDriftWatchWindowFrames,
} from '../src/components/chat-scroll-drift-watcher.ts'

// 症状：CPU 吃紧且有长会话在流式输出时切 tab，主线程一次阻塞 1374ms
//   （同操作无流式 659ms）。CDP profile 里 ChatCard.tsx:1180 那段 self time 617ms。
// 根因：2026-08-11 实测 —— 那个 useLayoutEffect 的依赖含 renderableEntryStructureKey
//   （= 所有条目 id 拼接），流式每冒出一条新气泡就变一次，于是 18 帧的 rAF 轮询被
//   反复取消重建、从不结束；而每帧都读一次 scrollTop，DOM 正被流式弄脏，每次读都
//   强制重排 271 个气泡的列表（实测约 29ms/帧 × 约 21 帧 ≈ 610ms，与 profile 吻合）。
// 为什么不能换写法：漂移检测不能删 —— 内容高度变化时浏览器的 scroll anchoring 会
//   自己挪 scrollTop 且**不派发 scroll 事件**，只能靠轮询发现。但位置漂移了就一直是
//   漂移的，晚几帧发现无感，所以降采样安全；重启改续期则避免流式把窗口无限拉长。

type Harness = ReturnType<typeof createHarness>

const createHarness = ({
  scrollTops,
  sampleIntervalFrames,
  watchWindowFrames,
}: {
  scrollTops: number[]
  sampleIntervalFrames?: number
  watchWindowFrames?: number
}) => {
  const reads: number[] = []
  const drifts: number[] = []
  let pending: (() => void) | null = null
  let nextHandle = 1
  let cancelled = 0
  let frame = 0

  const watcher = createScrollDriftWatcher({
    readScrollTop: () => {
      const value = scrollTops[Math.min(reads.length, scrollTops.length - 1)] ?? null
      reads.push(frame)
      return value
    },
    onDrift: (scrollTop) => {
      drifts.push(scrollTop)
    },
    requestFrame: (callback) => {
      pending = callback
      return nextHandle++
    },
    cancelFrame: () => {
      cancelled += 1
      pending = null
    },
    sampleIntervalFrames,
    watchWindowFrames,
  })

  const runFrames = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      const callback = pending
      if (!callback) {
        return
      }
      pending = null
      frame += 1
      callback()
    }
  }

  return {
    watcher,
    runFrames,
    reads,
    drifts,
    get cancelled() {
      return cancelled
    },
    get hasPendingFrame() {
      return pending !== null
    },
  }
}

const constantScroll = (value: number) => Array.from({ length: 200 }, () => value)

test('默认不再每帧都读 scrollTop', () => {
  assert.ok(
    scrollDriftSampleIntervalFrames > 1,
    '采样间隔必须大于 1 帧，否则等于原来的每帧强制重排',
  )
})

test('一个完整观察窗口内的读取次数按采样间隔收敛', () => {
  const harness: Harness = createHarness({ scrollTops: constantScroll(100) })

  harness.watcher.start(100)
  harness.runFrames(scrollDriftWatchWindowFrames + 5)

  const expected = Math.floor(scrollDriftWatchWindowFrames / scrollDriftSampleIntervalFrames)
  assert.equal(
    harness.reads.length,
    expected,
    `窗口内应只读 ${expected} 次，实测 ${harness.reads.length} 次`,
  )
})

test('结构反复变化时是续期而不是重启，绝不叠出第二个循环', () => {
  const harness: Harness = createHarness({ scrollTops: constantScroll(100) })

  harness.watcher.start(100)
  // 模拟流式：连续 40 次结构变化，每次都想重新观察。
  for (let index = 0; index < 40; index += 1) {
    harness.watcher.extend()
    harness.runFrames(1)
  }

  assert.equal(harness.cancelled, 0, '续期不应取消已在跑的循环')
  // 40 帧、每 sampleIntervalFrames 帧读一次。
  const upperBound = Math.ceil(40 / scrollDriftSampleIntervalFrames) + 1
  assert.ok(
    harness.reads.length <= upperBound,
    `40 帧内最多读 ${upperBound} 次，实测 ${harness.reads.length} 次（说明叠了多个循环）`,
  )
})

test('续期会把观察窗口往后延，不会提前收工', () => {
  const harness: Harness = createHarness({ scrollTops: constantScroll(100) })

  harness.watcher.start(100)
  harness.runFrames(scrollDriftWatchWindowFrames - 1)
  assert.ok(harness.hasPendingFrame, '窗口未耗尽时循环应还在')

  harness.watcher.extend()
  harness.runFrames(scrollDriftWatchWindowFrames - 1)
  assert.ok(harness.hasPendingFrame, '续期后应继续观察')

  harness.runFrames(scrollDriftWatchWindowFrames + 2)
  assert.ok(!harness.hasPendingFrame, '窗口耗尽后必须停下，不能永远轮询')
})

test('漂移超过阈值才回调，并把基线推进到新位置', () => {
  const drifted = [100, 100, 100, 140, 140, 140, 140, 140]
  const harness: Harness = createHarness({ scrollTops: drifted })

  harness.watcher.start(100)
  harness.runFrames(scrollDriftWatchWindowFrames)

  assert.deepEqual(harness.drifts, [140], '应恰好报告一次漂移，且不重复报同一个位置')
})

test('抖动小于阈值不算漂移', () => {
  const jitter = constantScroll(100).map((value, index) =>
    index % 2 === 0 ? value : value + scrollDriftEpsilonPx / 2,
  )
  const harness: Harness = createHarness({ scrollTops: jitter })

  harness.watcher.start(100)
  harness.runFrames(scrollDriftWatchWindowFrames)

  assert.deepEqual(harness.drifts, [])
})

test('节点消失时立刻停手，不再安排下一帧', () => {
  const harness = createHarness({ scrollTops: [] })
  // 用 ref 对象而不是裸 `let`：赋值只发生在下面的回调里，TS 的控制流分析看不见
  // 闭包写入，会把读出来的值一路收窄到 `never`（`callback()` 报 TS2349）。
  const pendingFrame: { current: (() => void) | null } = { current: null }
  // readScrollTop 返回 null 表示节点没了。
  const watcher = createScrollDriftWatcher({
    readScrollTop: () => null,
    onDrift: () => {
      assert.fail('节点没了不该报漂移')
    },
    requestFrame: (callback) => {
      pendingFrame.current = callback
      return 1
    },
    cancelFrame: () => {
      pendingFrame.current = null
    },
  })

  watcher.start(100)
  for (let index = 0; index < scrollDriftSampleIntervalFrames + 1; index += 1) {
    const callback = pendingFrame.current
    if (!callback) break
    pendingFrame.current = null
    callback()
  }

  assert.equal(pendingFrame.current, null, '节点消失后不应再排下一帧')
  assert.equal(harness.reads.length, 0)
})

test('cancel 之后不再读也不再排帧', () => {
  const harness: Harness = createHarness({ scrollTops: constantScroll(100) })

  harness.watcher.start(100)
  harness.runFrames(scrollDriftSampleIntervalFrames)
  const readsBefore = harness.reads.length

  harness.watcher.cancel()
  harness.runFrames(10)

  assert.equal(harness.reads.length, readsBefore)
  assert.ok(!harness.hasPendingFrame)
})

test('cancel 之后 extend 能重新起一个循环', () => {
  const harness: Harness = createHarness({ scrollTops: constantScroll(100) })

  harness.watcher.start(100)
  harness.watcher.cancel()
  assert.ok(!harness.hasPendingFrame)

  harness.watcher.extend()
  assert.ok(harness.hasPendingFrame, 'cancel 后应能靠 extend 重新启动')
})
