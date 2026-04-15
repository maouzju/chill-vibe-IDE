import assert from 'node:assert/strict'
import test from 'node:test'

import { getVirtualizedListWindow } from '../src/components/git-change-windowing.ts'

test('git change windowing keeps the full list when the item count is below the virtualization threshold', () => {
  assert.deepEqual(
    getVirtualizedListWindow({
      itemCount: 25,
      itemHeight: 52,
      viewportHeight: 520,
      scrollTop: 0,
      overscan: 6,
      threshold: 60,
    }),
    {
      isVirtualized: false,
      startIndex: 0,
      endIndex: 25,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    },
  )
})

test('git change windowing renders only the visible slice plus overscan for long lists', () => {
  assert.deepEqual(
    getVirtualizedListWindow({
      itemCount: 120,
      itemHeight: 50,
      viewportHeight: 200,
      scrollTop: 500,
      overscan: 2,
      threshold: 60,
    }),
    {
      isVirtualized: true,
      startIndex: 8,
      endIndex: 16,
      topSpacerHeight: 400,
      bottomSpacerHeight: 5200,
    },
  )
})

test('git change windowing clamps the tail slice near the bottom of the list', () => {
  assert.deepEqual(
    getVirtualizedListWindow({
      itemCount: 120,
      itemHeight: 50,
      viewportHeight: 200,
      scrollTop: 5900,
      overscan: 2,
      threshold: 60,
    }),
    {
      isVirtualized: true,
      startIndex: 116,
      endIndex: 120,
      topSpacerHeight: 5800,
      bottomSpacerHeight: 0,
    },
  )
})
