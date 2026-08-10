import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import type { GitStatus } from '../shared/schema.ts'
import {
  gitStatusRefreshThrottleMs,
  mergeGitStatusPreservingPreviews,
  needsFullGitStatusFetch,
  resolveGitStatusFidelity,
  resolveGitStatusRefreshPlan,
  shouldRefreshGitStatus,
} from '../src/components/git-status-previews.ts'

const gitToolCardSource = readFileSync(
  fileURLToPath(new URL('../src/components/GitToolCard.tsx', import.meta.url)),
  'utf8',
)

const workspacePath = 'D:\\Git\\chill-vibe'

const createFullStatus = (overrides?: Partial<GitStatus>): GitStatus => ({
  workspacePath,
  repoRoot: workspacePath,
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
      patch: '@@ -1,2 +1,4 @@\n-old\n+new',
    },
  ],
  lastCommit: null,
  ...overrides,
})

/** 主进程 fetchGitStatusPreview 的返回：只有状态位，changes 上完全没有 patch 字段。 */
const createPreviewStatus = (overrides?: Partial<GitStatus>): GitStatus => ({
  ...createFullStatus(),
  changes: [
    {
      path: 'src/components/GitToolCard.tsx',
      kind: 'modified',
      stagedStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
      conflicted: false,
    },
  ],
  ...overrides,
})

// ── 节流 + in-flight 去重 ────────────────────────────────────────────────────

test('shouldRefreshGitStatus allows the first refresh and throttles bursts inside the window', () => {
  assert.equal(gitStatusRefreshThrottleMs, 3000)

  const first = shouldRefreshGitStatus({ now: 10_000, lastRefreshAt: 0, inFlight: false })
  assert.equal(first.shouldRefresh, true)

  const immediateRepeat = shouldRefreshGitStatus({
    now: 10_500,
    lastRefreshAt: 10_000,
    inFlight: false,
  })
  assert.equal(immediateRepeat.shouldRefresh, false)
  assert.equal(immediateRepeat.reason, 'throttled')

  const afterWindow = shouldRefreshGitStatus({
    now: 13_000,
    lastRefreshAt: 10_000,
    inFlight: false,
  })
  assert.equal(afterWindow.shouldRefresh, true)
})

test('shouldRefreshGitStatus refuses to stack a second request while one is in flight', () => {
  // 节流窗口早就过了，但上一发请求还挂在主进程上 —— 这正是卡顿现场：
  // 3 秒的 git 全量刷新回来之前，不许再压一发进去。
  const decision = shouldRefreshGitStatus({
    now: 60_000,
    lastRefreshAt: 10_000,
    inFlight: true,
  })

  assert.equal(decision.shouldRefresh, false)
  assert.equal(decision.reason, 'in-flight')
})

test('shouldRefreshGitStatus never fires without a workspace', () => {
  const decision = shouldRefreshGitStatus({
    now: 60_000,
    lastRefreshAt: 0,
    inFlight: false,
    hasWorkspace: false,
  })

  assert.equal(decision.shouldRefresh, false)
  assert.equal(decision.reason, 'no-workspace')
})

test('rapid tab switching collapses into a single git pipeline run', () => {
  let lastRefreshAt = 0
  let inFlight = false
  let fired = 0

  // 用户在 6 个 tab 之间来回点，每次激活都走同一个节流时钟。
  for (const now of [1_000, 1_200, 1_400, 1_900, 2_400, 2_900]) {
    const decision = shouldRefreshGitStatus({ now, lastRefreshAt, inFlight })
    if (decision.shouldRefresh) {
      fired += 1
      lastRefreshAt = now
      inFlight = true
    }
  }

  assert.equal(fired, 1)
})

// ── preview / full 选路 ──────────────────────────────────────────────────────

test('resolveGitStatusRefreshPlan keeps automatic refreshes on the cheap preview path', () => {
  const warmAuto = resolveGitStatusRefreshPlan({ trigger: 'auto', hasStatusForWorkspace: true })
  assert.deepEqual(warmAuto, { preview: true, full: false })
})

test('resolveGitStatusRefreshPlan still hydrates a cold card with the full status once', () => {
  const coldAuto = resolveGitStatusRefreshPlan({ trigger: 'auto', hasStatusForWorkspace: false })
  assert.deepEqual(coldAuto, { preview: true, full: true })
})

test('resolveGitStatusRefreshPlan gives explicit and consumer triggers the full status', () => {
  assert.deepEqual(
    resolveGitStatusRefreshPlan({ trigger: 'manual', hasStatusForWorkspace: true }),
    { preview: false, full: true },
  )
  assert.deepEqual(
    resolveGitStatusRefreshPlan({ trigger: 'consumer', hasStatusForWorkspace: true }),
    { preview: false, full: true },
  )
})

// ── patch 保活 + 消费方兜底 ─────────────────────────────────────────────────

