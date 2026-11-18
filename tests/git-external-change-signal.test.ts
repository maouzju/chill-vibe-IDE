import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  gitWorkspacesOverlap,
  notifyGitWorkspaceMayHaveChanged,
  resolveExternalGitRefreshDelay,
  shouldSignalGitChangeForActivity,
  subscribeGitWorkspaceChange,
} from '../src/components/git-external-change-signal.ts'

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('a finished command in a chat session signals the Git card of the same workspace', () => {
  let hits = 0
  const unsubscribe = subscribeGitWorkspaceChange('D:\\Git\\chill-vibe', () => {
    hits += 1
  })

  // 同一个仓库，大小写 / 分隔符 / 末尾斜杠不同也要命中
  notifyGitWorkspaceMayHaveChanged('d:/git/chill-vibe/')
  assert.equal(hits, 1)

  // agent 在子目录里跑的会话，改的还是同一个仓库
  notifyGitWorkspaceMayHaveChanged('D:\\Git\\chill-vibe\\server')
  assert.equal(hits, 2)

  // 别的仓库不该打扰这张卡；前缀相同但不是同一目录也不算
  notifyGitWorkspaceMayHaveChanged('D:\\Git\\other')
  notifyGitWorkspaceMayHaveChanged('D:\\Git\\chill-vibe-2')
  notifyGitWorkspaceMayHaveChanged('   ')
  assert.equal(hits, 2)

  unsubscribe()
  notifyGitWorkspaceMayHaveChanged('D:\\Git\\chill-vibe')
  assert.equal(hits, 2)
})

test('gitWorkspacesOverlap only matches the same directory or a parent/child pair', () => {
  assert.equal(gitWorkspacesOverlap('D:\\a\\b', 'd:/a/b/'), true)
  assert.equal(gitWorkspacesOverlap('D:\\a', 'D:\\a\\b'), true)
  assert.equal(gitWorkspacesOverlap('D:\\a\\b', 'D:\\a'), true)
  assert.equal(gitWorkspacesOverlap('D:\\a\\b', 'D:\\a\\bc'), false)
  assert.equal(gitWorkspacesOverlap('', 'D:\\a'), false)
})

test('only settled commands signal a possible repository change', () => {
  const base = { itemId: 'c1', kind: 'command' as const, command: 'git commit -m x', output: '', exitCode: 0 }

  assert.equal(shouldSignalGitChangeForActivity({ ...base, status: 'in_progress' }), false)
  assert.equal(shouldSignalGitChangeForActivity({ ...base, status: 'completed' }), true)
  assert.equal(shouldSignalGitChangeForActivity({ ...base, status: 'failed' }), true)
  assert.equal(shouldSignalGitChangeForActivity({ kind: 'reasoning' }), false)
})

test('an external signal inside the throttle window is deferred, never dropped', () => {
  // 到期：立刻刷
  assert.equal(
    resolveExternalGitRefreshDelay({ now: 10_000, lastRefreshAt: 0, inFlight: false, throttleMs: 3000 }),
    0,
  )
  assert.equal(
    resolveExternalGitRefreshDelay({ now: 10_000, lastRefreshAt: 6_000, inFlight: false, throttleMs: 3000 }),
    0,
  )

  // 节流窗口内：等到窗口结束再刷，而不是像点击聚焦那样直接丢掉
  assert.equal(
    resolveExternalGitRefreshDelay({ now: 10_000, lastRefreshAt: 9_000, inFlight: false, throttleMs: 3000 }),
    2000,
  )

  // 上一发在途时读到的可能是提交前的状态，必须稍后重读
  const inFlightDelay = resolveExternalGitRefreshDelay({
    now: 10_000,
    lastRefreshAt: 1_000,
    inFlight: true,
    throttleMs: 3000,
  })
  assert.ok(inFlightDelay > 0)
})

test('the app and the Git card are wired to the external change signal', () => {
  const appSource = readSource('../src/App.tsx')
  const cardSource = readSource('../src/components/GitToolCard.tsx')

  assert.match(appSource, /shouldSignalGitChangeForActivity\(payload\)/)
  assert.ok(
    (appSource.match(/notifyGitWorkspaceMayHaveChanged\(/g) ?? []).length >= 2,
    'both finished commands and turn completion must signal the Git card',
  )
  assert.match(cardSource, /subscribeGitWorkspaceChange\(/)
  assert.match(cardSource, /addEventListener\('focus'/)
})
