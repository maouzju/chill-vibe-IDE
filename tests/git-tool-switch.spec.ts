import { expect, test, type Locator, type Page } from '@playwright/test'

import { GIT_TOOL_MODEL } from '../shared/models.ts'
import type { AppLanguage, GitChange, GitStatus } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const selectModel = async (page: Page, trigger: Locator, label: string) => {
  if (label === 'Git') {
    const launcher = page.locator('.chat-empty-tool-button').filter({ hasText: label }).first()
    await expect(launcher).toBeVisible()
    await launcher.click()
    return
  }

  await trigger.click({ force: true })
  const option = page.locator('.model-dropdown-option').filter({ hasText: label }).first()
  await expect(option).toBeVisible()
  await option.click()
}

const createBaseGitStatus = (overrides: Record<string, unknown> = {}) => ({
  workspacePath: 'd:\\Git\\chill-vibe',
  isRepository: true,
  repoRoot: 'd:\\Git\\chill-vibe',
  branch: 'feature/git-tool-switch',
  upstream: 'origin/main',
  ahead: 0,
  behind: 1,
  hasConflicts: false,
  clean: false,
  summary: {
    staged: 0,
    unstaged: 1,
    untracked: 0,
    conflicted: 0,
  },
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
  lastCommit: {
    hash: 'abc1234def5678',
    shortHash: 'abc1234',
    summary: 'Add git tool switch regression coverage',
    description: '',
    authorName: 'Alex',
    authoredAt: '2026-04-05T03:00:00.000Z',
  },
  ...overrides,
})

