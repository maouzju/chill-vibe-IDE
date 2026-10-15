import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createDefaultState } from '../shared/default-state.ts'
import type { AppState } from '../shared/schema.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://127.0.0.1:5173'

const mockApis = async (page: Page, theme: 'dark' | 'light') => {
  await installMockElectronBridge(page)

  const base = createDefaultState('D:/workspace')
  let state: AppState = {
    ...base,
    settings: {
      ...base.settings,
      theme,
      requestModels: { codex: 'gpt-6-sol', claude: 'claude-sonnet-5' },
      acknowledgedModelUpgrades: [],
    },
  }

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    if (route.request().method() === 'PUT') {
      state = JSON.parse(route.request().postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }
    await route.fallback()
  })
  await page.route('**/api/state/snapshot', async (route) => {
    state = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({ json: { ok: true } })
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

  return () => state
}

for (const theme of ['dark', 'light'] as const) {
  test(`upgrade prompt switches the default to the new models in one click (${theme})`, async ({ page }) => {
    const getState = await mockApis(page, theme)
    await page.goto(appUrl)

    const dialog = page.getByRole('dialog', { name: /有更强的新模型|A stronger model is available/ })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('GPT-6 Sol')
    await expect(dialog).toContainText('GPT-6.1 Sol')
    await expect(dialog).toContainText('Sonnet 5.5')
    await expect(dialog).toHaveScreenshot(`model-upgrade-${theme}.png`, { maxDiffPixelRatio: 0.01 })

    await dialog.getByRole('button', { name: /设为新模型|Switch to new model/ }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(() => getState().settings.requestModels)
      .toEqual({ codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5-5' })
    expect(getState().settings.acknowledgedModelUpgrades).toEqual(
      expect.arrayContaining(['codex:gpt-6-sol>gpt-6.1-sol', 'claude:claude-sonnet-5>claude-sonnet-5-5']),
    )

    await page.reload()
    await expect(page.getByRole('dialog', { name: /有更强的新模型|A stronger model is available/ })).toHaveCount(0)
  })
}

test('keeping the current model dismisses the prompt for good without touching the default', async ({ page }) => {
  const getState = await mockApis(page, 'dark')
  await page.goto(appUrl)

  const dialog = page.getByRole('dialog', { name: /有更强的新模型|A stronger model is available/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /保持不变|Keep current/ }).click()
  await expect(dialog).toBeHidden()

  await expect
    .poll(() => getState().settings.acknowledgedModelUpgrades.length)
    .toBeGreaterThanOrEqual(2)
  expect(getState().settings.requestModels).toEqual({ codex: 'gpt-6-sol', claude: 'claude-sonnet-5' })

  await page.reload()
  await expect(page.getByRole('dialog', { name: /有更强的新模型|A stronger model is available/ })).toHaveCount(0)
})
