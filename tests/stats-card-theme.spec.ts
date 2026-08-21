import { expect, test, type Locator, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const STATS_MODEL = '__stats_tool__'

/**
 * Seeded so the heatmap has a spread of levels, an active streak, and one turn
 * carrying usage telemetry — a blank card would make every snapshot identical
 * and prove nothing about the ramp or the peak bar.
 */
const seedMessages = () => {
  const messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    createdAt: string
    meta?: Record<string, string>
  }> = []

  const day = (offset: number, count: number) => {
    const date = new Date(2026, 7, 16 - offset, 12, 0, 0, 0)
    for (let index = 0; index < count; index += 1) {
      messages.push({
        id: `m-${offset}-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `line ${index}`,
        createdAt: new Date(date.getTime() + index * 60_000).toISOString(),
      })
    }
  }

  day(0, 24)
  day(1, 14)
  day(2, 6)
  day(3, 2)
  day(5, 18)
  day(6, 9)
  day(9, 3)
  day(14, 11)
  day(21, 5)
  day(35, 20)

  messages.push({
    id: 'm-usage',
    role: 'assistant',
    content: 'done',
    createdAt: new Date(2026, 7, 16, 13, 0, 0, 0).toISOString(),
    meta: {
      turnUsageUsed: '86000',
      turnUsageSize: '200000',
      turnUsageInput: '72000',
      turnUsageOutput: '14000',
      turnUsageCacheRead: '5200',
      turnUsageCacheCreation: '1800',
      turnUsageCostUsd: '0.4231',
    },
  })

  return messages
}

const createState = (theme: 'dark' | 'light') =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme,
      experimentalStatsEnabled: true,
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
    },
    updatedAt: new Date().toISOString(),
    sessionHistory: [
      {
        id: 'hist-1',
        title: 'Archived one',
        provider: 'claude' as const,
        model: 'claude-opus-5',
        workspacePath: 'd:\\Git\\chill-vibe',
        messages: [],
        messageCount: 31,
        // 归档时汇总下来的用量：统计卡必须把它算进总数，历史会话不再是用量黑洞。
        usageTotals: {
          input: 120_000,
          output: 24_000,
          cacheRead: 8_000,
          cacheCreation: 2_400,
          turns: 9,
          peakUsed: 88_000,
          peakSize: 200_000,
          costUsd: 1.42,
        },
        archivedAt: new Date(2026, 7, 12, 18, 0, 0, 0).toISOString(),
      },
      {
        id: 'hist-2',
        title: 'Archived two',
        provider: 'codex' as const,
        model: 'gpt-5.5',
        workspacePath: 'd:\\Git\\chill-vibe',
        messages: [],
        messageCount: 8,
        archivedAt: new Date(2026, 7, 4, 9, 0, 0, 0).toISOString(),
      },
    ],
    columns: [
      {
        id: 'col-1',
        title: 'Stats',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-stats',
            title: '',
            status: 'idle' as const,
            size: 640,
            provider: 'codex' as const,
            model: STATS_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
          {
            id: 'card-chat',
            title: 'Working chat',
            status: 'idle' as const,
            size: 420,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: seedMessages(),
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, theme: 'dark' | 'light') => {
  await installMockElectronBridge(page)

  let state = createState(theme)

  await page.route('**/api/state', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    if (request.method() === 'PUT') {
      state = createPlaywrightState(JSON.parse(request.postData() ?? '{}'))
      await route.fulfill({ json: state })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = createPlaywrightState(JSON.parse(route.request().postData() ?? '{}'))
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
}

/**
 * 数**真实的日子**而不是周列数。列数取决于范围首日是周几，会随"今天"漂移：90 天既可能
 * 排成 13 列也可能排成 14 列，钉死一个值的断言过几天就自己红了（2026-08-21 实测：写死
 * 的 14 变成了 13）。非空格子数恒等于所选天数。
 */
// 只有真实的日子带 title（tooltip）：补位格是 aria-hidden 的空格，图例格也没有 title。
const realDayCells = (card: Locator) => card.locator('.stats-heatmap-cell[title]')

const openStatsCard = async (page: Page) => {
  const card = page.locator('[data-stats-card]').first()
  await expect(card).toBeVisible()
  // The first metrics pass runs in an idle callback, so wait for real content
  // rather than the loading placeholder before snapshotting.
  await expect(card).not.toHaveClass(/is-loading/)
  await expect(card.locator('.stats-heatmap-cell').first()).toBeVisible()
  return card
}

for (const theme of ['light', 'dark'] as const) {
  test(`stats card renders its heatmap and usage block in the ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installMockApis(page, theme)
    await page.goto(appUrl)

    const card = await openStatsCard(page)

    // The card opens on the one-year range: 365 days padded to whole weeks.
    await expect(realDayCells(card)).toHaveCount(365)
    await expect(card.locator('.stats-heatmap-cell[data-level="4"]').first()).toBeVisible()
    await expect(card.locator('.stats-tile')).toHaveCount(4)
    await expect(card.locator('.stats-peak-fill')).toBeVisible()
    await expect(card.locator('.stats-provider-chip')).toHaveCount(2)

    // 用量口径改过一次（SPEC Slice 5）：以前这行是「仅统计当前打开的会话」的免责声明。
    // 只靠截图比对守不住它——这行是小灰字，改动落在 maxDiffPixelRatio 的容差里。
    await expect(card.locator('.stats-tokens-hint')).toHaveText(
      'Includes archived sessions (latest 50 per workspace) · 1 of them has no usage record',
    )

    await expect(card).toHaveScreenshot(`stats-card-${theme}.png`, { maxDiffPixelRatio: 0.01 })
  })
}

test('switching the range redraws the calendar without losing the card', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await installMockApis(page, 'dark')
  await page.goto(appUrl)

  const card = await openStatsCard(page)
  await expect(realDayCells(card)).toHaveCount(365)

  await card.locator('.stats-range-button', { hasText: 'Last 3 months' }).click()

  await expect(realDayCells(card)).toHaveCount(90)
  // 范围组里才有"当前选中"这个概念；口径切换器复用同一套按钮皮肤，不限定组会命中两个。
  await expect(card.locator('[data-picker="range"] .stats-range-button.is-active')).toHaveText(
    'Last 3 months',
  )
  await expect(card).not.toHaveClass(/is-loading/)
})

test('the calendar can be repainted by session count', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await installMockApis(page, 'dark')
  await page.goto(appUrl)

  const card = await openStatsCard(page)
  const metricPicker = card.locator('[data-picker="metric"]')

  await expect(metricPicker.locator('.stats-range-button.is-active')).toHaveText('Messages')

  await metricPicker.locator('.stats-range-button', { hasText: 'Sessions' }).click()

  await expect(metricPicker.locator('.stats-range-button.is-active')).toHaveText('Sessions')
  // 切口径不重算，只换读哪个等级字段 —— 日历必须原地还在，且仍有着色的格子。
  await expect(realDayCells(card)).toHaveCount(365)
  await expect(card.locator('.stats-heatmap-cell[data-level="4"]').first()).toBeVisible()
  await expect(card).not.toHaveClass(/is-loading/)
})

