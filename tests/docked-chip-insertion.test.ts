import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pickTopbarDensityLevel, resolveDockInsertion, type DockChipRect } from '../src/components/docked-chip-insertion.ts'

const chip = (id: string, left: number, top: number, width = 60, height = 20): DockChipRect => ({
  id,
  left,
  right: left + width,
  top,
  bottom: top + height,
})

// 第一行 a b c，第二行 d e
const chips = [
  chip('a', 0, 0),
  chip('b', 70, 0),
  chip('c', 140, 0),
  chip('d', 0, 28),
  chip('e', 70, 28),
]

describe('resolveDockInsertion', () => {
  it('returns null when there is no chip to anchor on', () => {
    assert.equal(resolveDockInsertion([], { x: 10, y: 10 }), null)
  })

  it('inserts before / after by the pointer side of a chip centre within a row', () => {
    assert.deepEqual(resolveDockInsertion(chips, { x: 75, y: 10 }), { targetId: 'b', placement: 'before' })
    assert.deepEqual(resolveDockInsertion(chips, { x: 120, y: 10 }), { targetId: 'c', placement: 'before' })
  })

  it('a gap between chips resolves to the chip on its right', () => {
    assert.deepEqual(resolveDockInsertion(chips, { x: 66, y: 10 }), { targetId: 'b', placement: 'before' })
  })

  it('left of everything goes before the first chip, right of the row goes after its last chip', () => {
    assert.deepEqual(resolveDockInsertion(chips, { x: -40, y: 10 }), { targetId: 'a', placement: 'before' })
    assert.deepEqual(resolveDockInsertion(chips, { x: 900, y: 10 }), { targetId: 'c', placement: 'after' })
  })

  it('picks the row under the pointer, so a second row is a real insertion target', () => {
    assert.deepEqual(resolveDockInsertion(chips, { x: 100, y: 38 }), { targetId: 'e', placement: 'after' })
    assert.deepEqual(resolveDockInsertion(chips, { x: 20, y: 38 }), { targetId: 'd', placement: 'before' })
    assert.deepEqual(resolveDockInsertion(chips, { x: 900, y: 38 }), { targetId: 'e', placement: 'after' })
  })

  it('a pointer between two rows snaps to the nearer row', () => {
    assert.deepEqual(resolveDockInsertion(chips, { x: 5, y: 22 }), { targetId: 'a', placement: 'before' })
    assert.deepEqual(resolveDockInsertion(chips, { x: 5, y: 26 }), { targetId: 'd', placement: 'before' })
  })

  it('ignores the chip being dragged', () => {
    assert.deepEqual(resolveDockInsertion(chips, { x: 75, y: 10 }, 'b'), { targetId: 'c', placement: 'before' })
    assert.equal(resolveDockInsertion([chip('a', 0, 0)], { x: 5, y: 5 }, 'a'), null)
  })
})

describe('pickTopbarDensityLevel', () => {
  it('uses the roomiest level that still fits on one row', () => {
    assert.equal(pickTopbarDensityLevel(3, (level) => level >= 1), 1)
    assert.equal(pickTopbarDensityLevel(3, () => true), 0)
  })

  it('falls back to the tightest level (and lets the row wrap) when nothing fits', () => {
    assert.equal(pickTopbarDensityLevel(3, () => false), 2)
  })
})
