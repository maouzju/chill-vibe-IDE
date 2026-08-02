import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { GitStatus } from '../shared/schema.ts'
import {
  refreshGitAgentAnalysisTimeout,
  settleGitAgentAnalysisStream,
} from '../src/components/git-agent-stream.ts'
import { GitAgentStrategyList } from '../src/components/GitAgentStrategyList.tsx'
import { buildAnalysisPrompt, parseAnalysisResult } from '../src/components/git-agent-panel-utils.ts'
import { shouldShowConflictBanner } from '../src/components/git-utils.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createGitStatus = (): GitStatus => ({
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
      path: 'src/components/GitToolCard.tsx',
      kind: 'modified',
      stagedStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
      conflicted: false,
      addedLines: 12,
      removedLines: 4,
      patch: '@@ -1,1 +1,1 @@\n-old line\n+new line',
    },
  ],
  lastCommit: null,
})

test('shouldShowConflictBanner hides the manual-resolve banner while the sync panel auto-resolves', () => {
  // 没有冲突时永远不显示
  assert.equal(shouldShowConflictBanner({ hasConflicts: false, syncPanelOpen: false }), false)
  assert.equal(shouldShowConflictBanner({ hasConflicts: false, syncPanelOpen: true }), false)

  // 有冲突且没有同步面板在跑 → 提示用户手动解决
  assert.equal(shouldShowConflictBanner({ hasConflicts: true, syncPanelOpen: false }), true)

  // 同步面板打开 = Codex 正在自动解决冲突，手动提示会和它互相矛盾，必须隐藏
  assert.equal(shouldShowConflictBanner({ hasConflicts: true, syncPanelOpen: true }), false)
})

test('buildAnalysisPrompt requires human-readable output in the active UI language', () => {
  const gitStatus = createGitStatus()

  const englishPrompt = buildAnalysisPrompt(gitStatus, 'en')
  assert.ok(englishPrompt.includes('must be written in English.'))

  const chinesePrompt = buildAnalysisPrompt(gitStatus, 'zh-CN')
  assert.ok(chinesePrompt.includes('必须使用简体中文。'))
})

test('parseAnalysisResult keeps a strategy when only some commit entries are malformed', () => {
  const raw = JSON.stringify({
    summary: '两个模块',
    strategies: [
      {
        label: '全部提交',
        description: '一次提交所有改动',
        commits: [
          { summary: 'feat: a', paths: ['src/a.ts'] },
          // 模型偷懒/截断产生的半截条目：只有 summary，没有 paths
          { summary: 'feat: b' },
          { summary: 'feat: c', paths: ['src/c.ts', 'src/d.ts'] },
        ],
      },
    ],
  })

  const result = parseAnalysisResult(raw)

  assert.ok(result)
  assert.equal(result.summary, '两个模块')
  assert.equal(result.strategies.length, 1)
  assert.deepEqual(
    result.strategies[0]?.commits,
    [
      { summary: 'feat: a', paths: ['src/a.ts'] },
      { summary: 'feat: c', paths: ['src/c.ts', 'src/d.ts'] },
    ],
  )
})

test('parseAnalysisResult drops commit entries whose paths are not a string array', () => {
  const raw = JSON.stringify({
    strategies: [
      {
        label: 'Core',
        description: 'core module',
        commits: [
          { summary: 'null element', paths: [null] },
          { summary: 'string instead of array', paths: 'src/a.ts' },
          { summary: 'nested array', paths: [['src/a.ts']] },
          { summary: 42, paths: ['src/a.ts'] },
          { summary: 'good', paths: ['src/good.ts'] },
        ],
      },
    ],
  })

  const result = parseAnalysisResult(raw)

  assert.ok(result)
  assert.equal(result.strategies.length, 1)
  assert.deepEqual(result.strategies[0]?.commits, [{ summary: 'good', paths: ['src/good.ts'] }])
})

test('parseAnalysisResult drops a strategy whose commit entries are all unusable, keeping the rest', () => {
  const raw = JSON.stringify({
    strategies: [
      { label: 'Good', description: 'ok', commits: [{ summary: 'feat: a', paths: ['src/a.ts'] }] },
      { label: 'Ghost', description: 'no usable commit', commits: [{ summary: 'feat: b' }] },
      { label: 'Empty', description: 'model returned no commits', commits: [] },
      { label: 'Not an object', description: 'x', commits: ['feat: c'] },
    ],
  })

  const result = parseAnalysisResult(raw)

  assert.ok(result)
  assert.deepEqual(result.strategies.map((strategy) => strategy.label), ['Good'])
})

