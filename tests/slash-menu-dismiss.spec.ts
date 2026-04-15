import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const getActiveComposerTextarea = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .composer textarea')

const createState = () => createPlaywrightState({
  version: 1 as const,
  settings: {
    language: 'zh-CN',
    theme: 'dark',
    fontScale: 1,
    lineHeightScale: 1,
    resilientProxyEnabled: false,
  },
  updatedAt: new Date().toISOString(),
  columns: [
    {
      id: 'col-1',
      title: 'Slash Test',
      provider: 'codex' as const,
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      cards: [
        {
          id: 'card-1',
          title: 'Test Card',
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

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createState()

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
    await route.fulfill({
      json: [
        { name: 'help', description: 'Show help', source: 'local' },
        { name: 'model', description: 'Switch model', source: 'local' },
      ],
    })
  })
}

test('slash command menu closes when clicking outside', async ({ page }) => {
  await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  await expect(textarea).toBeVisible()

  // Type "/" to open the slash menu
  await textarea.fill('/')
  const slashMenu = page.locator('.slash-command-menu').first()
  await expect(slashMenu).toBeVisible()

  // Click outside the slash menu (on the message list area)
  await page.locator('.card-shell').first().click({ position: { x: 10, y: 10 } })

  // The slash menu should be dismissed
  await expect(slashMenu).not.toBeVisible()
})

test('slash command menu closes on Escape key', async ({ page }) => {
  await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  await expect(textarea).toBeVisible()

  await textarea.fill('/')
  const slashMenu = page.locator('.slash-command-menu').first()
  await expect(slashMenu).toBeVisible()

  // Press Escape
  await textarea.press('Escape')

  // The slash menu should be dismissed
  await expect(slashMenu).not.toBeVisible()
})

test('slash command menu reopens when user continues typing after dismiss', async ({ page }) => {
  await installMockApis(page)
  await page.goto('http://localhost:5173')

  const textarea = getActiveComposerTextarea(page)
  await expect(textarea).toBeVisible()

  await textarea.fill('/')
  const slashMenu = page.locator('.slash-command-menu').first()
  await expect(slashMenu).toBeVisible()

  // Click outside to dismiss
  await page.locator('.card-shell').first().click({ position: { x: 10, y: 10 } })
  await expect(slashMenu).not.toBeVisible()

  // Focus back and type more — menu should reopen
  await textarea.click()
  await page.keyboard.type('h')
  await expect(slashMenu).toBeVisible()
})
