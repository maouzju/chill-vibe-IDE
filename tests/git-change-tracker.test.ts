import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitChange } from '../shared/schema.ts'
import {
  getGitChangesSinceLastSnapshot,
  rememberGitChangeSnapshot,
} from '../src/components/git-change-tracker.ts'

const createOversizedChange = (contentSignature: string): GitChange => ({
  path: 'assets/huge.json',
  kind: 'modified',
  stagedStatus: ' ',
  workingTreeStatus: 'M',
  staged: false,
  conflicted: false,
  // 预览预算耗尽时服务端只回 patch: '' 且没有行数
  patch: '',
  contentSignature,
})

test('a budget-skipped change whose content signature moved counts as new', () => {
  const ws = 'D:\\repo-tracker'
  rememberGitChangeSnapshot(ws, [createOversizedChange('100:1')])

  const unchanged = getGitChangesSinceLastSnapshot(ws, [createOversizedChange('100:1')])
  assert.deepEqual(unchanged.changedPaths, [])

  const edited = getGitChangesSinceLastSnapshot(ws, [createOversizedChange('120:2')])
  assert.deepEqual(edited.changedPaths, ['assets/huge.json'])
})
