import assert from 'node:assert/strict'
import test from 'node:test'
import type { Rectangle } from 'electron'

import {
  createWindowPointerDragController,
  decideWindowPointerDragStart,
  resolvePointerDragPosition,
  resolvePointerDragSession,
  windowPointerDragIdleTimeoutMs,
} from '../electron/window-pointer-drag.ts'

// 2026-09-11：顶栏标签必须留在 no-drag（Windows 上 drag 元素收不到 click），
// "按住标签拖动窗口"改由渲染层识别手势、主进程按光标移动窗口。这组测试钉住
// 几何映射（含最大化还原时的比例映射）与 begin/move/end 生命周期。

test('a visible normal window may start a pointer drag', () => {
  assert.equal(
    decideWindowPointerDragStart({ visible: true, minimized: false, fullScreen: false }),
    'start',
  )
})

test('hidden, minimized and full-screen windows refuse a pointer drag', () => {
  assert.equal(
    decideWindowPointerDragStart({ visible: false, minimized: false, fullScreen: false }),
    'skip',
  )
  assert.equal(
    decideWindowPointerDragStart({ visible: true, minimized: true, fullScreen: false }),
    'skip',
  )
  assert.equal(
    decideWindowPointerDragStart({ visible: true, minimized: false, fullScreen: true }),
    'skip',
  )
})

test('a normal window keeps the pressed point under the cursor', () => {
  const session = resolvePointerDragSession({
    cursor: { x: 250, y: 120 },
    bounds: { x: 200, y: 100, width: 1200, height: 800 },
    maximized: false,
  })

  assert.deepEqual(session, { offsetX: 50, offsetY: 20 })
  assert.deepEqual(resolvePointerDragPosition(session, { x: 600, y: 400 }), { x: 550, y: 380 })
})

test('a maximized window maps the cursor proportionally across the restored width', () => {
  // Windows 原生标题栏：最大化时在 75% 处按下拖动，还原后光标仍落在窗口宽度的 75%。
  const session = resolvePointerDragSession({
    cursor: { x: 1440, y: 12 },
    bounds: { x: 0, y: 0, width: 1920, height: 1040 },
    maximized: true,
    restoredBounds: { x: 300, y: 200, width: 1000, height: 700 },
  })

  assert.deepEqual(session, { offsetX: 750, offsetY: 12 })
})

test('a maximized session clamps the vertical offset into the restored height', () => {
  const session = resolvePointerDragSession({
    cursor: { x: 10, y: 900 },
    bounds: { x: 0, y: 0, width: 1920, height: 1040 },
    maximized: true,
    restoredBounds: { x: 0, y: 0, width: 800, height: 600 },
  })

  assert.equal(session.offsetY, 600)
})

test('positions are rounded to whole device-independent pixels', () => {
  assert.deepEqual(
    resolvePointerDragPosition({ offsetX: 10, offsetY: 10 }, { x: 100.6, y: 50.4 }),
    { x: 91, y: 40 },
  )
})

type FakeWindowState = {
  visible: boolean
  minimized: boolean
  maximized: boolean
  fullScreen: boolean
  destroyed: boolean
  bounds: Rectangle
  restoredBounds?: Rectangle
}

const createFakeWindow = (overrides: Partial<FakeWindowState> = {}) => {
  const state: FakeWindowState = {
    visible: true,
    minimized: false,
    maximized: false,
    fullScreen: false,
    destroyed: false,
    bounds: { x: 200, y: 100, width: 1200, height: 800 },
    ...overrides,
  }
  const positions: Array<[number, number]> = []
  let unmaximizeCalls = 0

  return {
    positions,
    get unmaximizeCalls() {
      return unmaximizeCalls
    },
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    getBounds: () => ({ ...state.bounds }),
    setPosition: (x: number, y: number) => {
      positions.push([x, y])
      state.bounds = { ...state.bounds, x, y }
    },
    unmaximize: () => {
      unmaximizeCalls += 1
      state.maximized = false
      if (state.restoredBounds) {
        state.bounds = { ...state.restoredBounds }
      }
    },
  }
}

const neverSchedule = () => () => undefined

test('controller begin → move → end moves the window under the cursor and then stops', () => {
  const win = createFakeWindow()
  let cursor = { x: 250, y: 120 }
  const controller = createWindowPointerDragController(win, {
    getCursor: () => cursor,
    schedule: neverSchedule,
  })

  assert.equal(controller.begin(), true)
  assert.equal(controller.isActive(), true)

  cursor = { x: 300, y: 150 }
  assert.equal(controller.move(), true)
  assert.deepEqual(win.positions.at(-1), [250, 130])

  controller.end()
  assert.equal(controller.isActive(), false)

  cursor = { x: 900, y: 900 }
  assert.equal(controller.move(), false)
  assert.equal(win.positions.length, 1)
})

test('controller restores a maximized window first and drops it under the cursor', () => {
  const win = createFakeWindow({
    maximized: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1040 },
    restoredBounds: { x: 300, y: 200, width: 1000, height: 700 },
  })
  let cursor = { x: 1440, y: 12 }
  const controller = createWindowPointerDragController(win, {
    getCursor: () => cursor,
    schedule: neverSchedule,
  })

  assert.equal(controller.begin(), true)
  assert.equal(win.unmaximizeCalls, 1)
  // 还原后立刻把窗口放到光标下，不等下一次 move —— 否则窗口会先在还原位置闪一下。
  assert.deepEqual(win.positions.at(-1), [690, 0])

  cursor = { x: 1500, y: 40 }
  controller.move()
  assert.deepEqual(win.positions.at(-1), [750, 28])
})

test('controller refuses minimized or destroyed windows and ignores stray moves', () => {
  const minimized = createFakeWindow({ minimized: true })
  const minimizedController = createWindowPointerDragController(minimized, {
    getCursor: () => ({ x: 0, y: 0 }),
    schedule: neverSchedule,
  })
  assert.equal(minimizedController.begin(), false)
  assert.equal(minimizedController.move(), false)
  assert.equal(minimized.positions.length, 0)

  const destroyed = createFakeWindow({ destroyed: true })
  const destroyedController = createWindowPointerDragController(destroyed, {
    getCursor: () => ({ x: 0, y: 0 }),
    schedule: neverSchedule,
  })
  assert.equal(destroyedController.begin(), false)
  assert.doesNotThrow(() => destroyedController.end())
})

test('controller ends itself when the renderer stops sending moves', () => {
  const win = createFakeWindow()
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
  const controller = createWindowPointerDragController(win, {
    getCursor: () => ({ x: 210, y: 110 }),
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs, cancelled: false }
      timers.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  })

  controller.begin()
  assert.equal(timers.length, 1)
  assert.equal(timers[0]?.delayMs, windowPointerDragIdleTimeoutMs)

  controller.move()
  // 每次 move 都续命：上一只表被取消，换一只新表。
  assert.equal(timers[0]?.cancelled, true)
  assert.equal(timers.length, 2)

  timers[1]?.callback()
  assert.equal(controller.isActive(), false)
  assert.equal(controller.move(), false)

  // end 之后不能再有表挂着，否则超时回调会在下一次拖动中途把它掐断。
  controller.begin()
  controller.end()
  assert.equal(timers.at(-1)?.cancelled, true)
})
