// Unresponsive-window forensics. When Electron reports a BrowserWindow as
// unresponsive the renderer's main thread is blocked in a synchronous task —
// but the plain event only says "it's stuck", never WHAT is stuck. Electron 34+
// exposes `webContents.mainFrame.collectJavaScriptCallStack()`, which returns
// the JS call stack of the blocked main thread WITHOUT attaching a debugger.
// Capturing it turns "became unresponsive" from a dead end into an actionable
// stack pointing at the exact synchronous hot path (state save, render, parse …).
//
// This module is the pure formatting/decision core so it stays import-free
// outside Electron and is exercised directly by node:test.

export type UnresponsiveCallStackSummary = {
  windowId: number
  capturedAtIso: string
  // The raw stack string from collectJavaScriptCallStack(), or a reason it was
  // unavailable (empty string = renderer answered with no JS frames, i.e. it is
  // blocked in native/GC rather than app JS).
  callStack: string
  frameCount: number
  available: boolean
}

// Collapse a raw V8 call-stack string into a compact, log-friendly summary.
// The raw stack can be long; keep the top frames (where the blocking work is)
// and record the total depth so a truncated tail is never mistaken for the
// whole picture.
export const summarizeUnresponsiveCallStack = (input: {
  windowId: number
  capturedAtIso: string
  rawCallStack: string | null | undefined
  maxFrames?: number
}): UnresponsiveCallStackSummary => {
  const maxFrames = input.maxFrames ?? 24
  const raw = typeof input.rawCallStack === 'string' ? input.rawCallStack : ''
  const frames = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const available = frames.length > 0
  const kept = frames.slice(0, maxFrames)
  const omitted = frames.length - kept.length
  const callStack =
    omitted > 0
      ? `${kept.join('\n')}\n[+${omitted} more frame${omitted === 1 ? '' : 's'} omitted]`
      : kept.join('\n')

  return {
    windowId: input.windowId,
    capturedAtIso: input.capturedAtIso,
    callStack,
    frameCount: frames.length,
    available,
  }
}
