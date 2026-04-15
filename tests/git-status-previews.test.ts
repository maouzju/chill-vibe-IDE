import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitStatus } from '../shared/schema.ts'
import {
  applyOptimisticGitStageState,
  mergeGitStatusPreservingPreviews,
} from '../src/components/git-status-previews.ts'

const createStatus = (overrides?: Partial<GitStatus>): GitStatus => ({
  workspacePath: 'D:\\Git\\chill-vibe',
  repoRoot: 'D:\\Git\\chill-vibe',
  isRepository: true,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  clean: false,
  hasConflicts: false,
  summary: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
  description: '',
  changes: [
    {
      path: 'src/components/GitFullDialog.tsx',
      kind: 'modified',
      stagedStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
      conflicted: false,
      addedLines: 3,
      removedLines: 1,
      patch: '@@ -1,2 +1,4 @@\n-old line\n+new line',
    },
  ],
  lastCommit: null,
  ...overrides,
})

test('mergeGitStatusPreservingPreviews keeps existing diff previews when stage updates omit them', () => {
  const previous = createStatus()
  const next = createStatus({
    summary: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    changes: [
      {
        path: 'src/components/GitFullDialog.tsx',
        kind: 'modified',
        stagedStatus: 'M',
        workingTreeStatus: ' ',
        staged: true,
        conflicted: false,
      },
    ],
  })

  const merged = mergeGitStatusPreservingPreviews(previous, next)

  assert.equal(merged.changes[0]?.staged, true)
  assert.equal(merged.changes[0]?.patch, previous.changes[0]?.patch)
  assert.equal(merged.changes[0]?.addedLines, 3)
  assert.equal(merged.changes[0]?.removedLines, 1)
})

test('applyOptimisticGitStageState flips tracked file status immediately for the UI', () => {
  const change = createStatus().changes[0]!

  const staged = applyOptimisticGitStageState(change, true)
  assert.equal(staged.staged, true)
  assert.equal(staged.stagedStatus, 'M')
  assert.equal(staged.workingTreeStatus, ' ')

  const unstaged = applyOptimisticGitStageState(staged, false)
  assert.equal(unstaged.staged, false)
  assert.equal(unstaged.stagedStatus, ' ')
  assert.equal(unstaged.workingTreeStatus, 'M')
})
