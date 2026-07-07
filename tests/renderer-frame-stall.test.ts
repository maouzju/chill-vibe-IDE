import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { decideFrameStallAction } from '../electron/frame-stall-watchdog'

// Forensics dump 2026-07-02T13-52-09 proved the real stuck-pane failure shape:
// the renderer stops producing frames entirely (9 consecutive 1s heartbeat
// samples returned the same rAF timestamp) while JS, events, layout and focus
// all keep working — the user faces a dead picture. Chromium's native window
// occlusion miscalculation on Windows is the known trigger family. These
// tests pin the watchdog that force-repaints out of that state.

test('a fresh frame timestamp means no stall', () => {
  assert.deepEqual(
    decideFrameStallAction({
      previousFrameTimestamp: 1000,
      currentFrameTimestamp: 2000,
      windowVisible: true,
      windowMinimized: false,
      consecutiveStalls: 0,
    }),
    { action: 'none', consecutiveStalls: 0 },
  )
})

test('an identical frame timestamp on a visible window counts one stall tick', () => {
  assert.deepEqual(
    decideFrameStallAction({
      previousFrameTimestamp: 1000,
      currentFrameTimestamp: 1000,
      windowVisible: true,
      windowMinimized: false,
      consecutiveStalls: 0,
    }),
    { action: 'none', consecutiveStalls: 1 },
  )
})

test('a second consecutive stalled tick on a visible window forces a repaint', () => {
  assert.deepEqual(
    decideFrameStallAction({
      previousFrameTimestamp: 1000,
      currentFrameTimestamp: 1000,
      windowVisible: true,
      windowMinimized: false,
      consecutiveStalls: 1,
    }),
    { action: 'repaint', consecutiveStalls: 0 },
  )
})

test('a minimized or hidden window never triggers a repaint — no frames is normal there', () => {
  assert.deepEqual(
    decideFrameStallAction({
      previousFrameTimestamp: 1000,
      currentFrameTimestamp: 1000,
      windowVisible: true,
      windowMinimized: true,
      consecutiveStalls: 5,
    }),
    { action: 'none', consecutiveStalls: 0 },
  )
  assert.deepEqual(
    decideFrameStallAction({
      previousFrameTimestamp: 1000,
      currentFrameTimestamp: 1000,
      windowVisible: false,
      windowMinimized: false,
      consecutiveStalls: 5,
    }),
    { action: 'none', consecutiveStalls: 0 },
  )
})

test('a missing renderer sample (null) is treated as not-yet-known, not a stall', () => {
  assert.deepEqual(
    decideFrameStallAction({
      previousFrameTimestamp: null,
      currentFrameTimestamp: null,
      windowVisible: true,
      windowMinimized: false,
      consecutiveStalls: 3,
    }),
    { action: 'none', consecutiveStalls: 0 },
  )
})

// ── wiring assertions ───────────────────────────────────────────────────────

test('main process disables the Windows native occlusion miscalculation and throttling', async () => {
  const main = await readFile(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')
  assert.match(
    main,
    /appendSwitch\('disable-features',\s*'CalculateNativeWinOcclusion'\)/,
    'Chromium 120+ miscalculates native window occlusion on Windows and stops rendering a fully visible window (forensics 2026-07-02T13-52-09); the feature must be disabled before app ready',
  )
  assert.match(
    main,
    /backgroundThrottling:\s*false/,
    'backgroundThrottling amplifies every occlusion misjudgment into a full rAF/timer stall (investigation §2.2)',
  )
  assert.match(main, /attachFrameStallWatchdog/, 'the watchdog must be attached to the main window')
  const watchdog = await readFile(
    path.join(process.cwd(), 'electron', 'frame-stall-watchdog.ts'),
    'utf8',
  )
  assert.match(
    watchdog,
    /webContents\.invalidate\(\)/,
    'the repaint action must force a full window redraw',
  )
})

test('the renderer forensics heartbeat exposes the frame timestamp the watchdog polls', async () => {
  const forensics = await readFile(
    path.join(process.cwd(), 'src', 'diagnostics', 'stuck-pane-forensics.ts'),
    'utf8',
  )
  assert.match(forensics, /__chillVibeLastFrameTimestamp/)
})

test('the frame-stall watchdog skips a poll while the previous probe is still in flight', async () => {
  // main.log 2026-07-07 22:49:39 recorded 10 "forcing repaint" lines within one
  // second: while the renderer main thread was blocked, executeJavaScript probes
  // queued and all resolved in a burst, tripping repaint repeatedly. An in-flight
  // guard makes one stall produce one repaint attempt.
  const watchdog = await readFile(
    path.join(process.cwd(), 'electron', 'frame-stall-watchdog.ts'),
    'utf8',
  )
  assert.match(watchdog, /probeInFlight/, 'the watchdog must guard against overlapping probes')
  assert.match(
    watchdog,
    /\.finally\(\(\) => \{\s*probeInFlight = false/,
    'the in-flight flag must be cleared when the probe settles',
  )
})

test('the main window captures the JS call stack when the renderer goes unresponsive', async () => {
  const main = await readFile(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')
  assert.match(
    main,
    /collectJavaScriptCallStack/,
    'unresponsive handling must capture the blocked main thread JS stack (dump 2026-07-07T14-50)',
  )
  assert.match(
    main,
    /summarizeUnresponsiveCallStack/,
    'the captured stack must be summarized into the log',
  )
  assert.match(
    main,
    /win\.on\('responsive'/,
    'a responsive-again listener must exist so recovery is not invisible',
  )
})
