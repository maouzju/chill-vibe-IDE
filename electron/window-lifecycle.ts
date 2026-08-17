type PresentableWindow = {
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
  moveTop?: () => void
}

type AttentionWindow = PresentableWindow & {
  isFocused?: () => boolean
  flashFrame?: (flag: boolean) => void
}

const attentionTimers = new WeakMap<AttentionWindow, ReturnType<typeof setTimeout>>()

export type WindowCloseAction =
  | 'allow-close'
  | 'minimize'
  | 'hide-to-tray'
  | 'quit-after-flush'

export type WindowCloseBehavior = 'quit' | 'minimize' | 'tray'

export const resolveWindowCloseAction = ({
  platform,
  closeBehavior,
  quitAfterFlushPending,
}: {
  platform: NodeJS.Platform
  closeBehavior: WindowCloseBehavior
  quitAfterFlushPending: boolean
}): WindowCloseAction => {
  if (quitAfterFlushPending) {
    return 'allow-close'
  }

  if (closeBehavior === 'minimize') {
    return 'minimize'
  }

  // 症状：用户开了“关闭后最小化到任务栏”，点 X 的效果和点“—”完全一样，应用还占着任务栏。
  // 根因：2026-08-09 首版只做了 minimize 一档，没有真正隐藏窗口的路径。
  // 被否决的替代：把 minimize 改成 hide —— 依赖任务栏入口的用户会失去它，所以拆成两档。
  if (closeBehavior === 'tray') {
    return 'hide-to-tray'
  }

  return platform === 'darwin' ? 'allow-close' : 'quit-after-flush'
}

export const presentWindow = (win: PresentableWindow | null | undefined) => {
  if (!win || win.isDestroyed()) {
    return false
  }

  if (win.isMinimized()) {
    win.restore()
  }

  if (!win.isVisible()) {
    win.show()
  }

  win.moveTop?.()
  win.focus()
  return true
}

export const focusPrimaryWindow = (windows: readonly PresentableWindow[]) => {
  const target = windows.find((win) => !win.isDestroyed())
  return presentWindow(target)
}

export const flashWindowOnce = (
  win: AttentionWindow | null | undefined,
  durationMs = 1200,
) => {
  if (!win || win.isDestroyed() || typeof win.flashFrame !== 'function') {
    return false
  }

  if (typeof win.isFocused === 'function' && win.isFocused()) {
    return false
  }

  const existingTimer = attentionTimers.get(win)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  win.flashFrame(true)

  const timer = setTimeout(() => {
    attentionTimers.delete(win)

    if (win.isDestroyed()) {
      return
    }

    win.flashFrame?.(false)
  }, Math.max(100, durationMs))

  attentionTimers.set(win, timer)
  return true
}
