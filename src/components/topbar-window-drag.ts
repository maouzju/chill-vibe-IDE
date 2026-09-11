// 症状：2026-09-11 用户报顶栏「Chill Vibe / 接口 / 设置」标签按住拖不动窗口。
// 根因：标签必须是 `app-region: no-drag` —— Windows 无边框窗口里标成 drag 的元素由
// 系统接管，DOM 收不到 click，标成 drag 就再也点不了。所以手势在这里识别：按下记
// 起点，移动超过阈值才算拖动（请主进程按光标移动窗口），松手结束并吞掉紧随其后的
// 那一次 click —— 拖完不能顺带切换标签。见 docs/specs/topbar-tab-window-drag。
// 被否决的替代：只把标签的 padding 做成 drag、文字 no-drag —— 用户按在文字上照样拖不动，
// 截图报的正是这个位置。

export const topbarWindowDragThresholdPx = 4

export type TopbarWindowDragPointerEvent = {
  pointerType: string
  button: number
  pointerId: number
  screenX: number
  screenY: number
}

export type TopbarWindowDragController = {
  /** Returns true when the press is being tracked (caller should capture the pointer). */
  onPointerDown: (event: TopbarWindowDragPointerEvent) => boolean
  onPointerMove: (event: TopbarWindowDragPointerEvent) => void
  onPointerUp: (event: TopbarWindowDragPointerEvent) => void
  onPointerCancel: (event: TopbarWindowDragPointerEvent) => void
  onLostPointerCapture: (event: TopbarWindowDragPointerEvent) => void
  /** True exactly once after a drag gesture: the click that follows must not switch tabs. */
  consumeSuppressedClick: () => boolean
  isDragging: () => boolean
}

type RequestFrame = (callback: () => void) => unknown
type ScheduleKeepAlive = (callback: () => void, intervalMs: number) => () => void

const defaultRequestFrame: RequestFrame = (callback) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : callback()

const defaultScheduleKeepAlive: ScheduleKeepAlive = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs)
  return () => clearInterval(timer)
}

export const createTopbarWindowDragController = (options: {
  begin: () => void
  move: () => void
  end: () => void
  thresholdPx?: number
  requestFrame?: RequestFrame
  scheduleKeepAlive?: ScheduleKeepAlive
}): TopbarWindowDragController => {
  const thresholdPx = options.thresholdPx ?? topbarWindowDragThresholdPx
  const requestFrame = options.requestFrame ?? defaultRequestFrame
  const scheduleKeepAlive = options.scheduleKeepAlive ?? defaultScheduleKeepAlive

  let pressed: { pointerId: number; screenX: number; screenY: number } | null = null
  let dragging = false
  let suppressNextClick = false
  // 一帧最多发一次 move：pointermove 可达数百 Hz，主进程按光标定位不需要更多样本。
  let framePending = false
  let cancelKeepAlive: (() => void) | null = null

  const flushMove = () => {
    framePending = false
    if (dragging) {
      options.move()
    }
  }

  const scheduleMove = () => {
    if (framePending) {
      return
    }
    framePending = true
    requestFrame(flushMove)
  }

  const finish = () => {
    if (!pressed) {
      return
    }
    pressed = null
    cancelKeepAlive?.()
    cancelKeepAlive = null
    if (dragging) {
      dragging = false
      suppressNextClick = true
      options.end()
    }
  }

  const isTrackedPointer = (event: TopbarWindowDragPointerEvent) =>
    pressed !== null && pressed.pointerId === event.pointerId

  return {
    onPointerDown: (event) => {
      if (pressed || event.pointerType !== 'mouse' || event.button !== 0) {
        return false
      }
      // 新的一次按下让任何残留的"吞 click"作废：pointercancel 之后不会再有 click，
      // 不清掉就会吃掉用户下一次真正的点击。
      suppressNextClick = false
      pressed = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY }
      return true
    },
    onPointerMove: (event) => {
      if (!isTrackedPointer(event) || !pressed) {
        return
      }
      if (!dragging) {
        const dx = event.screenX - pressed.screenX
        const dy = event.screenY - pressed.screenY
        if (Math.hypot(dx, dy) <= thresholdPx) {
          return
        }
        dragging = true
        options.begin()
        // 症状：按住暂停超过 3 秒再移动，窗口不再跟随（2026-09-11 红测）。
        // 根因：只有 pointermove 续期会误触主进程失联看门狗；不能删掉失联保护。
        // 保持按住时低频合帧续期，结束即取消。见 topbar-tab-window-drag。
        cancelKeepAlive = scheduleKeepAlive(() => {
          if (dragging) {
            scheduleMove()
          }
        }, 500)
      }
      scheduleMove()
    },
    onPointerUp: (event) => {
      if (isTrackedPointer(event)) {
        finish()
      }
    },
    onPointerCancel: (event) => {
      if (isTrackedPointer(event)) {
        finish()
      }
    },
    onLostPointerCapture: (event) => {
      if (isTrackedPointer(event)) {
        finish()
      }
    },
    consumeSuppressedClick: () => {
      const suppressed = suppressNextClick
      suppressNextClick = false
      return suppressed
    },
    isDragging: () => dragging,
  }
}