test('parseAnalysisResult applies the same per-commit filtering to a bare strategy array', () => {
  // 注意：只放一条策略。多条时最外层那个贪婪的 /\{[\s\S]*\}/ 会先截出一段非法 JSON 并直接 return null，
  // 这条数组分支就根本走不到（那是 parseAnalysisResult 另一个既有缺陷，不在本次修复范围）。
  const raw = JSON.stringify([
    {
      label: 'Core',
      description: 'core module',
      commits: [{ summary: 'feat: a', paths: ['src/a.ts'] }, { summary: 'feat: b' }],
    },
  ])

  const result = parseAnalysisResult(raw)

  assert.ok(result)
  assert.equal(result.strategies.length, 1)
  assert.equal(result.strategies[0]?.label, 'Core')
  assert.deepEqual(result.strategies[0]?.commits, [{ summary: 'feat: a', paths: ['src/a.ts'] }])
})

test('parseAnalysisResult repairs a truncated stream and keeps the recovered commit', () => {
  // 真实的半截流：AI 输出在 paths 数组中间被掐断，必须真的走 repairTruncatedJson 才能解析
  const truncated =
    '{"strategies":[{"label":"全部提交","description":"一次提交所有改动","commits":[{"summary":"feat: a","paths":["src/a.ts","src/b.ts"'

  const result = parseAnalysisResult(truncated)

  assert.ok(result)
  assert.equal(result.strategies.length, 1)
  assert.deepEqual(result.strategies[0]?.commits, [
    { summary: 'feat: a', paths: ['src/a.ts', 'src/b.ts'] },
  ])
})

test('parseAnalysisResult falls back to raw text when repair only yields commits without paths', () => {
  // 截断更早：修好的对象里那条 commit 连 paths 都没有，整条策略没有任何可执行提交
  const truncated =
    '{"strategies":[{"label":"全部提交","description":"一次提交所有改动","commits":[{"summary":"feat: a"'

  const result = parseAnalysisResult(truncated)

  assert.ok(result)
  // 不能显示一张点了必然报错的空策略卡，宁可退回原始文本让用户看出这次是截断
  assert.equal(result.strategies.length, 0)
  assert.ok(result.summary.startsWith('{"strategies"'))
})

test('parseAnalysisResult leaves well-formed analysis untouched', () => {
  const raw = JSON.stringify({
    summary: 'Two modules changed.',
    strategies: [
      {
        label: 'Commit all',
        description: 'Single commit with everything',
        commits: [{ summary: 'chore: all', paths: ['src/a.ts', 'server/b.ts'] }],
      },
      {
        label: 'Server',
        description: 'Server module only',
        commits: [{ summary: 'fix: server', paths: ['server/b.ts'] }],
      },
    ],
  })

  const result = parseAnalysisResult(raw)

  assert.deepEqual(result, JSON.parse(raw))
})

test('GitAgentStrategyList hides commit summaries and file paths from suggestion cards', () => {
  const markup = renderToStaticMarkup(
    <GitAgentStrategyList
      data={{
        summary: 'Focus the review on desktop window controls and Git UX.',
        strategies: [
          {
            label: 'One focused batch',
            description: 'Keep the desktop shell and Git workflow changes together.',
            commits: [
              {
                summary: 'feat: enhance desktop window controls git tool flow and related regression coverage',
                paths: ['electron/main.ts', 'src/components/GitToolCard.tsx'],
              },
            ],
          },
        ],
      }}
      commitAllLabel="Commit all"
      commitPartialLabel="Partial commit"
      title="Agent suggestion"
      onExecute={() => undefined}
    />,
  )

  assert.match(markup, /Commit all/)
  assert.doesNotMatch(markup, /feat: enhance desktop window controls/)
  assert.doesNotMatch(markup, /electron\/main\.ts/)
  assert.doesNotMatch(markup, /src\/components\/GitToolCard\.tsx/)
})

test('settleGitAgentAnalysisStream closes the stream and clears pending refs', async () => {
  let fired = false
  let closed = 0
  const timeout = setTimeout(() => {
    fired = true
  }, 20)
  const streamSourceRef = {
    current: {
      close() {
        closed += 1
      },
    },
  }
  const timeoutRef = { current: timeout as ReturnType<typeof setTimeout> | null }
  const doneRef = { current: false }

  settleGitAgentAnalysisStream({
    streamSourceRef,
    timeoutRef,
    doneRef,
  })

  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(closed, 1)
  assert.equal(fired, false)
  assert.equal(doneRef.current, true)
  assert.equal(streamSourceRef.current, null)
  assert.equal(timeoutRef.current, null)
})

test('refreshGitAgentAnalysisTimeout extends the deadline when new stream activity arrives', async () => {
  let timedOut = 0
  const doneRef = { current: false }
  const timeoutRef = { current: null as ReturnType<typeof setTimeout> | null }

  refreshGitAgentAnalysisTimeout({
    timeoutRef,
    doneRef,
    timeoutMs: 25,
    onTimeout: () => {
      timedOut += 1
    },
  })

  await new Promise((resolve) => setTimeout(resolve, 10))

  refreshGitAgentAnalysisTimeout({
    timeoutRef,
    doneRef,
    timeoutMs: 25,
    onTimeout: () => {
      timedOut += 1
    },
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(timedOut, 0)

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(timedOut, 1)
  assert.equal(timeoutRef.current, null)
})
