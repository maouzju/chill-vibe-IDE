import assert from 'node:assert/strict'
import test from 'node:test'

import { hitTestRepairEscalationWindowMs } from '../src/components/composer-focus'
import {
  createWindowHitTestRebuildTracker,
  decideWindowHitTestRebuild,
  windowHitTestRebuildCooldownMs,
  windowHitTestRebuildWindowMs,
} from '../src/components/window-hit-test-rebuild'

// 2026-09-08 用户报"极小概率所有输入框无法悬停聚焦，缩小窗口后自愈"。
// 卡级/面板级 transform 重建只重建子树的合成层；当误路由是窗口级的（多张卡
// 同时中招，或面板重建后同一张卡仍然误路由），唯一已知有效的手势是改变窗口
// 几何。这组测试钉住"什么时候该请求主进程抖动窗口"的判定。

test('a single card-level repair never asks for a window rebuild', () => {
  assert.equal(
    decideWindowHitTestRebuild(
      [{ atMs: 1000, cardKey: 'a', scope: 'card' }],
      1000,
      null,
    ),
    'none',
  )
})

test('repairs on two distinct cards inside the window are the window-level signature', () => {
  assert.equal(
    decideWindowHitTestRebuild(
      [
        { atMs: 1000, cardKey: 'a', scope: 'card' },
        { atMs: 4000, cardKey: 'b', scope: 'card' },
      ],
      4000,
      null,
    ),
    'request',
  )
})

test('a panel-level escalation that still misroutes afterwards asks for a window rebuild', () => {
  // card → card-and-panel → card-and-panel: the pane panel was rebuilt and the
  // very next hover still misrouted, so the stale surface sits above the panel.
  assert.equal(
    decideWindowHitTestRebuild(
      [
        { atMs: 1000, cardKey: 'a', scope: 'card' },
        { atMs: 2600, cardKey: 'a', scope: 'card-and-panel' },
        { atMs: 4200, cardKey: 'a', scope: 'card-and-panel' },
      ],
      4200,
      null,
    ),
    'request',
  )
})

test('one panel-level escalation alone is not enough', () => {
  assert.equal(
    decideWindowHitTestRebuild(
      [
        { atMs: 1000, cardKey: 'a', scope: 'card' },
        { atMs: 2600, cardKey: 'a', scope: 'card-and-panel' },
      ],
      2600,
      null,
    ),
    'none',
  )
})

test('entries older than the observation window are ignored', () => {
  assert.equal(
    decideWindowHitTestRebuild(
      [
        { atMs: 1000, cardKey: 'a', scope: 'card' },
        { atMs: 1000 + windowHitTestRebuildWindowMs + 1, cardKey: 'b', scope: 'card' },
      ],
      1000 + windowHitTestRebuildWindowMs + 1,
      null,
    ),
    'none',
  )
})

test('a request inside the cooldown is suppressed, after it is allowed again', () => {
  const entries = [
    { atMs: 100_000, cardKey: 'a', scope: 'card' as const },
    { atMs: 101_000, cardKey: 'b', scope: 'card' as const },
  ]
  assert.equal(decideWindowHitTestRebuild(entries, 101_000, 100_000), 'none')
  assert.equal(
    decideWindowHitTestRebuild(
      entries.map((entry) => ({ ...entry, atMs: entry.atMs + windowHitTestRebuildCooldownMs })),
      101_000 + windowHitTestRebuildCooldownMs,
      100_000,
    ),
    'request',
  )
})

test('the tracker accumulates notes and records the request time itself', () => {
  const tracker = createWindowHitTestRebuildTracker()
  assert.equal(tracker.note({ atMs: 1000, cardKey: 'a', scope: 'card' }), 'none')
  assert.equal(tracker.note({ atMs: 2000, cardKey: 'b', scope: 'card' }), 'request')
  // Immediately after a request the same pattern must not fire again.
  assert.equal(tracker.note({ atMs: 3000, cardKey: 'c', scope: 'card' }), 'none')
  assert.equal(tracker.lastRequestAtMs(), 2000)
})

test('the window is wider than the card escalation window and the cooldown is wider still', () => {
  assert.ok(windowHitTestRebuildWindowMs > hitTestRepairEscalationWindowMs)
  assert.ok(windowHitTestRebuildCooldownMs > windowHitTestRebuildWindowMs)
})