test('a preview refresh keeps the previously fetched patches on screen', () => {
  const previous = createFullStatus()
  const preview = createPreviewStatus({
    summary: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    changes: [
      {
        path: 'src/components/GitToolCard.tsx',
        kind: 'modified',
        stagedStatus: 'M',
        workingTreeStatus: ' ',
        staged: true,
        conflicted: false,
      },
    ],
  })

  const merged = mergeGitStatusPreservingPreviews(previous, preview)

  assert.equal(merged.changes[0]?.staged, true, 'preview 的新状态位要生效')
  assert.equal(merged.changes[0]?.patch, previous.changes[0]?.patch, 'patch 不许被 preview 清空')
  assert.equal(merged.changes[0]?.addedLines, 12)
})

test('resolveGitStatusFidelity separates preview payloads from full ones', () => {
  assert.equal(resolveGitStatusFidelity(createFullStatus()), 'full')
  assert.equal(resolveGitStatusFidelity(createPreviewStatus()), 'preview')
  assert.equal(resolveGitStatusFidelity(null), 'preview')
  // 全量抓取里超预算的大文件会拿到空字符串 patch，那仍然是全量结果。
  assert.equal(
    resolveGitStatusFidelity(
      createFullStatus({
        changes: [{ ...createFullStatus().changes[0]!, patch: '' }],
      }),
    ),
    'full',
  )
  // 干净仓库没有 changes，没有 patch 可拿，不该被判成 preview 而无限重抓。
  assert.equal(
    resolveGitStatusFidelity(createFullStatus({ clean: true, changes: [] })),
    'full',
  )
})

test('patch consumers refetch after an automatic preview refresh', () => {
  const previous = createFullStatus()
  const merged = mergeGitStatusPreservingPreviews(previous, createPreviewStatus())

  // 合并回来的 patch 让 status 看着"完整"，但它是上一轮的旧内容 ——
  // 分析变更 / 全屏对话框必须重新抓一次全量，不能拿旧 diff 去喂 AI。
  assert.equal(
    needsFullGitStatusFetch({
      status: merged,
      workspacePath,
      trackedFidelity: 'preview',
    }),
    true,
  )
})

test('patch consumers skip the refetch when the card already holds a full status', () => {
  assert.equal(
    needsFullGitStatusFetch({
      status: createFullStatus(),
      workspacePath,
      trackedFidelity: 'full',
    }),
    false,
  )
})

test('patch consumers refetch when a lightweight status arrives from a background operation', () => {
  // 后台 stage/commit 操作回写的 status 走的是 includeChangePreviews:false，
  // 即使调用方以为自己拿到的是"最新"，里面也一个 patch 都没有。
  assert.equal(
    needsFullGitStatusFetch({
      status: createPreviewStatus(),
      workspacePath,
      trackedFidelity: 'full',
    }),
    true,
  )
})

test('patch consumers refetch when the status belongs to another workspace or is missing', () => {
  assert.equal(
    needsFullGitStatusFetch({ status: null, workspacePath, trackedFidelity: 'full' }),
    true,
  )
  assert.equal(
    needsFullGitStatusFetch({
      status: createFullStatus({ workspacePath: 'D:\\Git\\other' }),
      workspacePath,
      trackedFidelity: 'full',
    }),
    true,
  )
})

test('patch consumers do not refetch for a non-repository workspace', () => {
  assert.equal(
    needsFullGitStatusFetch({
      status: createFullStatus({ isRepository: false, clean: true, changes: [] }),
      workspacePath,
      trackedFidelity: 'full',
    }),
    false,
  )
})

// ── 组件接线守卫 ────────────────────────────────────────────────────────────

test('hovering the git card no longer kicks off the main-process git pipeline', () => {
  assert.ok(
    !/onMouseEnter\s*=/.test(gitToolCardSource),
    '鼠标划过卡片不许触发 git 刷新：onMouseEnter 必须从 GitToolCard 上消失',
  )
})

test('the tab-activation effect goes through the throttled requester', () => {
  const activationEffect = /if \(!isActive\) \{\s*return\s*\}\s*([\s\S]{0,200}?)\n\s*\}, \[isActive/.exec(
    gitToolCardSource,
  )

  assert.ok(activationEffect, '没找到 isActive 激活 effect')
  assert.ok(
    /requestAutoRefresh/.test(activationEffect![1] ?? ''),
    'tab 激活必须走 requestAutoRefresh（含节流 + in-flight 去重），不能裸调 refreshStatus',
  )
})

test('the card wires focus to the throttled requester and keeps a consumer-side full fetch', () => {
  assert.ok(/onFocus=\{handleCardFocus\}/.test(gitToolCardSource), 'onFocus 仍然保留')
  assert.ok(
    /ensureFullGitStatus/.test(gitToolCardSource),
    'patch 消费方入口必须有按需全量拉取',
  )
})
