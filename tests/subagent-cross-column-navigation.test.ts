import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import {
  findCardColumnAndPane,
  findChildCards,
  getSubagentNavigationActions,
  sameColumnSourceCards,
} from '../src/components/subagent-cross-column-navigation.ts'

test('agent child tabs remain discoverable after moving to a different workspace column', () => {
  const state = createDefaultState()
  const [parentColumn, childColumn] = state.columns
  assert.ok(parentColumn)
  assert.ok(childColumn)
  const parentId = parentColumn.layout.type === 'pane' ? parentColumn.layout.activeTabId : ''
  const childId = childColumn.layout.type === 'pane' ? childColumn.layout.activeTabId : ''
  assert.ok(parentId)
  assert.ok(childId)
  const previousColumns = structuredClone(state.columns)
  childColumn.cards[childId]!.parentCardId = parentId

  assert.deepEqual(findChildCards(state.columns, parentId).map((card) => card.id), [childId])
  assert.equal(sameColumnSourceCards(previousColumns, state.columns, parentColumn.id), false)
})

test('return-to-parent can locate the pane containing a parent in another column', () => {
  const state = createDefaultState()
  const [parentColumn, childColumn] = state.columns
  assert.ok(parentColumn)
  assert.ok(childColumn)
  const parentId = parentColumn.layout.type === 'pane' ? parentColumn.layout.activeTabId : ''
  assert.ok(parentId)

  const target = findCardColumnAndPane(state.columns, parentId)

  assert.equal(target?.column.id, parentColumn.id)
  assert.equal(target?.pane.tabs.includes(parentId), true)
})

test('navigation to a child in a docked column restores the column before activating its tab', () => {
  const state = createDefaultState()
  const [, childColumn] = state.columns
  assert.ok(childColumn)
  const childId = childColumn.layout.type === 'pane' ? childColumn.layout.activeTabId : ''
  assert.ok(childId)
  childColumn.docked = true

  const target = findCardColumnAndPane(state.columns, childId)
  assert.ok(target)
  assert.deepEqual(getSubagentNavigationActions(state.columns, childId), [
    { type: 'undockColumn', columnId: target.column.id },
    {
      type: 'setActiveTab',
      columnId: target.column.id,
      paneId: target.pane.id,
      tabId: childId,
    },
  ])
})

test('source-column memo comparison detects new child summaries from another column', () => {
  const state = createDefaultState()
  const [parentColumn, childColumn] = state.columns
  assert.ok(parentColumn)
  assert.ok(childColumn)
  const parentId = parentColumn.layout.type === 'pane' ? parentColumn.layout.activeTabId : ''
  const childId = childColumn.layout.type === 'pane' ? childColumn.layout.activeTabId : ''
  assert.ok(parentId)
  assert.ok(childId)
  const previous = structuredClone(state.columns)
  childColumn.cards[childId]!.parentCardId = parentId

  assert.equal(sameColumnSourceCards(previous, state.columns, parentColumn.id), false)
})
