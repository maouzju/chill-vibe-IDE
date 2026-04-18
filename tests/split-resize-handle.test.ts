import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getResizedSplitRatios } from '../src/components/split-resize-utils.ts'

describe('split resize handle math', () => {
  it('keeps a tiny horizontal split centered instead of collapsing one side to zero width', () => {
    const nextRatios = getResizedSplitRatios([0.5, 0.5], 0, 0.2, 100)

    assert.deepEqual(nextRatios, [0.5, 0.5])
  })

  it('still respects the minimum pane size when enough width exists', () => {
    const nextRatios = getResizedSplitRatios([0.5, 0.5], 0, 0.4, 400)

    assert.deepEqual(nextRatios, [0.7, 0.3])
  })
})
