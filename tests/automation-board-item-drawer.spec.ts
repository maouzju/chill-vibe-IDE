import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const boardCardId = 'board-1'
const workspacePath = 'd:\\Git\\chill-vibe'

/**
 * 看板项的二级抽屉里，计划唤醒必须是 composer 那一整块面板（同一个
 * `WakeTimerSettingsPanel`），不是一个"上方需求"复选框 —— 复选框只能表达
 * `left-tab` 一种模式，"其他 Agent 完成"和"指定时长"在看板里就永远够不到。
 * 抽屉展开态点不了的部分由 SSR 单测覆盖，这条 spec 管真实点开后的样子。
 */
const itemCard = (
  id: string,
  title: string,
  status: 'idle' | 'streaming' = 'idle',
  overrides: Record<string, unknown> = {},
) => ({
  id,
  title,
  status,
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  messages: [],
  ...overrides,
})

const createState = (theme: 'dark' | 'light') =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      automationBoardCardEnabled: true,
      wakeTimerEnabled: true,
      repeatLoopEnabled: true,
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: '2026-08-12T00:00:00.000Z',
    automationBoards: { [workspacePath]: { templates: [] } },
    columns: [
      {
        id: 'col-board',
        title: 'Automation Workspace',
        provider: 'codex' as const,
        workspacePath,
        model: 'gpt-5.5',
        layout: createPane([boardCardId], boardCardId, 'pane-board'),
        cards: [
          {
            id: boardCardId,
            title: 'Automation',
            status: 'idle' as const,
            size: 720,
            provider: 'codex' as const,
            model: AUTOMATIONBOARD_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            automationBoard: {
              items: [
                {
                  cardId: 'item-running-a',
                  lane: 'running' as const,
                  requirement: '重写会话历史的索引重建脚本，并补一条守卫测试。',
                },
                {
                  cardId: 'item-running-b',
                  lane: 'running' as const,
                  requirement: '把结账流程的回归测试补齐。',
                },
              ],
            },
          },
          itemCard('item-running-a', '重建会话历史索引', 'streaming'),
          itemCard('item-running-b', '补齐结账回归测试', 'streaming', {
            wakeTimerActive: true,
            wakeTimerMode: 'left-tab',
          }),
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

const openSecondItemDrawer = async (page: Page) => {
  const item = page.locator('[data-automation-board-item-id="item-running-b"]')
  await expect(item).toBeVisible()
  await item.locator('.automation-board-item-more').click()
  return item
}

for (const theme of ['dark', 'light'] as const) {
  test(`the item drawer carries the whole wake timer panel (${theme})`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(appUrl)

    await expect(page.locator('.automation-board')).toBeVisible()
    const item = await openSecondItemDrawer(page)

    const panel = item.locator('.composer-wake-timer-module')
    await expect(panel).toBeVisible()

    const mode = panel.locator('select')
    await expect(mode).toHaveValue('left-tab')
    await expect(mode.locator('option')).toHaveText([
      '其他 Agent 完成',
      '上方需求完成',
      '指定时长',
    ])

    await expect(item.locator('.automation-board-item-drawer')).toHaveScreenshot(
      `automation-board-item-drawer-${theme}.png`,
      { animations: 'disabled', maxDiffPixelRatio: 0.004 },
    )
  })
}

test('switching to the duration mode reveals the minutes input inside the drawer', async ({
  page,
}) => {
  await installMockApis(page, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  await expect(page.locator('.automation-board')).toBeVisible()
  const item = await openSecondItemDrawer(page)

  const panel = item.locator('.composer-wake-timer-module')
  await expect(panel.locator('.composer-wake-timer-duration-input')).toHaveCount(0)

  await panel.locator('select').selectOption('duration')
  const minutes = panel.locator('.composer-wake-timer-duration-input')
  await expect(minutes).toBeVisible()
  await expect(minutes).toHaveValue('30')

  // 时长这一行是抽屉里最挤的一行（标签 + 数字框 + 单位），窄泳道下最容易溢出。
  await expect(item.locator('.automation-board-item-drawer')).toHaveScreenshot(
    'automation-board-item-drawer-duration-dark.png',
    { animations: 'disabled', maxDiffPixelRatio: 0.004 },
  )
})

// 第一项上面没有别的项，所以 `上方需求完成` 这个模式在它身上无对象可等 ——
// 警告文案必须是看板那一套方位词，不是 composer 的"左侧"。
test('the first running item warns with the board wording when it waits on nothing', async ({
  page,
}) => {
  await installMockApis(page, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  await expect(page.locator('.automation-board')).toBeVisible()
  const item = page.locator('[data-automation-board-item-id="item-running-a"]')
  await item.locator('.automation-board-item-more').click()

  const panel = item.locator('.composer-wake-timer-module')
  await panel.locator('input[type="checkbox"]').check()
  await panel.locator('select').selectOption('left-tab')

  await expect(panel.locator('.composer-settings-note.is-warning')).toHaveText(
    '上方没有可等待的需求',
  )
})
