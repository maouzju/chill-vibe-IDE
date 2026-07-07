import type { BrowserWindow } from 'electron'

// Frame-stall watchdog. Forensics dump 2026-07-02T13-52-09 proved the stuck-
// pane failure shape on Windows: the renderer stops producing frames for a
// fully visible window (Chromium's native occlusion miscalculation family)
// while JS/events/layout keep working, leaving the user a dead picture.
// Disabling CalculateNativeWinOcclusion removes the known trigger; this
// watchdog is the defense-in-depth layer that recovers from ANY frame-
// production stall regardless of cause: it polls the renderer's forensics
// heartbeat from the main process (whose timers never throttle) and forces a
// full repaint when a visible window stops advancing frames.

export const frameStallPollIntervalMs = 5_000

export type FrameStallInput = {
  previousFrameTimestamp: number | null
  currentFrameTimestamp: number | null
  windowVisible: boolean
  windowMinimized: boolean
  consecutiveStalls: number
}

export type FrameStallDecision = {
  action: 'none' | 'repaint'
  consecutiveStalls: number
}

// Two consecutive stalled polls (~10s without a single new frame) on a
// window the OS reports as visible is unambiguous — no legitimate idle state
// keeps the compositor at zero frames that long while cursors blink and
// streams update. Hidden/minimized windows legitimately produce no frames.
export const decideFrameStallAction = (input: FrameStallInput): FrameStallDecision => {
  if (!input.windowVisible || input.windowMinimized) {
    return { action: 'none', consecutiveStalls: 0 }
  }
  if (input.currentFrameTimestamp === null || input.previousFrameTimestamp === null) {
    return { action: 'none', consecutiveStalls: 0 }
  }
  if (input.currentFrameTimestamp !== input.previousFrameTimestamp) {
    return { action: 'none', consecutiveStalls: 0 }
  }
  if (input.consecutiveStalls + 1 >= 2) {
    return { action: 'repaint', consecutiveStalls: 0 }
  }
  return { action: 'none', consecutiveStalls: input.consecutiveStalls + 1 }
}

// The logger is injected so this module stays runtime-import-free outside
// Electron (the decision core above is exercised by node:test directly).
export function attachFrameStallWatchdog(
  win: BrowserWindow,
  logWarn: (message: string, meta?: unknown) => void,
) {
  let previousFrameTimestamp: number | null = null
  let consecutiveStalls = 0
  // In-flight guard: executeJavaScript is dispatched to the renderer and, when
  // the renderer's main thread is blocked, these calls queue there instead of
  // resolving. Without this guard the 5s poll keeps firing, the queued probes
  // all resolve in a burst the instant the thread frees, and the stall logic
  // trips repaint many times in the same millisecond (main.log 2026-07-07
  // 22:49:39: 10 "forcing repaint" lines within one second). Skip a poll while
  // the previous probe is still outstanding so one stall == one repaint attempt.
  let probeInFlight = false

  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(timer)
      return
    }

    if (probeInFlight) {
      return
    }
    probeInFlight = true

    void win.webContents
      .executeJavaScript('window.__chillVibeLastFrameTimestamp ?? null', true)
      .then((value: unknown) => {
        const currentFrameTimestamp = typeof value === 'number' ? value : null
        const decision = decideFrameStallAction({
          previousFrameTimestamp,
          currentFrameTimestamp,
          windowVisible: win.isVisible(),
          windowMinimized: win.isMinimized(),
          consecutiveStalls,
        })
        previousFrameTimestamp = currentFrameTimestamp
        consecutiveStalls = decision.consecutiveStalls

        if (decision.action === 'repaint') {
          logWarn('[main] frame stall detected on a visible window; forcing repaint.', {
            windowId: win.id,
            frameTimestamp: currentFrameTimestamp,
          })
          win.webContents.invalidate()
        }
      })
      .catch(() => {
        // A navigating/crashed renderer cannot answer; the next poll retries.
      })
      .finally(() => {
        probeInFlight = false
      })
  }, frameStallPollIntervalMs)

  win.on('closed', () => clearInterval(timer))
}
