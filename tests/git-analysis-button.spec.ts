import { expect, test, type Page } from '@playwright/test'

import type { AppLanguage, GitStatus } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const createGitStatus = (): GitStatus => ({
  workspacePath: 'd:\\Git\\chill-vibe',
  isRepository: true,
  repoRoot: 'd:\\Git\\chill-vibe',
  branch: 'feature/git-analysis-button',
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
      addedLines: 3,
      removedLines: 1,
      patch: '@@ -1 +1 @@\n-old line\n+new line',
    },
  ],
  lastCommit: {
    hash: 'abc1234def5678',
    shortHash: 'abc1234',
    summary: 'Add Git analysis button coverage',
    description: '',
    authorName: 'Alex',
    authoredAt: '2026-04-11T03:00:00.000Z',
  },
})

const installMockApis = async (page: Page, language: AppLanguage = 'zh-CN') => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language,
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
        title: 'Git Analysis Test',
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

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({ json: createGitStatus() })
  })
}

test('git analysis button switches to a disabled analyzing state while the agent request is running', async ({
  page,
}) => {
  await installMockApis(page)
  await page.goto('http://localhost:5173')

  await page.evaluate(() => {
    const win = window as typeof window & {
      electronAPI: NonNullable<typeof window.electronAPI>
    }

    win.electronAPI.requestChat = async () => ({ streamId: 'git-analysis-stream' })
    win.electronAPI.stopChat = async () => undefined
    win.electronAPI.subscribeChatStream = async () => undefined
    win.electronAPI.unsubscribeChatStream = async () => undefined
  })

  const launcher = page.locator('.chat-empty-tool-button').filter({ hasText: 'Git' }).first()
  await expect(launcher).toBeVisible()
  await launcher.click()

  await expect(page.locator('.git-tool-card')).toBeVisible()
  await page.getByRole('button', { name: '分析改动' }).click()

  await expect(page.locator('.git-agent-loading')).toBeVisible()
  await expect(page.getByRole('button', { name: '正在分析', exact: true })).toBeDisabled()
})
