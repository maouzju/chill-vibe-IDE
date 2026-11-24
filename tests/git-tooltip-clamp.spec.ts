import { expect, test, type Locator, type Page } from '@playwright/test'

import type { GitStatus } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { appUrl } from './playwright-app-url.ts'

// 2026-11-24 用户截图：窄分栏里的 Git 卡，鼠标停在「同步」上，说明气泡左右两侧都被卡片
// 裁掉了——开头「先拉取远程改动」只剩「对远程改动」，结尾「推送。」没了。根因是
// HoverTooltip 以锚点为中心展开（width: max-content，居中），气泡比卡片还宽时必然越过
// .card-shell 的 overflow: hidden（同 pitfall #418，但那次只修了 composer 圆环）。
// 这条钉住：任意卡片宽度下，Git 卡里的说明气泡都必须完整落在卡片内、且不被裁掉。
const createGitStatus = (): GitStatus => ({
  workspacePath: 'd:\\Git\\chill-vibe',
  isRepository: true,
  repoRoot: 'd:\\Git\\chill-vibe',
  branch: 'master',
  upstream: 'origin/master',
  ahead: 1,
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
      path: 'src/data/cards/jingxin.js',
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
    summary: 'Tune jingxin card',
    description: '',
    authorName: 'Alex',
    authoredAt: '2026-11-24T03:00:00.000Z',
  },
})

const installMockApis = async (page: Page, theme: 'dark' | 'light' = 'dark') => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme,
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
        title: 'Git Tooltip Clamp Test',
        // 窄分栏才是用户实际看到截断的形态：气泡比卡片宽。
        width: 360,
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
}

const readRect = (locator: Locator) =>
  locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }
  })

const findClippingAncestor = (locator: Locator) =>
  locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()

    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)

      if (!/hidden|clip|auto|scroll/.test(`${style.overflowX} ${style.overflowY}`)) {
        continue
      }

      const box = parent.getBoundingClientRect()

      if (
        rect.left < box.left - 0.5 ||
        rect.right > box.right + 0.5 ||
        rect.top < box.top - 0.5 ||
        rect.bottom > box.bottom + 0.5
      ) {
        return parent.className || parent.tagName
      }
    }

    return ''
  })

for (const theme of ['dark', 'light'] as const) {
  test(`git card hover hints stay inside a narrow card in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installMockApis(page, theme)
    await page.goto(appUrl)

    const launcher = page.locator('.chat-empty-tool-button').filter({ hasText: 'Git' }).first()
    await expect(launcher).toBeVisible()
    await launcher.click()

    const cardShell = page.locator('.card-shell').first()
    const gitToolCard = page.locator('.git-tool-card').first()
    await expect(gitToolCard).toBeVisible()

    const syncButton = page
      .locator('.git-dashboard-actions-inline .git-tool-button')
      .filter({ hasText: '同步' })
      .first()
    await expect(syncButton).toBeVisible()
    await syncButton.hover()

    const tooltip = page.locator('.git-hover-tooltip').first()
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toHaveText('先拉取远程改动，必要时尝试自动解决冲突，然后再推送。')

    const [cardRect, tooltipRect, clippedBy] = await Promise.all([
      readRect(cardShell),
      readRect(tooltip),
      findClippingAncestor(tooltip),
    ])

    expect(tooltipRect.left, 'hint must not spill past the left edge of the card').toBeGreaterThanOrEqual(
      cardRect.left - 0.5,
    )
    expect(tooltipRect.right, 'hint must not spill past the right edge of the card').toBeLessThanOrEqual(
      cardRect.right + 0.5,
    )
    expect(tooltipRect.top, 'hint must not spill above the card').toBeGreaterThanOrEqual(cardRect.top - 0.5)
    expect(
      clippedBy,
      'the hint must not be clipped by a scrolling or clipping ancestor',
    ).toBe('')

    // 文字本身也不能横向溢出气泡（否则即使气泡在卡片内，字还是被切）。
    const overflow = await tooltip.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)

    await expect(tooltip).toHaveScreenshot(`git-tooltip-sync-hint-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}
