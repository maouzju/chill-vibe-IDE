import assert from 'node:assert/strict'
import { test } from 'node:test'

import { updateAutomationBoardDraft } from '../src/components/automation-board-draft.ts'

test('updates the draft ref synchronously before React state catches up', () => {
  const draftRef = { current: '' }
  const stateUpdates: string[] = []

  updateAutomationBoardDraft(draftRef, (next) => stateUpdates.push(next), '刚打完还没失焦')

  // Tab switching can unmount the board before React runs passive effects. The
  // cleanup must still see the latest text, not the previous render's value.
  assert.equal(draftRef.current, '刚打完还没失焦')
  assert.deepEqual(stateUpdates, ['刚打完还没失焦'])
})
