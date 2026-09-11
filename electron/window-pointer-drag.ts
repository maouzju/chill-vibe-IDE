import type { BrowserWindow, Point, Rectangle } from 'electron'

// 症状：2026-09-11 用户报自定义标题栏上的「Chill Vibe / 接口 / 设置」标签按住拖不动窗口。
// 根因：这些标签必须留在 `app-region: no-drag` —— Windows 无边框窗口里标成 drag 的
// 元素由系统接管（WM_NCHITTEST → HTCAPTION），DOM 收不到 mousedown/click，改成 drag
// 就再也点不了。所以"按住拖动"由渲染层识别手势（src/components/topbar-window-drag.ts），
// 再经 IPC 请这里按光标移动窗口。
// 被否决的替代：主进程发 WM_NCLBUTTONDOWN 借原生拖动（能贴边吸附）—— Electron 没有
// 发送 Windows 消息的公开 API，要 native addon，不值得为一个标题栏手势引入。
// 取舍：手动拖动没有 Aero Snap；顶栏空白处的原生拖拽仍然有。见 docs/specs/topbar-tab-window-drag。

// 渲染进程失联（指针捕获丢失、渲染层卡死）时主进程自动结束会话，绝不能留下一个
// 永远跟着光标跑的窗口。渲染侧每帧续命一次，3s 远大于任何正常的帧间隔。
export const windowPointerDragIdleTimeoutMs = 3_000

export type WindowPointerDragStartInput = {
  visible: boolean
  minimized: boolean
  fullScreen: boolean
}

export type WindowPointerDragStartDecision = 'start' | 'skip'

export const decideWindowPointerDragStart = (
  input: WindowPointerDragStartInput,
): WindowPointerDragStartDecision =>
  !input.visible || input.minimized || input.fullScreen ? 'skip' : 'start'

export type WindowPointerDragSession = {
  offsetX: number
  offsetY: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// 最大化窗口镜像 Windows 原生标题栏：还原后光标在窗口内的横向比例保持不变，
// 纵向保留按下时距顶边的距离（夹在还原后高度内）。不这样做的话，从最大化窗口右侧
// 拖动，还原后窗口会整块跳到光标右边，看起来像是"拖丢了"。
export const resolvePointerDragSession = (input: {
  cursor: Point
  bounds: Rectangle
  maximized: boolean
  restoredBounds?: Rectangle
}): WindowPointerDragSession => {
  const { cursor, bounds } = input

  if (!input.maximized || !input.restoredBounds) {
    return { offsetX: cursor.x - bounds.x, offsetY: cursor.y - bounds.y }
  }

  const restored = input.restoredBounds
  const ratioX = bounds.width > 0 ? clamp((cursor.x - bounds.x) / bounds.width, 0, 1) : 0

  return {
    offsetX: Math.round(ratioX * restored.width),
    offsetY: clamp(cursor.y - bounds.y, 0, restored.height),
  }
}

export const resolvePointerDragPosition = (
  session: WindowPointerDragSession,
  cursor: Point,
): Point => ({
  x: Math.round(cursor.x - session.offsetX),
  y: Math.round(cursor.y - session.offsetY),
})

type DraggableWindow = Pick<
  BrowserWindow,
  | 'isDestroyed'
  | 'isVisible'
  | 'isMinimized'
  | 'isMaximized'
  | 'isFullScreen'
  | 'getBounds'
  | 'setPosition'
  | 'unmaximize'
>

export type WindowPointerDragController = {
  begin: () => boolean
  move: () => boolean
  end: () => void
  isActive: () => boolean
}

type ScheduleFn = (callback: () => void, delayMs: number) => () => void

const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs)
  return () => {
    clearTimeout(handle)
  }
}

export const createWindowPointerDragController = (
  win: DraggableWindow,
  options: {
    getCursor: () => Point
    schedule?: ScheduleFn
  },
): WindowPointerDragController => {
  const schedule = options.schedule ?? defaultSchedule
  let session: WindowPointerDragSession | null = null
  let cancelIdleTimer: (() => void) | null = null

  const end = () => {
    cancelIdleTimer?.()
    cancelIdleTimer = null
    session = null
  }

  const armIdleTimer = () => {
    cancelIdleTimer?.()
    cancelIdleTimer = schedule(end, windowPointerDragIdleTimeoutMs)
  }

  const begin = () => {
    end()

    if (win.isDestroyed()) {
      return false
    }

    const decision = decideWindowPointerDragStart({
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      fullScreen: win.isFullScreen(),
    })
    if (decision === 'skip') {
      return false
    }

    const cursor = options.getCursor()
    const maximized = win.isMaximized()
    const bounds = win.getBounds()
    let restoredBounds: Rectangle | undefined

    if (maximized) {
      win.unmaximize()
      restoredBounds = win.getBounds()
    }

    session = resolvePointerDragSession({ cursor, bounds, maximized, restoredBounds })

    if (maximized) {
      // 还原后立刻放到光标下，不等下一次 move —— 否则窗口会先在还原位置闪一下。
      const position = resolvePointerDragPosition(session, cursor)
      win.setPosition(position.x, position.y)
    }

    armIdleTimer()
    return true
  }

  const move = () => {
    if (!session) {
      return false
    }
    if (win.isDestroyed()) {
      end()
      return false
    }

    const position = resolvePointerDragPosition(session, options.getCursor())
    win.setPosition(position.x, position.y)
    armIdleTimer()
    return true
  }

  return {
    begin,
    move,
    end,
    isActive: () => session !== null,
  }
}
