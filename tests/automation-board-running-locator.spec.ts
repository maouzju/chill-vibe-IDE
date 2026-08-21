import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const boardCardId = 'board-1'

/** 三个在跑、三个不在跑，交错排列：计数只能数在跑的，定位只能走在跑的。 */
const laneItems = [
  { id: 'run-a', streaming: true },
  { id: 'idle-a', streaming: false },
  { id: 'run-b', streaming: true },
  { id: 'idle-b', streaming: false },
  { id: 'run-c', streaming: true },
  { id: 'idle-c', streaming: false },
]

const message = (id: string, index: number) => ({
  id: `${id}-m${index}`,
  role: 'assistant' as const,
  content: `agent line ${index} for ${id}`,
  createdAt: new Date(Date.parse('2026-08-11T00:00:00.000Z') + index * 1_000).toISOString(),
})

const itemCard = (id: string, streaming: boolean) => ({
  id,
  title: `Item ${id}`,
  // 只给 status，不给 streamId：带 streamId 的卡在恢复时会去重连桌面流，mock 环境
  // 里那一步必然失败，卡片当场退出 streaming，测的就不再是这条 UI 了。
  status: streaming ? ('streaming' as const) : ('idle' as const),
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  messages: Array.from({ length: 6 }, (_, index) => message(id, index)),
})

const createState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark',
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
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-board',
        title: 'Automation Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
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
              items: laneItems.map((entry) => ({
                cardId: entry.id,
                lane: 'running' as const,
                requirement: `Requirement for ${entry.id}`,
              })),
            },
          },
          ...laneItems.map((entry) => itemCard(entry.id, entry.streaming)),
        ],
      },
    ],
  })

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createState()

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

const item = (page: Page, cardId: string) =>
  page.locator(`.automation-board-item[data-automation-board-item-id="${cardId}"]`)

test('the running counter reports live work and walks through it one click at a time', async ({
  page,
}) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(appUrl)

  const lane = page.locator('.automation-board-lane[data-lane="running"]')
  await expect(lane.locator('.automation-board-item')).toHaveCount(6)

  // 计数只数真的在跑的，与旁边"共 6 项"的存量胶囊是两个不同的数字。
  const locator = lane.locator('.automation-board-lane-running')
  await expect(locator).toHaveText(/3 running/)
  await expect(lane.locator('.automation-board-lane-count')).toHaveText(/6 items/)

  await locator.click()
  await expect(item(page, 'run-a')).toHaveClass(/is-locating/)
  await expect(item(page, 'run-a')).toBeInViewport()

  await locator.click()
  await expect(item(page, 'run-b')).toHaveClass(/is-locating/)
  await expect(item(page, 'run-b')).toBeInViewport()
  // 高亮一次只在一张卡上，否则"跳到哪了"又变回猜。
  await expect(page.locator('.automation-board-item.is-locating')).toHaveCount(1)

  await locator.click()
  await expect(item(page, 'run-c')).toHaveClass(/is-locating/)
  await expect(item(page, 'run-c')).toBeInViewport()

  // 走到末尾要绕回开头，点击永远有反应。
  await locator.click()
  await expect(item(page, 'run-a')).toHaveClass(/is-locating/)
})
