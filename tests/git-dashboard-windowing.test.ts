import assert from 'node:assert/strict'
import test from 'node:test'

import { getGitDashboardFileListWindow, getGitDashboardVisibleChanges } from '../src/components/git-dashboard-windowing.ts'
import type { GitChange } from '../shared/schema.ts'

const createGitChange = (index: number): GitChange => ({
  path: `src/file-${String(index).padStart(3, '0')}.ts`,
  kind: 'modified',
  stagedStatus: ' ',
  workingTreeStatus: 'M',
  staged: false,
  conflicted: false,
  addedLines: index,
  removedLines: index % 5,
})

test('git dashboard file list keeps small lists fully rendered', () => {
  const changes = Array.from({ length: 25 }, (_, index) => createGitChange(index + 1))
  const window = getGitDashboardFileListWindow({
    changeCount: changes.length,
    viewportHeight: 400,
    scrollTop: 0,
  })

  assert.equal(window.isVirtualized, false)
  assert.equal(window.startIndex, 0)
  assert.equal(window.endIndex, changes.length)
  assert.deepEqual(getGitDashboardVisibleChanges(changes, window), changes)
})

test('git dashboard file list windows long lists into a narrow slice', () => {
  const changes = Array.from({ length: 240 }, (_, index) => createGitChange(index + 1))
  const window = getGitDashboardFileListWindow({
    changeCount: changes.length,
    viewportHeight: 220,
    scrollTop: 960,
  })

  assert.equal(window.isVirtualized, true)
  assert.ok(window.endIndex > window.startIndex)
  assert.ok(window.endIndex - window.startIndex <= 32)
  assert.equal(window.topSpacerHeight, window.startIndex * 20)
  assert.equal(window.bottomSpacerHeight, (changes.length - window.endIndex) * 20)

  const visibleChanges = getGitDashboardVisibleChanges(changes, window)
  assert.deepEqual(
    visibleChanges.map((change) => change.path),
    changes.slice(window.startIndex, window.endIndex).map((change) => change.path),
  )
  assert.notEqual(visibleChanges.at(-1)?.path, changes.at(-1)?.path)
})
