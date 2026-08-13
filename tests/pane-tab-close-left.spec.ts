import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

/**
 * tab 右键菜单的「关闭左侧」。和「关闭右侧」对称，但它的边界条件相反：
 * 第一个 tab 左边没有东西，菜单项必须是禁用的，而不是点了没反应。
 */
const chatCard = (id: string, title: string) => ({
  id,
  title,
  status: 'idle' as const,
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  messages: [],
})

const mockAppApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [chatCard('chat-1', 'First'), chatCard('chat-2', 'Second'), chatCard('chat-3', 'Third')],
        layout: {
          type: 'pane' as const,
          id: 'col-1-pane',
          tabs: ['chat-1', 'chat-2', 'chat-3'],
          activeTabId: 'chat-2',
          tabHistory: ['chat-1', 'chat-3', 'chat-2'],
        },
      },
    ],
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

  return {
    readTabs: () => state.columns[0]?.layout?.tabs ?? [],
  }
}

// 127.0.0.1 而不是 localhost：见 automation-board-absorb-back.spec.ts 的同名注释。
const appUrl = 'http://127.0.0.1:5173'

test('the tab context menu closes every tab to the left of the clicked one', async ({ page }) => {
  const mock = await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)

  const firstTab = page.locator('.pane-tab[data-pane-tab-id="chat-1"]')
  const middleTab = page.locator('.pane-tab[data-pane-tab-id="chat-2"]')
  const lastTab = page.locator('.pane-tab[data-pane-tab-id="chat-3"]')
  await expect(firstTab).toHaveCount(1)

  await middleTab.click({ button: 'right' })
  const closeLeft = page
    .locator('.pane-tab-context-menu button', { hasText: 'Close to the Left' })
    .first()
  await expect(closeLeft).toBeEnabled()
  await closeLeft.click()

  await expect(firstTab).toHaveCount(0)
  await expect(middleTab).toHaveCount(1)
  await expect(lastTab).toHaveCount(1)
  await expect.poll(() => mock.readTabs()).toEqual(['chat-2', 'chat-3'])
})

test('the leftmost tab has nothing to close on its left', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)

  await page.locator('.pane-tab[data-pane-tab-id="chat-1"]').click({ button: 'right' })
  const closeLeft = page
    .locator('.pane-tab-context-menu button', { hasText: 'Close to the Left' })
    .first()
  await expect(closeLeft).toBeDisabled()
})
