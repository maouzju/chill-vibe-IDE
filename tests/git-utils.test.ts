import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitChange } from '../shared/schema.ts'
import { computeTotalStats } from '../src/components/git-utils.ts'

const createChange = (path: string, stats?: { addedLines?: number; removedLines?: number }): GitChange => ({
  path,
  kind: 'modified',
  stagedStatus: ' ',
  workingTreeStatus: 'M',
  staged: false,
  conflicted: false,
  ...stats,
})

test('computeTotalStats reports unknown when git preview has changed files without line stats', () => {
  const stats = computeTotalStats([
    createChange('src/components/GitToolCard.tsx'),
    createChange('tests/git-tool-switch.spec.ts'),
  ])

  assert.equal(stats.added, undefined)
  assert.equal(stats.removed, undefined)
  assert.equal(stats.hasKnownLineStats, false)
})

test('computeTotalStats sums numeric line stats when full diff data is available', () => {
  const stats = computeTotalStats([
    createChange('src/components/GitToolCard.tsx', { addedLines: 12, removedLines: 4 }),
    createChange('tests/git-tool-switch.spec.ts', { addedLines: 3, removedLines: 1 }),
  ])

  assert.equal(stats.added, 15)
  assert.equal(stats.removed, 5)
  assert.equal(stats.hasKnownLineStats, true)
})