test('a narrow card keeps the calendar inside its bounds', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 900 })
  await installMockApis(page, 'light')
  await page.goto(appUrl)

  const card = await openStatsCard(page)

  const overflow = await card.evaluate((node) => {
    const scroller = node.querySelector('.stats-heatmap-scroll')
    return {
      cardRight: Math.round(node.getBoundingClientRect().right),
      scrollerRight: Math.round(scroller?.getBoundingClientRect().right ?? 0),
      clipsOverflow: scroller ? getComputedStyle(scroller).overflowX !== 'visible' : false,
      cellWidth: Math.round(
        node.querySelector('.stats-heatmap-cell')?.getBoundingClientRect().width ?? 0,
      ),
    }
  })

  // The calendar must stay inside the card. It gets there by shrinking the cells
  // (pure CSS, no ResizeObserver), and only falls back to scrolling below the floor.
  expect(overflow.scrollerRight).toBeLessThanOrEqual(overflow.cardRight)
  expect(overflow.clipsOverflow).toBe(true)
  expect(overflow.cellWidth).toBeGreaterThanOrEqual(8)
  expect(overflow.cellWidth).toBeLessThan(20)

  await expect(card).toHaveScreenshot('stats-card-narrow-light.png', { maxDiffPixelRatio: 0.01 })
})
