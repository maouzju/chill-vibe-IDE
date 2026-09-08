import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideWindowBoundsNudge,
  nudgedBoundsForHitTestRebuild,
  windowHitTestNudgeCooldownMs,
  windowHitTestNudgeRestoreDelayMs,
} from '../electron/window-hit-test-rebuild'

// 2026-09-08：渲染层判定窗口级误路由后请主进程"替用户缩小一下窗口"。主进程
// 侧只做一件事——安全地改一次窗口几何再复原。这组测试钉住不该动窗口的场景
// （不可见/最小化/全屏/冷却期内）和两种可动的手势。

const base = {
  nowMs: 100_000,
  lastNudgeAtMs: null,
  visible: true,
  minimized: false,
  maximized: false,
  fullScreen: false,
}

test('a visible normal window gets a bounds nudge', () => {
  assert.equal(decideWindowBoundsNudge(base), 'nudge-bounds')
})

test('a maximized window is restored and re-maximized instead of resized', () => {
  // setBounds on a maximized window un-maximizes it for good; the user's own
  // recovery gesture is exactly restore → maximize, so mirror it.
  assert.equal(decideWindowBoundsNudge({ ...base, maximized: true }), 'toggle-maximize')
})

test('hidden, minimized and full-screen windows are left alone', () => {
  assert.equal(decideWindowBoundsNudge({ ...base, visible: false }), 'skip')
  assert.equal(decideWindowBoundsNudge({ ...base, minimized: true }), 'skip')
  assert.equal(decideWindowBoundsNudge({ ...base, fullScreen: true }), 'skip')
})

test('a nudge inside the cooldown is skipped, after it is allowed again', () => {
  assert.equal(
    decideWindowBoundsNudge({ ...base, lastNudgeAtMs: base.nowMs - windowHitTestNudgeCooldownMs + 1 }),
    'skip',
  )
  assert.equal(
    decideWindowBoundsNudge({ ...base, lastNudgeAtMs: base.nowMs - windowHitTestNudgeCooldownMs }),
    'nudge-bounds',
  )
})

test('the nudged bounds differ by exactly one pixel of width and keep the origin', () => {
  const bounds = { x: 10, y: 20, width: 1400, height: 900 }
  assert.deepEqual(nudgedBoundsForHitTestRebuild(bounds), { x: 10, y: 20, width: 1401, height: 900 })
})

test('the restore delay leaves the compositor at least one frame at the nudged size', () => {
  assert.ok(windowHitTestNudgeRestoreDelayMs >= 16)
  assert.ok(windowHitTestNudgeRestoreDelayMs < 200)
})
