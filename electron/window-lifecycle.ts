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
