import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTopbarWindowDragController,
  topbarWindowDragThresholdPx,
} from '../src/components/topbar-window-drag.ts'

// 2026-09-11：顶栏标签既要能点（切换面板）又要能按住拖动窗口。手势状态机在
// 渲染层：按下记起点，超过阈值才 begin，松手 end 并吞掉紧随其后的 click。

type Harness = ReturnType<typeof createHarness>

const createHarness = (
  overrides: Partial<Parameters<typeof createTopbarWindowDragController>[0]> = {},
) => {
  const calls: string[] = []
  const controller = createTopbarWindowDragController({
    begin: () => {
      calls.push('begin')
      return true
    },
    move: () => {
      calls.push('move')
    },
    end: () => {
      calls.push('end')
    },
    requestFrame: (callback) => {
      callback()
      return 0
    },
    scheduleKeepAlive: () => () => undefined,
    ...overrides,
  })

  return { calls, controller }
}

const mouse = (
  overrides: Partial<{
    pointerType: string
    button: number
    pointerId: number
    screenX: number
    screenY: number
  }> = {},
) => ({
  pointerType: 'mouse',
  button: 0,
  pointerId: 1,
  screenX: 100,
  screenY: 100,
  ...overrides,
})

const dragPast = ({ controller }: Harness, screenX: number) => {
  controller.onPointerDown(mouse())
  controller.onPointerMove(mouse({ screenX }))
}

test('press and release inside the threshold stays a plain click', () => {
  const harness = createHarness()
  const { calls, controller } = harness

  assert.equal(controller.onPointerDown(mouse()), true)
  controller.onPointerMove(mouse({ screenX: 102, screenY: 101 }))
  controller.onPointerUp(mouse({ screenX: 102, screenY: 101 }))

  assert.deepEqual(calls, [])
  assert.equal(controller.consumeSuppressedClick(), false)
})

test('moving past the threshold begins one drag, forwards moves, ends on release and eats the click', () => {
  const harness = createHarness()
  const { calls, controller } = harness

  dragPast(harness, 100 + topbarWindowDragThresholdPx + 1)
  assert.equal(controller.isDragging(), true)
  controller.onPointerMove(mouse({ screenX: 130 }))
  controller.onPointerMove(mouse({ screenX: 160 }))
  controller.onPointerUp(mouse({ screenX: 160 }))

  assert.deepEqual(calls, ['begin', 'move', 'move', 'move', 'end'])
  assert.equal(controller.isDragging(), false)
  assert.equal(controller.consumeSuppressedClick(), true)
  // 只吞一次：下一次真正的点击必须照常切换标签。
  assert.equal(controller.consumeSuppressedClick(), false)
})

test('the threshold is measured as a distance, not per axis', () => {
  const harness = createHarness()
  const { calls, controller } = harness

  controller.onPointerDown(mouse())
  controller.onPointerMove(mouse({ screenX: 103, screenY: 103 }))
  assert.deepEqual(calls, ['begin', 'move'])
})

test('secondary buttons, touch and pen never start a drag', () => {
  const harness = createHarness()
  const { calls, controller } = harness

  assert.equal(controller.onPointerDown(mouse({ button: 2 })), false)
  controller.onPointerMove(mouse({ button: 2, screenX: 400 }))
  controller.onPointerUp(mouse({ button: 2, screenX: 400 }))

  assert.equal(controller.onPointerDown(mouse({ pointerType: 'touch' })), false)
  controller.onPointerMove(mouse({ pointerType: 'touch', screenX: 400 }))
  controller.onPointerUp(mouse({ pointerType: 'touch', screenX: 400 }))

  assert.equal(controller.onPointerDown(mouse({ pointerType: 'pen' })), false)

  assert.deepEqual(calls, [])
  assert.equal(controller.consumeSuppressedClick(), false)
})

test('moves and releases without a preceding press are ignored', () => {
  const harness = createHarness()
  const { calls, controller } = harness

  controller.onPointerMove(mouse({ screenX: 400 }))
  controller.onPointerUp(mouse({ screenX: 400 }))

  assert.deepEqual(calls, [])
})

