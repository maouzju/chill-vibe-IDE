import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createDefaultState } from '../shared/default-state.ts'
import type { AppState } from '../shared/schema.ts'
import { appUrl } from './playwright-app-url.ts'

// 端点返回：两条真·新型号 + 今天中转站上的旧型号/压缩变体（不该出现在弹窗里）。
const discovered = [
  { provider: 'claude', ids: ['claude-opus-5-5', 'claude-opus-6', 'claude-opus-4-8'] },
  { provider: 'codex', ids: ['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6.2-sol-openai-compact', 'codex-auto-review'] },
]

const mockApis = async (page: Page, theme: 'dark' | 'light') => {
  await installMockElectronBridge(page)

  const base = createDefaultState('D:/workspace')
  let state: AppState = { ...base, settings: { ...base.settings, theme } }

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
  await page.route('**/api/models/discover', async (route) => {
    await route.fulfill({ json: discovered })
  })

  return () => state
}

const dialogName = /发现新模型|New models found/

for (const theme of ['dark', 'light'] as const) {
  test(`discovered new models are added to the picker in one click (${theme})`, async ({ page }) => {
    const getState = await mockApis(page, theme)
    await page.goto(appUrl)

    const dialog = page.getByRole('dialog', { name: dialogName })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByRole('listitem')).toHaveCount(2)
    await expect(dialog).toContainText('Opus 6')
    await expect(dialog).toContainText('GPT-6.2 Sol')
    await expect(dialog).not.toContainText('compact')
    await expect(dialog).toHaveScreenshot(`model-discovery-${theme}.png`, { maxDiffPixelRatio: 0.01 })

    await dialog.getByRole('button', { name: /全部加入|Add all/ }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(() => getState().settings.modelPickerCustomModels.map((entry) => `${entry.provider}:${entry.model}`))
      .toEqual(['claude:claude-opus-6', 'codex:gpt-6.2-sol'])
    expect(getState().settings.seenDiscoveredModels).toEqual(['claude:claude-opus-6', 'codex:gpt-6.2-sol'])

    await page.reload()
    await page.waitForTimeout(4_500)
    await expect(page.getByRole('dialog', { name: dialogName })).toHaveCount(0)
  })
}

test('adding one keeps the rest; ignore asks never again without adding', async ({ page }) => {
  const getState = await mockApis(page, 'dark')
  await page.goto(appUrl)

  const dialog = page.getByRole('dialog', { name: dialogName })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('listitem').filter({ hasText: 'Opus 6' }).getByRole('button').click()
  await expect(dialog.getByRole('listitem')).toHaveCount(1)

  await dialog.getByRole('button', { name: /忽略|Ignore/ }).click()
  await expect(dialog).toBeHidden()

  await expect.poll(() => getState().settings.seenDiscoveredModels).toEqual(['claude:claude-opus-6', 'codex:gpt-6.2-sol'])
  expect(getState().settings.modelPickerCustomModels.map((entry) => entry.model)).toEqual(['claude-opus-6'])

  await page.reload()
  await page.waitForTimeout(4_500)
  await expect(page.getByRole('dialog', { name: dialogName })).toHaveCount(0)
})
