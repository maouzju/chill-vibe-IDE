import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideTabStripWheelScroll } from '../src/components/pane-tab-wheel.ts'

const rect = { left: 100, top: 40, right: 700, bottom: 70 }

const overflowingStrip = {
  rect,
  scrollLeft: 200,
  scrollWidth: 2400,
  clientWidth: 600,
}

const insidePoint = { x: 300, y: 55 }

const layoutHitOwned = () => true

test('scrolls on vertical wheel when the pointer is inside the strip rect, regardless of event target', () => {
  // The decision core never sees event.target: a stale compositor hit-test
  // surface can route the wheel to an unrelated subtree, so geometry + layout
  // truth are the only inputs (same contract as decideMisroutedTabPointerRescue).
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 120 },
    overflowingStrip,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'scroll', nextScrollLeft: 320 })
})

test('scrolls backwards on negative vertical delta', () => {
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: -120 },
    overflowingStrip,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'scroll', nextScrollLeft: 80 })
})

test('prefers horizontal delta when it dominates', () => {
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 240, deltaY: -10 },
    overflowingStrip,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'scroll', nextScrollLeft: 440 })
})

test('clamps to the scrollable range', () => {
  const nearEnd = { ...overflowingStrip, scrollLeft: 1750 }
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 600 },
    nearEnd,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'scroll', nextScrollLeft: 1800 })

  const nearStart = { ...overflowingStrip, scrollLeft: 40 }
  const back = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: -600 },
    nearStart,
    layoutHitOwned,
  )
  assert.deepEqual(back, { kind: 'scroll', nextScrollLeft: 0 })
})

test('does nothing when already pinned at the end in the wheel direction', () => {
  const atEnd = { ...overflowingStrip, scrollLeft: 1800 }
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 120 },
    atEnd,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('does nothing when the strip does not overflow', () => {
  const fits = { ...overflowingStrip, scrollLeft: 0, scrollWidth: 600 }
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 120 },
    fits,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('does nothing when the pointer is outside the strip rect', () => {
  const decision = decideTabStripWheelScroll(
    { x: 300, y: 200 },
    { deltaX: 0, deltaY: 120 },
    overflowingStrip,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('does nothing when layout truth says an overlay owns the point', () => {
  // A genuine dropdown/dialog above the tab bar must keep receiving wheel
  // events — elementFromPoint is main-thread layout truth, immune to the stale
  // compositor surface, so it distinguishes misroute from real overlays.
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 120 },
    overflowingStrip,
    () => false,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('does nothing on a zero-delta wheel event', () => {
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 0 },
    overflowingStrip,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('ignores sub-pixel scroll deltas that would not move the strip', () => {
  const decision = decideTabStripWheelScroll(
    insidePoint,
    { deltaX: 0, deltaY: 0.4 },
    overflowingStrip,
    layoutHitOwned,
  )
  assert.deepEqual(decision, { kind: 'none' })
})
