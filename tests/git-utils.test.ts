import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitChange } from '../shared/schema.ts'
import { computeTotalStats } from '../src/components/git-utils.ts'
import { runCommitDiffSelection } from '../src/components/GitFullDialog.tsx'

// 模拟 GitFullDialog 里 commit diff 面板的那几个 state slot，外加可控的 fetch。
const createCommitDiffHarness = () => {
  const pending = new Map<string, (patch: string) => void>()
  const rejecters = new Map<string, (error: Error) => void>()
  const state = {
    selectedHash: null as string | null,
    patch: null as string | null,
    loading: false,
  }

  const effects = {
    requestRef: { current: 0 },
    fetchDiff: (hash: string) =>
      new Promise<{ patch: string }>((resolve, reject) => {
        pending.set(hash, (patch) => resolve({ patch }))
        rejecters.set(hash, reject)
      }),
    setSelectedHash: (hash: string) => {
      state.selectedHash = hash
    },
    setPatch: (patch: string | null) => {
      state.patch = patch
    },
    setLoading: (loading: boolean) => {
      state.loading = loading
    },
  }

  return {
    state,
    effects,
    select: (hash: string) => runCommitDiffSelection(hash, effects),
    // 让某个还在飞的请求返回，并把微任务队列跑干净（await 链继续执行）。
    settle: async (hash: string, patch: string) => {
      pending.get(hash)?.(patch)
      pending.delete(hash)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    fail: async (hash: string, message: string) => {
      rejecters.get(hash)?.(new Error(message))
      rejecters.delete(hash)
      pending.delete(hash)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

test('a stale commit diff that lands after a newer selection must not overwrite it', async () => {
  const harness = createCommitDiffHarness()

  // 快速点两个提交：先点 A，再点 B。两个请求同时在飞。
  const first = harness.select('aaaa')
  const second = harness.select('bbbb')
  assert.equal(harness.state.selectedHash, 'bbbb')

  // B 先回来，然后 A 才姗姗来迟。
  await harness.settle('bbbb', 'diff-for-bbbb')
  await harness.settle('aaaa', 'diff-for-aaaa')
  await Promise.all([first, second])

  // 标题是 B，正文也必须是 B —— 迟到的 A 不能盖上去。
  assert.equal(harness.state.selectedHash, 'bbbb')
  assert.equal(harness.state.patch, 'diff-for-bbbb')
  assert.equal(harness.state.loading, false)
})

test('a stale commit diff must not clear the loading flag of the newer selection', async () => {
  const harness = createCommitDiffHarness()

  const first = harness.select('aaaa')
  const second = harness.select('bbbb')

  // A 先回来，但 B 还在飞：A 的 finally 不能提前关掉 loading，
  // 否则面板会露出上一份 diff 内容当成 B 的结果。
  await harness.settle('aaaa', 'diff-for-aaaa')
  assert.equal(harness.state.loading, true, 'the newer request is still in flight')
  assert.equal(harness.state.patch, null, 'the stale diff must not render')

  await harness.settle('bbbb', 'diff-for-bbbb')
  await Promise.all([first, second])

  assert.equal(harness.state.patch, 'diff-for-bbbb')
  assert.equal(harness.state.loading, false)
})

test('a stale commit diff failure must not blank out or unblock the newer selection', async () => {
  const harness = createCommitDiffHarness()

  const first = harness.select('aaaa')
  const second = harness.select('bbbb')

  await harness.fail('aaaa', 'git exploded')
  assert.equal(harness.state.loading, true, 'the newer request is still in flight')

  await harness.settle('bbbb', 'diff-for-bbbb')
  await Promise.all([first, second])

  assert.equal(harness.state.patch, 'diff-for-bbbb')
  assert.equal(harness.state.loading, false)
})

test('a single commit selection still renders its diff and clears loading', async () => {
  const harness = createCommitDiffHarness()

  const selection = harness.select('aaaa')
  assert.equal(harness.state.selectedHash, 'aaaa')
  assert.equal(harness.state.loading, true)
  assert.equal(harness.state.patch, null)

  await harness.settle('aaaa', 'diff-for-aaaa')
  await selection

  assert.equal(harness.state.patch, 'diff-for-aaaa')
  assert.equal(harness.state.loading, false)
})

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
