// Retry wrapper for loading the renderer into a BrowserWindow.
//
// Symptom: 2026-08-11 22:24:13, 29ms after "BrowserWindow created", main.log
// recorded `unhandledRejection: Error: ERR_FAILED (-2) loading .../index.html`
// with `WebContents.stopLoadingListener` on the stack, and the app quit with
// exitCode 0 -- from the outside, the new package "flashed and vanished".
// Root cause: main.ts had two load paths with unequal care. The dev path
// (loadWindowUrl) caught failures and retried 40 times, while the packaged
// path -- the one users actually run -- was a bare
// `void win.loadFile(target).then(...)` with no catch, so any rejection became
// an unhandledRejection and no retry ever happened. The trigger is a
// single-instance handoff: the user relaunches after a hard kill, the second
// instance loses the lock and calls app.quit(), and that tears the window down
// mid-load.
// Why not just add .catch to the packaged path: the two paths would drift
// again, and blindly copying the dev path's 40 retries is wrong here -- once
// the window is gone, retrying is pure noise. Both concerns (never reject,
// stop when the window is abandoned) belong in one tested place.

export type RendererLoadRetryOptions = {
  /** Performs one load attempt. May reject or throw synchronously. */
  load: () => Promise<void> | void
  /** True once the window is destroyed or the app is quitting; stops the loop. */
  isAbandoned?: () => boolean
  /** Called after each failed attempt, with the 1-based attempt number. */
  onAttemptFailed?: (attempt: number, error: unknown) => void
  maxAttempts?: number
  delayMs?: number
  /** Injectable so tests do not spend real time sleeping. */
  wait?: (ms: number) => Promise<void>
}

export type RendererLoadRetryResult = {
  loaded: boolean
  /** How many times `load` was actually invoked. */
  attempts: number
  /** True when the loop stopped because the window went away, not because it ran out of attempts. */
  abandoned: boolean
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export const loadRendererWithRetry = async ({
  load,
  isAbandoned,
  onAttemptFailed,
  maxAttempts = 40,
  delayMs = 500,
  wait = defaultWait,
}: RendererLoadRetryOptions): Promise<RendererLoadRetryResult> => {
  let attempts = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isAbandoned?.()) {
      return { loaded: false, attempts, abandoned: true }
    }

    attempts = attempt

    try {
      // `await` covers both a rejected promise and a synchronous throw.
      await load()
      return { loaded: true, attempts, abandoned: false }
    } catch (error) {
      onAttemptFailed?.(attempt, error)

      // Checked before sleeping as well: a load that fails *because* the window
      // was destroyed would otherwise wait out a pointless delay first.
      if (isAbandoned?.()) {
        return { loaded: false, attempts, abandoned: true }
      }

      if (attempt < maxAttempts) {
        await wait(delayMs)
      }
    }
  }

  return { loaded: false, attempts, abandoned: false }
}
