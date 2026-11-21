import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampView,
  getDoubleClickScale,
  getFitScale,
  getWheelZoomFactor,
  wrapLightboxIndex,
  zoomViewAt,
} from '../src/components/image-lightbox-math.ts'

const viewport = { width: 1000, height: 800 }
const big = { width: 4000, height: 2000 }

test('fit scale shrinks large images and never upscales small ones', () => {
  assert.equal(getFitScale(big, viewport), 0.25)
  assert.equal(getFitScale({ width: 200, height: 100 }, viewport), 1)
})

test('zooming keeps the image pixel under the cursor fixed', () => {
  const start = { scale: 0.25, x: 0, y: 0 }
  const anchor = { x: 300, y: -100 }
  const next = zoomViewAt(start, 1, anchor, big, viewport)
  // image-space point under anchor before and after must match
  const before = { x: (anchor.x - start.x) / start.scale, y: (anchor.y - start.y) / start.scale }
  const after = { x: (anchor.x - next.x) / next.scale, y: (anchor.y - next.y) / next.scale }
  assert.ok(Math.abs(before.x - after.x) < 1e-6)
  assert.ok(Math.abs(before.y - after.y) < 1e-6)
})

test('panning cannot drag the image out of view, and small images stay centered', () => {
  const clamped = clampView({ scale: 1, x: 99999, y: -99999 }, big, viewport)
  assert.equal(clamped.x, (4000 - 1000) / 2)
  assert.equal(clamped.y, -(2000 - 800) / 2)
  assert.deepEqual(clampView({ scale: 0.25, x: 50, y: 50 }, big, viewport), { scale: 0.25, x: 0, y: 0 })
})

test('double click toggles fit <-> actual size, and 2x for images that already fit', () => {
  assert.equal(getDoubleClickScale(0.25, 0.25), 1)
  assert.equal(getDoubleClickScale(1, 0.25), 0.25)
  assert.equal(getDoubleClickScale(1, 1), 2)
})

test('wheel down zooms out, wheel up zooms in, index wraps', () => {
  assert.ok(getWheelZoomFactor(100) < 1)
  assert.ok(getWheelZoomFactor(-100) > 1)
  assert.equal(wrapLightboxIndex(-1, 3), 2)
  assert.equal(wrapLightboxIndex(3, 3), 0)
})
