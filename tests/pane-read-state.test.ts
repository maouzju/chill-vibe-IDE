import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPane, createSplit } from '../shared/default-state.ts'
import {
  getAutoReadCardIdsForVisiblePanes,
  getAutoReadCardId,
  shouldMarkCardUnreadOnStreamDone,
} from '../src/components/pane-read-state.ts'

describe('pane unread state helpers', () => {
  it('does not flag unread when the completed card is already visible in the active pane', () => {
    const layout = createPane(['card-1'], 'card-1', 'pane-1')

    assert.equal(shouldMarkCardUnreadOnStreamDone(layout, 'card-1', true), false)
  })

  it('keeps unread when the completed card is in an inactive tab or the board is hidden', () => {
    const inactiveTabLayout = createPane(['card-1', 'card-2'], 'card-2', 'pane-1')
    const hiddenBoardLayout = createSplit(
      'horizontal',
      [createPane(['card-1'], 'card-1', 'pane-left'), createPane(['card-2'], 'card-2', 'pane-right')],
      [0.5, 0.5],
      'split-1',
    )

    assert.equal(shouldMarkCardUnreadOnStreamDone(inactiveTabLayout, 'card-1', true), true)
    assert.equal(shouldMarkCardUnreadOnStreamDone(hiddenBoardLayout, 'card-1', false), true)
  })

  it('returns the active unread card id when the pane tab is mounted and visible', () => {
    assert.equal(
      getAutoReadCardId(
        {
          id: 'card-1',
          unread: true,
        },
        true,
      ),
      'card-1',
    )
  })

  it('skips auto-read when the active tab is not mounted yet', () => {
    assert.equal(
      getAutoReadCardId(
        {
          id: 'card-1',
          unread: true,
        },
        false,
      ),
      null,
    )
  })

  it('skips auto-read for cards that are already read or missing', () => {
    assert.equal(
      getAutoReadCardId(
        {
          id: 'card-1',
          unread: false,
        },
        true,
      ),
      null,
    )
    assert.equal(getAutoReadCardId(undefined, true), null)
  })

  it('returns unread active tabs across visible panes when the board becomes visible again', () => {
    const layout = createSplit(
      'horizontal',
      [createPane(['card-1', 'card-2'], 'card-1', 'pane-left'), createPane(['card-3'], 'card-3', 'pane-right')],
      [0.5, 0.5],
      'split-1',
    )

    assert.deepEqual(
      getAutoReadCardIdsForVisiblePanes(
        layout,
        {
          'card-1': { id: 'card-1', unread: true },
          'card-2': { id: 'card-2', unread: true },
          'card-3': { id: 'card-3', unread: false },
        },
        true,
      ),
      ['card-1'],
    )

    assert.deepEqual(
      getAutoReadCardIdsForVisiblePanes(
        layout,
        {
          'card-1': { id: 'card-1', unread: true },
          'card-2': { id: 'card-2', unread: true },
          'card-3': { id: 'card-3', unread: true },
        },
        false,
      ),
      [],
    )
  })
})
