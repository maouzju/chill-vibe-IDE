import type { BrowserWindow, Rectangle } from 'electron'

// 症状：2026-09-08 用户报"所有输入框无法悬停聚焦，缩小窗口后自愈"。
// 根因：窗口级陈旧 hit-test（frameless 拖拽区缓存 / 合成器 surface 陈旧）只
// 被窗口几何变化清掉；帧看门狗的 invalidate() 只重绘不重算几何，对此无效。
// 这里把"用户手动缩小窗口"做成主进程可执行的动作：渲染层判定窗口级误路由
// （src/components/window-hit-test-rebuild.ts）后请主进程把宽度抖 1px 再复原。
// 被否决的替代：unmaximize/maximize 一律走 setBounds——Windows 上对最大化窗口
// setBounds 会让它永久退出最大化，所以最大化态镜像用户自己的手势：还原再最大化。

export const windowHitTestNudgeCooldownMs = 30_000
// Long enough for the compositor to produce at least one frame at the nudged
// size (otherwise browser-side visual-property coalescing can collapse the
// pair into "no change"), short enough that the 1px twitch is imperceptible.
export const windowHitTestNudgeRestoreDelayMs = 48

export type WindowBoundsNudgeInput = {
  nowMs: number
  lastNudgeAtMs: number | null
  visible: boolean
  minimized: boolean
  maximized: boolean
  fullScreen: boolean
}

export type WindowBoundsNudgeAction = 'skip' | 'nudge-bounds' | 'toggle-maximize'

export const decideWindowBoundsNudge = (input: WindowBoundsNudgeInput): WindowBoundsNudgeAction => {
  if (!input.visible || input.minimized || input.fullScreen) {
    return 'skip'
  }
  if (input.lastNudgeAtMs !== null && input.nowMs - input.lastNudgeAtMs < windowHitTestNudgeCooldownMs) {
    return 'skip'
  }
  return input.maximized ? 'toggle-maximize' : 'nudge-bounds'
}

export const nudgedBoundsForHitTestRebuild = (bounds: Rectangle): Rectangle => ({
  ...bounds,
  width: bounds.width + 1,
})

type NudgeableWindow = Pick<
  BrowserWindow,
  | 'isDestroyed'
  | 'isVisible'
  | 'isMinimized'
  | 'isMaximized'
  | 'isFullScreen'
  | 'getBounds'
  | 'setBounds'
  | 'unmaximize'
  | 'maximize'
>

const lastNudgeAtByWindow = new WeakMap<object, number>()

// Returns the action taken so the IPC handler can log it in main.log — that
// line is the only attribution a hover-only misroute leaves behind.
export const nudgeWindowForHitTestRebuild = (
  win: NudgeableWindow,
  nowMs = Date.now(),
  schedule: (callback: () => void, delayMs: number) => void = (callback, delayMs) => {
    setTimeout(callback, delayMs)
  },
): WindowBoundsNudgeAction => {
  if (win.isDestroyed()) {
    return 'skip'
  }
  const action = decideWindowBoundsNudge({
    nowMs,
    lastNudgeAtMs: lastNudgeAtByWindow.get(win) ?? null,
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  })
  if (action === 'skip') {
    return action
  }
  lastNudgeAtByWindow.set(win, nowMs)

  if (action === 'toggle-maximize') {
    win.unmaximize()
    schedule(() => {
      if (!win.isDestroyed()) {
        win.maximize()
      }
    }, windowHitTestNudgeRestoreDelayMs)
    return action
  }

  const bounds = win.getBounds()
  win.setBounds(nudgedBoundsForHitTestRebuild(bounds))
  schedule(() => {
    if (!win.isDestroyed()) {
      win.setBounds(bounds)
    }
  }, windowHitTestNudgeRestoreDelayMs)
  return action
}
