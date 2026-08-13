import { expect, test, type Page } from '@playwright/test'

import type { GitStatus } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

// 2026-08-13 用户实拍：Git 卡红色横幅里只有 `git commit ... timed out after 120000ms
// and was killed.` 一句，没有任何可据以判断的原因。后端这一轮改成把 git 自己吐的原因
// （`gpg: signing failed` 之类）和被 kill 后残留的 index.lock 处置说明一并带上——这是
// 一条多行消息。HTML 默认把换行折成空格，横幅若不保留换行，后端带出来的东西会被挤成
// 一坨，等于白带。这条钉住"多行报错真的占多行"。
const timedOutCommitMessage = [
  'git commit -m 更新 294 个文件 --only --pathspec-from-file=- --pathspec-file-nul timed out after 600000ms and was killed.',
  'error: gpg failed to sign the data',
  'The killed git process left D:\\Git\\sample-repo\\.git\\index.lock behind — every later git command will fail.',
].join('\n')

const createGitStatus = (): GitStatus => ({
  workspacePath: 'd:\\Git\\chill-vibe',
  isRepository: true,
  repoRoot: 'd:\\Git\\chill-vibe',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
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
    summary: 'Add git notice coverage',
    description: '',
    authorName: 'Alex',
    authoredAt: '2026-08-13T03:00:00.000Z',
  },
})

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
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
        title: 'Git Notice Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
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
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({ json: createGitStatus() })
  })

  await page.route('**/api/git/stage', async (route) => {
    await route.fulfill({ json: createGitStatus() })
  })

  // 后端超时被 kill 时抛出的正是这种多行 Error；mock bridge 把 500 + message 还原成
  // Error(message)，与真实链路一致。
  await page.route('**/api/git/commit', async (route) => {
    await route.fulfill({ status: 500, json: { message: timedOutCommitMessage } })
  })
}

test('a multi-line git failure keeps its line breaks in the notice', async ({ page }) => {
  await installMockApis(page)
  await page.goto('http://localhost:5173')

  const launcher = page.locator('.chat-empty-tool-button').filter({ hasText: 'Git' }).first()
  await expect(launcher).toBeVisible()
  await launcher.click()

  await expect(page.locator('.git-tool-card')).toBeVisible()
  await page.getByRole('button', { name: '提交新增', exact: true }).click()

  const notice = page.locator('.git-tool-notice.is-error')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('gpg failed to sign the data')

  const metrics = await notice.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      whiteSpace: style.whiteSpace,
      lineHeight: Number.parseFloat(style.lineHeight),
      height: element.getBoundingClientRect().height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }
  })

  // 只断言高度会假绿：这条消息很长，即便换行被折成空格，横幅也照样会自动折行到三行
  // 以上（2026-08-13 实测：删掉 pre-wrap 后高度断言仍然通过）。真正被测的契约是"换行
  // 符必须被保留"，所以直接钉 computed style；高度只作为"横幅没塌成一行"的兜底。
  expect(metrics.whiteSpace).toMatch(/^pre/)
  assertAtLeastThreeLines(metrics)
  // index.lock 的绝对路径里没有空格，只有 overflow-wrap: anywhere 能让它断行；否则它
  // 会把横幅撑出横向滚动，用户根本读不到后半句。
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
})

const assertAtLeastThreeLines = (metrics: { lineHeight: number; height: number }) => {
  expect(Number.isFinite(metrics.lineHeight)).toBe(true)
  expect(metrics.height).toBeGreaterThanOrEqual(metrics.lineHeight * 3)
}
