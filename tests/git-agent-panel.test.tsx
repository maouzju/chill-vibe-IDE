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
import { buildAnalysisPrompt } from '../src/components/git-agent-panel-utils.ts'

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

test('buildAnalysisPrompt requires human-readable output in the active UI language', () => {
  const gitStatus = createGitStatus()

  const englishPrompt = buildAnalysisPrompt(gitStatus, 'en')
  assert.ok(englishPrompt.includes('must be written in English.'))

  const chinesePrompt = buildAnalysisPrompt(gitStatus, 'zh-CN')
  assert.ok(chinesePrompt.includes('必须使用简体中文。'))
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
