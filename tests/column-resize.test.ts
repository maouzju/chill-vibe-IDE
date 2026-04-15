import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { minColumnWidth } from '../shared/default-state.ts'
import { resizeColumnGroups } from '../src/column-resize.ts'

describe('resizeColumnGroups', () => {
  it('resizes the left and right column groups together around a divider', () => {
    assert.deepEqual(resizeColumnGroups([350, 350, 350, 350], 1, 100), [400, 400, 300, 300])
  })

  it('clamps the drag when a group would shrink below the minimum width', () => {
    assert.deepEqual(
      resizeColumnGroups([420, 420, 300], 1, 200),
      [440, 440, minColumnWidth],
    )
  })

  it('ignores divider indexes that do not split the columns into two groups', () => {
    assert.deepEqual(resizeColumnGroups([320, 320, 320], -1, 80), [320, 320, 320])
    assert.deepEqual(resizeColumnGroups([320, 320, 320], 2, 80), [320, 320, 320])
  })
})