test('pointer cancel and lost capture end an active drag', () => {
  const cancelled = createHarness()
  dragPast(cancelled, 200)
  cancelled.controller.onPointerCancel(mouse({ screenX: 200 }))
  assert.deepEqual(cancelled.calls, ['begin', 'move', 'end'])
  assert.equal(cancelled.controller.consumeSuppressedClick(), true)

  const lost = createHarness()
  dragPast(lost, 200)
  lost.controller.onLostPointerCapture(mouse({ screenX: 200 }))
  assert.deepEqual(lost.calls, ['begin', 'move', 'end'])
  assert.equal(lost.controller.isDragging(), false)
})

test('a second pointer is ignored while the first one is pressed', () => {
  const harness = createHarness()
  const { calls, controller } = harness

  controller.onPointerDown(mouse({ pointerId: 1 }))
  assert.equal(controller.onPointerDown(mouse({ pointerId: 2 })), false)
  controller.onPointerMove(mouse({ pointerId: 2, screenX: 400 }))
  controller.onPointerUp(mouse({ pointerId: 2, screenX: 400 }))
  assert.deepEqual(calls, [])

  controller.onPointerMove(mouse({ pointerId: 1, screenX: 400 }))
  assert.deepEqual(calls, ['begin', 'move'])
})

test('moves are coalesced to one per frame and never flushed after the drag ended', () => {
  const pending: Array<() => void> = []
  const harness = createHarness({
    requestFrame: (callback) => {
      pending.push(callback)
      return pending.length
    },
  })
  const { calls, controller } = harness

  dragPast(harness, 200)
  controller.onPointerMove(mouse({ screenX: 210 }))
  controller.onPointerMove(mouse({ screenX: 220 }))
  assert.deepEqual(calls, ['begin'])
  assert.equal(pending.length, 1)

  pending.shift()?.()
  assert.deepEqual(calls, ['begin', 'move'])

  controller.onPointerMove(mouse({ screenX: 230 }))
  assert.equal(pending.length, 1)
  controller.onPointerUp(mouse({ screenX: 230 }))
  assert.deepEqual(calls, ['begin', 'move', 'end'])

  // 松手后才轮到的那一帧不能再补发 move：主进程会话已结束，补发只是噪音；
  // 更糟的是若用户随即又按下，这帧会把新会话的窗口猛拉到旧坐标。
  pending.shift()?.()
  assert.deepEqual(calls, ['begin', 'move', 'end'])
})

test('a fresh press clears a stale suppressed click left behind by a cancelled drag', () => {
  const harness = createHarness()
  const { controller } = harness

  dragPast(harness, 200)
  controller.onPointerCancel(mouse({ screenX: 200 }))
  // pointercancel 之后浏览器不会再派发 click，这个标记没人消费。
  controller.onPointerDown(mouse())
  controller.onPointerUp(mouse())
  assert.equal(controller.consumeSuppressedClick(), false)
})

test('a held stationary drag keeps the main watchdog alive and stops renewal on every finish path', () => {
  for (const finish of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture'] as const) {
    const renewals: Array<{ callback: () => void; intervalMs: number; cancelled: boolean }> = []
    const { calls, controller } = createHarness({
      scheduleKeepAlive: (callback, intervalMs) => {
        const renewal = { callback, intervalMs, cancelled: false }
        renewals.push(renewal)
        return () => { renewal.cancelled = true }
      },
    })

    controller.onPointerDown(mouse())
    assert.equal(renewals.length, 0, 'plain presses must not renew or start a window drag')
    controller.onPointerMove(mouse({ screenX: 200 }))
    assert.equal(renewals.length, 1, 'a held drag needs renewal even without pointermove events')
    const renewal = renewals[0]!
    assert.equal(renewal.intervalMs, 500)

    // 连续停住 4 秒：每次续期都要发 move，不能等真实鼠标移动才刷新主进程看门狗。
    for (let elapsed = 500; elapsed <= 4_000; elapsed += 500) {
      renewal.callback()
    }
    assert.equal(calls.filter((call) => call === 'move').length, 9)

    controller[finish](mouse())
    assert.equal(renewal.cancelled, true)
    const afterFinish = [...calls]
    renewal.callback()
    assert.deepEqual(calls, afterFinish, 'a queued renewal after release must not move the window')
  }
})