const createGitChange = (path: string, overrides: Partial<GitChange> = {}): GitChange => ({
  path,
  kind: 'modified',
  stagedStatus: ' ',
  workingTreeStatus: 'M',
  staged: false,
  conflicted: false,
  addedLines: 1,
  removedLines: 1,
  patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old line\n+new line`,
  ...overrides,
})

const summarizeChanges = (changes: GitChange[]) =>
  changes.reduce(
    (summary, change) => {
      if (change.conflicted) {
        summary.conflicted += 1
      }

      if (change.kind === 'untracked') {
        summary.untracked += 1
      } else if (change.workingTreeStatus !== ' ' && !change.conflicted) {
        summary.unstaged += 1
      }

      if (change.staged) {
        summary.staged += 1
      }

      return summary
    },
    {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
  )

const createGitStatus = (changes: GitChange[], overrides: Partial<GitStatus> = {}): GitStatus =>
  createBaseGitStatus({
    changes,
    clean: changes.length === 0,
    summary: summarizeChanges(changes),
    ...overrides,
  }) as GitStatus

const applyStageState = (change: GitChange, staged: boolean): GitChange => {
  if (!staged) {
    return {
      ...change,
      staged: false,
      stagedStatus: ' ',
      workingTreeStatus: change.kind === 'untracked' ? '?' : 'M',
    }
  }

  return {
    ...change,
    staged: true,
    stagedStatus: change.kind === 'untracked' || change.kind === 'added' ? 'A' : 'M',
    workingTreeStatus: ' ',
  }
}

test('non-repo Git cards offer a create-repository action and recover into repo mode', async ({ page }) => {
  await installMockApis(page, 'light')

  let currentStatus = createBaseGitStatus({
    isRepository: false,
    repoRoot: '',
    branch: '',
    upstream: undefined,
    ahead: 0,
    behind: 0,
    hasConflicts: false,
    clean: true,
    summary: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    changes: [],
    lastCommit: null,
    description: '',
    note: 'This workspace is not a Git repository yet.',
  }) as GitStatus
  const initRequests: string[] = []

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({ json: currentStatus })
  })

  await page.route('**/api/git/init', async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as { workspacePath?: string }
    initRequests.push(request.workspacePath ?? '')
    currentStatus = createGitStatus([
      createGitChange('README.md', {
        kind: 'untracked',
        stagedStatus: '?',
        workingTreeStatus: '?',
        addedLines: 1,
        removedLines: 0,
        patch: '@@ -0,0 +1 @@\n+# Hello',
      }),
    ], {
      branch: 'main',
      upstream: undefined,
      lastCommit: null,
      note: undefined,
    })

    await route.fulfill({
      json: {
        status: currentStatus,
        message: 'Created a new Git repository.',
      },
    })
  })

  await page.goto('http://localhost:5173')

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.waitFor()
  await selectModel(page, modelSelect, 'Git')

  const createButton = page.getByRole('button', { name: 'Create Git Repository' })
  await expect(createButton).toBeVisible()
  await createButton.click()

  await expect.poll(() => initRequests).toEqual(['d:\\Git\\chill-vibe'])
  await expect(createButton).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Analyze changes' })).toBeVisible()
  await expect(page.getByText('README.md')).toBeVisible()
})

const installMockApis = async (page: Page, theme: ThemeName, language: AppLanguage = 'en') => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language,
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: {
          activeProfileId: '',
          profiles: [],
        },
        claude: {
          activeProfileId: '',
          profiles: [],
        },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Git Flow Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: () => false,
    })
  })

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({ status: 204 })
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })
  })

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      json: {
        state: 'idle',
        logs: [],
      },
    })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

}

test('full git opens without auto-staging and still seeds a default commit summary', async ({ page }) => {
  await installMockApis(page, 'dark', 'zh-CN')

  const initialChange = createGitChange('src/components/GitToolCard.tsx', {
    patch: '@@ -1 +1 @@\n-old line\n+initial change',
  })
  const laterChange = createGitChange('src/components/GitFullDialog.tsx', {
    patch: '@@ -1 +1 @@\n-old line\n+later change',
  })

  let status = createGitStatus([initialChange], {
    branch: 'feature/full-git-open-defaults',
    lastCommit: {
      hash: 'def1234abc5678',
      shortHash: 'def1234',
      summary: 'Keep Full Git defaults predictable',
      description: '',
      authorName: 'Alex',
      authoredAt: '2026-04-06T03:00:00.000Z',
    },
  })
  const stageCalls: string[][] = []

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({ json: status })
  })

  await page.route('**/api/git/stage', async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      paths: string[]
      staged: boolean
    }
    const targetedPaths = new Set(request.paths)

    stageCalls.push([...request.paths])
    status = createGitStatus(
      status.changes.map((change) =>
        targetedPaths.has(change.path) ? applyStageState(change, request.staged) : change,
      ),
      {
        branch: status.branch,
        lastCommit: status.lastCommit ?? null,
      },
    )

    await route.fulfill({ json: status })
  })

  await page.goto('http://localhost:5173')

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.waitFor()
  await selectModel(page, modelSelect, 'Git')

  await page.getByRole('button', { name: '古法 Git' }).click()

  await expect.poll(() => stageCalls.length).toBe(0)
  await expect(page.locator('.git-commit-summary')).toHaveValue('提交信息')
  await page.getByRole('button', { name: '关闭' }).click()

  status = createGitStatus([applyStageState(initialChange, true), laterChange], {
    branch: 'feature/full-git-open-defaults',
    lastCommit: status.lastCommit ?? null,
  })

  await page.getByRole('button', { name: '古法 Git' }).click()

  await expect.poll(() => stageCalls.length).toBe(0)
  await expect(page.locator('.git-commit-summary')).toHaveValue('提交信息')
})

test('git sync retries through conflict resolution when pull leaves merge conflicts', async ({ page }) => {
  await installMockApis(page, 'dark')
  await page.goto('http://localhost:5173')

  await page.evaluate(() => {
    const win = window as typeof window & {
      __gitSyncTestState: {
        requestCalls: number
        pushCalls: number
        prompt: string
      }
      electronAPI: NonNullable<typeof window.electronAPI>
    }

    const dispatchStreamEvent = (subscriptionId: string, eventName: string, data: unknown) => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:chat-stream', {
          detail: {
            subscriptionId,
            event: eventName,
            data,
          },
        }),
      )
    }

    const createStatus = (overrides = {}) => ({
      workspacePath: 'd:\\Git\\chill-vibe',
      isRepository: true,
      repoRoot: 'd:\\Git\\chill-vibe',
      branch: 'feature/git-tool-switch',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      hasConflicts: false,
      clean: false,
      summary: {
        staged: 0,
        unstaged: 1,
        untracked: 0,
        conflicted: 0,
      },
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
      lastCommit: {
        hash: 'abc1234def5678',
        shortHash: 'abc1234',
        summary: 'Add git tool switch regression coverage',
        description: '',
        authorName: 'Alex',
        authoredAt: '2026-04-05T03:00:00.000Z',
      },
      ...overrides,
    })

    const conflictStatus = createStatus({
      behind: 0,
      hasConflicts: true,
      summary: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 1,
      },
      changes: [
        {
          path: 'src/components/GitToolCard.tsx',
          kind: 'modified',
          stagedStatus: 'U',
          workingTreeStatus: 'U',
          staged: false,
          conflicted: true,
        },
      ],
    })
    const resolvedStatus = {
      ...conflictStatus,
      ahead: 1,
      hasConflicts: false,
      clean: true,
      summary: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
      },
      changes: [],
    }
    const pushedStatus = {
      ...resolvedStatus,
      ahead: 0,
      behind: 0,
    }
    let currentStatus = createStatus()

    win.__gitSyncTestState = {
      requestCalls: 0,
      pushCalls: 0,
      prompt: '',
    }

    win.electronAPI.fetchGitStatus = async () => JSON.parse(JSON.stringify(currentStatus))
    win.electronAPI.pullGitChanges = async () => {
      currentStatus = conflictStatus
      throw new Error('Automatic merge failed; fix conflicts and then commit the result.')
    }
    win.electronAPI.requestChat = async (request) => {
      win.__gitSyncTestState.requestCalls += 1
      win.__gitSyncTestState.prompt = request.prompt
      return { streamId: 'git-sync-stream' }
    }
    win.electronAPI.stopChat = async () => undefined
    win.electronAPI.subscribeChatStream = async (_streamId, subscriptionId) => {
      window.setTimeout(() => {
        currentStatus = resolvedStatus
        dispatchStreamEvent(subscriptionId, 'done', {})
      }, 30)
    }
    win.electronAPI.unsubscribeChatStream = async () => undefined
    win.electronAPI.pushGitChanges = async () => {
      win.__gitSyncTestState.pushCalls += 1
      currentStatus = pushedStatus
      return {
        status: pushedStatus,
        message: 'Everything up-to-date.',
      }
    }
  })

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.waitFor()
  await selectModel(page, modelSelect, 'Git')

  await expect(page.locator('.git-tool-card')).toBeVisible()
  await page.getByRole('button', { name: 'Sync' }).click()

  await expect.poll(() =>
    page.evaluate(() => (window as typeof window & {
      __gitSyncTestState: { requestCalls: number }
    }).__gitSyncTestState.requestCalls),
  ).toBe(1)
  await expect.poll(() =>
    page.evaluate(() => (window as typeof window & {
      __gitSyncTestState: { pushCalls: number }
    }).__gitSyncTestState.pushCalls),
  ).toBe(1)
  await expect.poll(() =>
    page.evaluate(() => (window as typeof window & {
      __gitSyncTestState: { prompt: string }
    }).__gitSyncTestState.prompt),
  ).toContain('complete the merge commit')
  await expect(page.locator('.git-agent-panel .git-tool-notice.is-success')).toBeVisible()
})

test('git sync disables analysis while the sync panel is open', async ({ page }) => {
  await installMockApis(page, 'dark')
  await page.goto('http://localhost:5173')

  await page.evaluate(() => {
    const win = window as typeof window & {
      electronAPI: NonNullable<typeof window.electronAPI>
    }
    const gitStatus = {
      workspacePath: 'd:\\Git\\chill-vibe',
      isRepository: true,
      repoRoot: 'd:\\Git\\chill-vibe',
      branch: 'feature/git-tool-switch',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      hasConflicts: false,
      clean: false,
      summary: {
        staged: 0,
        unstaged: 1,
        untracked: 0,
        conflicted: 0,
      },
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
      lastCommit: {
        hash: 'abc1234def5678',
        shortHash: 'abc1234',
        summary: 'Add git tool switch regression coverage',
        description: '',
        authorName: 'Alex',
        authoredAt: '2026-04-05T03:00:00.000Z',
      },
    }

    win.electronAPI.fetchGitStatus = async () => JSON.parse(JSON.stringify(gitStatus))
    let pullCalls = 0
    win.electronAPI.pullGitChanges = async () => {
      pullCalls += 1

      if (pullCalls === 1) {
        throw new Error('Open the sync panel.')
      }

      return new Promise(() => undefined)
    }
  })

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.waitFor()
  await selectModel(page, modelSelect, 'Git')

  await expect(page.locator('.git-tool-card')).toBeVisible()
  await page.getByRole('button', { name: 'Sync' }).click()

  await expect(page.locator('.git-agent-loading')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Analyze changes' })).toBeDisabled()
})

test('commit new one-click commits only changes since the last git snapshot', async ({ page }) => {
  await installMockApis(page, 'dark')

  const oldChange = createGitChange('src/components/GitToolCard.tsx', {
    patch: '@@ -1 +1 @@\n-old line\n+old change',
  })
  const newChange = createGitChange('src/components/GitFullDialog.tsx', {
    patch: '@@ -1 +1 @@\n-old line\n+new change',
  })

  let status = createGitStatus([oldChange], {
    branch: 'feature/commit-new-scope',
    lastCommit: {
      hash: '4567abcde89012',
      shortHash: '4567abc',
      summary: 'Record the previous Git snapshot',
      description: '',
      authorName: 'Alex',
      authoredAt: '2026-04-07T03:00:00.000Z',
    },
  })
  const stageCalls: Array<{ paths: string[]; staged: boolean }> = []
  const commitCalls: Array<{ summary: string; description?: string; paths?: string[] }> = []

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({ json: status })
  })

  await page.route('**/api/git/stage', async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      paths: string[]
      staged: boolean
    }
    const targetedPaths = new Set(request.paths)

    stageCalls.push({ paths: [...request.paths], staged: request.staged })
    status = createGitStatus(
      status.changes.map((change) =>
        targetedPaths.has(change.path) ? applyStageState(change, request.staged) : change,
      ),
      {
        branch: status.branch,
        lastCommit: status.lastCommit ?? null,
      },
    )

    await route.fulfill({ json: status })
  })

  await page.route('**/api/git/commit', async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      summary: string
      description?: string
      paths?: string[]
    }

    commitCalls.push(request)

    status = createGitStatus(
      [applyStageState(oldChange, true)],
      {
        branch: status.branch,
        lastCommit: {
          hash: '9999aaaabbbbcccc',
          shortHash: '9999aaa',
          summary: request.summary,
          description: request.description ?? '',
          authorName: 'Alex',
          authoredAt: '2026-04-08T03:00:00.000Z',
        },
      },
    )

    await route.fulfill({
      json: {
        status,
        commit: status.lastCommit,
      },
    })
  })

  await page.goto('http://localhost:5173')

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.waitFor()
  await selectModel(page, modelSelect, 'Git')

  await page.getByRole('button', { name: 'Full Git' }).click()
  await expect.poll(() => stageCalls.length).toBe(0)
  await page.locator('.git-full-close-button').click()

  status = createGitStatus([applyStageState(oldChange, true), newChange], {
    branch: 'feature/commit-new-scope',
    lastCommit: status.lastCommit ?? null,
  })

  await page.getByRole('button', { name: 'Commit new' }).click()

  await expect.poll(() => stageCalls.length).toBe(1)
  await expect.poll(() => stageCalls.at(-1)?.paths.join(',') ?? '').toBe(newChange.path)
  await expect.poll(() => commitCalls.length).toBe(1)
  await expect.poll(() => commitCalls.at(0)?.paths?.join(',') ?? '').toBe(newChange.path)
  await expect.poll(() => commitCalls.at(0)?.summary ?? '').toBe('Update GitFullDialog.tsx')
  await expect(page.locator('.structured-preview-dialog.is-git-full')).toHaveCount(0)
  await expect(page.locator('.git-dashboard-file-item')).toHaveText([oldChange.path])
})

test('git dashboard buttons show delayed tooltips and keep commit new as a one-click action', async ({ page }) => {
  await installMockApis(page, 'dark')

  const oldChange = createGitChange('src/components/GitToolCard.tsx', {
    patch: '@@ -1 +1 @@\n-old line\n+old change',
  })
  const newChange = createGitChange('src/components/GitFullDialog.tsx', {
    patch: '@@ -1 +1 @@\n-old line\n+new change',
  })

  let status = createGitStatus([oldChange], {
    branch: 'feature/commit-new-tooltips',
    lastCommit: {
      hash: 'abcd1234ef567890',
      shortHash: 'abcd123',
      summary: 'Record the previous Git snapshot',
      description: '',
      authorName: 'Alex',
      authoredAt: '2026-04-07T03:00:00.000Z',
    },
  })
  const commitCalls: Array<{ summary: string; description?: string; paths?: string[] }> = []

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({ json: status })
  })

  await page.route('**/api/git/stage', async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      paths: string[]
      staged: boolean
    }
    const targetedPaths = new Set(request.paths)

    status = createGitStatus(
      status.changes.map((change) =>
        targetedPaths.has(change.path) ? applyStageState(change, request.staged) : change,
      ),
      {
        branch: status.branch,
        lastCommit: status.lastCommit ?? null,
      },
    )

    await route.fulfill({ json: status })
  })

  await page.route('**/api/git/commit', async (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as {
      summary: string
      description?: string
      paths?: string[]
    }

    commitCalls.push(request)
    status = createGitStatus([applyStageState(oldChange, true)], {
      branch: status.branch,
      lastCommit: {
        hash: 'bbbb1111cccc2222',
        shortHash: 'bbbb111',
        summary: request.summary,
        description: request.description ?? '',
        authorName: 'Alex',
        authoredAt: '2026-04-08T05:00:00.000Z',
      },
    })

    await route.fulfill({
      json: {
        status,
        commit: status.lastCommit,
      },
    })
  })

  await page.goto('http://localhost:5173')

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.waitFor()
  await selectModel(page, modelSelect, 'Git')

  for (const [label, snippet] of [
    ['Analyze changes', 'review the current changes'],
    ['Commit new', 'One-click commit files changed since the last Git snapshot'],
    ['Sync', 'Pull remote changes'],
    ['Full Git', 'full Git view'],
  ] as const) {
    const button = page.getByRole('button', { name: label })
    await button.hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.waitForTimeout(520)
    await expect(page.getByRole('tooltip')).toContainText(snippet)
  }

  await page.getByRole('button', { name: 'Full Git' }).click()
  await page.locator('.git-full-close-button').click()

  status = createGitStatus([applyStageState(oldChange, true), newChange], {
    branch: 'feature/commit-new-tooltips',
    lastCommit: status.lastCommit ?? null,
  })

  await page.getByRole('button', { name: 'Commit new' }).click()
  await expect.poll(() => commitCalls.length).toBe(1)
  await expect.poll(() => commitCalls.at(0)?.summary ?? '').toBe('Update GitFullDialog.tsx')
  await expect(page.locator('.structured-preview-dialog.is-git-full')).toHaveCount(0)
})

test('inactive pane-mounted Git tabs defer status fetch until activated', async ({ page }) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: {
          activeProfileId: '',
          profiles: [],
        },
        claude: {
          activeProfileId: '',
          profiles: [],
        },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Git Pane Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Git 1',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: GIT_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
          {
            id: 'card-2',
            title: 'Git 2',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: GIT_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })

  let gitStatusRequests = 0

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({ status: 204 })
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })
  })

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      json: {
        state: 'idle',
        logs: [],
      },
    })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    gitStatusRequests += 1
    await route.fulfill({ json: createBaseGitStatus() })
  })

  await page.goto('http://localhost:5173')

  await page.locator('.pane-tab.is-active').filter({ hasText: 'Git' }).waitFor()
  await page.locator('.git-tool-card').first().waitFor()
  await expect.poll(() => gitStatusRequests).toBe(1)

  await page.locator('.pane-tab').nth(1).click()
  await page.locator('.pane-tab.is-active').nth(0).waitFor()
  await expect.poll(() => gitStatusRequests).toBe(2)
})

for (const theme of ['dark', 'light'] as const) {
  test(`switching a card to Git reveals git controls in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)

    let gitStatusRequests = 0

    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      gitStatusRequests += 1
      await route.fulfill({
        json: createBaseGitStatus({
          ahead: 1,
          behind: 0,
          summary: {
            staged: 1,
            unstaged: 0,
            untracked: 1,
            conflicted: 0,
          },
          changes: [
            {
              path: 'src/components/GitToolCard.tsx',
              kind: 'modified',
              stagedStatus: 'M',
              workingTreeStatus: ' ',
              staged: true,
              conflicted: false,
            },
            {
              path: 'tests/git-tool-switch.spec.ts',
              kind: 'untracked',
              stagedStatus: '?',
              workingTreeStatus: '?',
              staged: false,
              conflicted: false,
            },
          ],
        }),
      })
    })

    await page.goto('http://localhost:5173')

    const modelSelect = page.locator('.model-select').first()
    const syncButton = page.locator('.git-dashboard-actions-inline .git-tool-button').filter({ hasText: 'Sync' })

    await modelSelect.waitFor()
    await expect(page.locator('.git-tool-card')).toHaveCount(0)
    await expect(page.locator('.composer textarea')).toHaveCount(1)

    await selectModel(page, modelSelect, 'Git')

    await expect(page.locator('.git-tool-card')).toBeVisible()
    await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Git')
    await expect.poll(() => gitStatusRequests).toBeGreaterThan(0)

    await page.reload()

    await expect(page.locator('.git-tool-card')).toBeVisible()
    await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Git')
    await expect(page.getByText('feature/git-tool-switch')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: 'Analyze changes' })).toBeVisible()
    await expect(syncButton).toBeVisible()
    await expect(page.locator('.git-sync-counts')).toContainText('1')
    await expect(page.getByRole('button', { name: 'Full Git' })).toBeVisible()
    await expect(page.locator('.composer textarea')).toHaveCount(0)
  })

  test(`switching a card to Git hides sync controls when no upstream exists in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)

    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      await route.fulfill({
        json: createBaseGitStatus({
          upstream: undefined,
          behind: 0,
        }),
      })
    })

    await page.goto('http://localhost:5173')

    const modelSelect = page.locator('.model-select').first()
    const syncButton = page.locator('.git-dashboard-actions-inline .git-tool-button').filter({ hasText: 'Sync' })

    await modelSelect.waitFor()
    await selectModel(page, modelSelect, 'Git')

    await expect(page.locator('.git-tool-card')).toBeVisible()
    await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Git')
    await expect(syncButton).toHaveCount(0)
    await expect(page.locator('.git-sync-counts')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Analyze changes' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Full Git' })).toBeVisible()
  })

  test(`switching a card to Editor without a file keeps a visible empty state in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)

    await page.goto('http://localhost:5173')

    const modelSelect = page.locator('.model-select').first()

    await modelSelect.waitFor()
    await selectModel(page, modelSelect, 'Editor')

    await expect(page.locator('.text-editor-card')).toBeVisible()
    await expect(page.locator('.text-editor-empty')).toBeVisible()
    await expect(page.locator('.text-editor-empty-title')).toBeVisible()
    await expect(page.locator('.text-editor-empty-description')).toBeVisible()
    await expect(page.locator('.composer textarea')).toHaveCount(0)
  })
}
