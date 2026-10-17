import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { revealSettingsItem } from './settings-panel-helpers.ts'
import { appUrl } from './playwright-app-url.ts'
import type { AppSettings, AppState } from '../shared/schema.ts'

// docs/specs/model-picker-customization：悬停模型按钮滚轮切换上一项/下一项，
// 以及设置里关掉内置项、追加自定义项。

const createSeededState = (settings: Partial<AppSettings> = {}) =>
  createPlaywrightState({
    version: 1 as const,
    settings: { language: 'zh-CN', theme: 'dark', ...settings },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Wheel',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-6-luna',
        cards: [
          {
            id: 'card-1',
            title: '滚轮卡',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-6-luna',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })

const mockApis = async (page: Page, initial: AppState) => {
  await installMockElectronBridge(page)

  const saved: AppState[] = []
  let state = initial
  const remember = (body: string | null) => {
    state = createPlaywrightState(JSON.parse(body ?? '{}'))
    saved.push(state)
  }

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    if (route.request().method() === 'PUT') {
      remember(route.request().postData())
      await route.fulfill({ json: state })
      return
    }
    await route.fallback()
  })
  await page.route('**/api/state/snapshot', async (route) => {
    remember(route.request().postData())
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
  await page.route('**/api/ollama/**', async (route) => {
    await route.fulfill({ status: 500, json: { error: 'ollama not installed' } })
  })

  return { saved, current: () => state }
}

const savedCard = (state: AppState) => state.columns[0]?.cards['card-1']

test('wheel over the model button previews neighbours and commits once after the pause', async ({ page }) => {
  const api = await mockApis(page, createSeededState())
  await page.goto(appUrl)

  const modelSelect = page.locator('.model-select').first()
  await expect(modelSelect).toContainText('GPT-6 Luna')
  await modelSelect.hover()

  // 向上 = 上一项
  await page.mouse.wheel(0, -100)
  await expect(modelSelect).toContainText('GPT-6.1 Sol')

  // 连滚两格向下：Luna → Astra → Fable 5.1（跨 provider）。中间的 Astra 只是预览。
  await page.mouse.wheel(0, 100)
  await expect(modelSelect).toContainText('GPT-6 Luna')
  await page.mouse.wheel(0, 100)
  await expect(modelSelect).toContainText('GPT-6 Astra')
  await page.mouse.wheel(0, 100)
  await expect(modelSelect).toContainText('Fable 5.1')

  await expect
    .poll(() => {
      const card = savedCard(api.current())
      return card ? `${card.provider}:${card.model}` : ''
    })
    .toBe('claude:claude-fable-5-1')

  // 只提交了终点：没有任何一次落盘停在路过的型号上。
  const passedThrough = api.saved.some((state) => {
    const card = savedCard(state)
    return card?.model === 'gpt-6-astra' || card?.model === 'gpt-6.1-sol'
  })
  expect(passedThrough).toBe(false)
})

test('scrolling back to the original model and stopping changes nothing', async ({ page }) => {
  const api = await mockApis(page, createSeededState())
  await page.goto(appUrl)

  const modelSelect = page.locator('.model-select').first()
  await expect(modelSelect).toContainText('GPT-6 Luna')
  await modelSelect.hover()
  await page.mouse.wheel(0, 100)
  await expect(modelSelect).toContainText('GPT-6 Astra')
  await page.mouse.wheel(0, -100)
  await expect(modelSelect).toContainText('GPT-6 Luna')

  await page.waitForTimeout(900)
  expect(api.saved.some((state) => savedCard(state)?.model !== 'gpt-6-luna')).toBe(false)
})

test('the dropdown honours hidden built-ins and custom entries from settings', async ({ page }) => {
  await mockApis(
    page,
    createSeededState({
      modelPickerVisibility: { 'codex:gpt-6-astra': false, 'claude:claude-sonnet-5': true },
      modelPickerCustomModels: [{ id: 'c1', provider: 'codex', model: 'deepseek-v4', label: 'DeepSeek V4' }],
    }),
  )
  await page.goto(appUrl)

  const modelSelect = page.locator('.model-select').first()
  await modelSelect.click()
  const menu = page.locator('.model-dropdown-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option', { name: 'DeepSeek V4' })).toBeVisible()
  await expect(menu.getByRole('option', { name: 'Sonnet 5', exact: true })).toBeVisible()
  await expect(menu.getByRole('option', { name: 'GPT-6 Astra' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // 被关掉的 Astra 不在滚轮路径上：Luna 往下一格直接到下一个可见项。
  await modelSelect.hover()
  await page.mouse.wheel(0, 100)
  await expect(modelSelect).not.toContainText('GPT-6 Astra')
})

test('settings toggles built-ins and adds / removes custom models', async ({ page }) => {
  const api = await mockApis(page, createSeededState())
  await page.goto(appUrl)

  await page.getByRole('tab', { name: /设置|Settings/ }).click()
  const item = await revealSettingsItem(page, 'model-picker')
  const section = item.getByTestId('model-picker-settings')
  await section.scrollIntoViewIfNeeded()

  const astra = section.locator('[data-model-picker-key="codex:gpt-6-astra"]')
  await expect(astra).toBeChecked()
  await astra.uncheck()
  const retired = section.locator('[data-model-picker-key="claude:claude-sonnet-5"]')
  await expect(retired).not.toBeChecked()
  await retired.check()
  await expect
    .poll(() => api.current().settings.modelPickerVisibility)
    .toEqual({ 'codex:gpt-6-astra': false, 'claude:claude-sonnet-5': true })

  // 勾回默认状态 = 从覆盖表里删键
  await retired.uncheck()
  await expect.poll(() => api.current().settings.modelPickerVisibility).toEqual({ 'codex:gpt-6-astra': false })

  const draft = section.locator('.model-picker-custom-draft')
  const add = draft.getByRole('button', { name: /添加|Add/ })
  await draft.getByRole('textbox').first().fill('bad name')
  await expect(add).toBeDisabled()
  await expect(section.locator('.model-picker-draft-error')).toBeVisible()
  await draft.getByRole('textbox').first().fill('gpt-6-luna')
  await expect(add).toBeDisabled()
  await draft.getByRole('textbox').first().fill('deepseek-v4')
  await draft.getByRole('textbox').nth(1).fill('DeepSeek V4')
  await add.click()
  await expect(section.locator('.model-picker-custom-row')).toContainText('deepseek-v4')
  await expect
    .poll(() => api.current().settings.modelPickerCustomModels.map(({ provider, model, label }) => ({ provider, model, label })))
    .toEqual([{ provider: 'codex', model: 'deepseek-v4', label: 'DeepSeek V4' }])

  await section.getByRole('button', { name: /恢复默认|Restore defaults/ }).click()
  await expect(astra).toBeChecked()
  await expect.poll(() => api.current().settings.modelPickerVisibility).toEqual({})

  await section.locator('.model-picker-custom-row').getByRole('button', { name: /移除|Remove/ }).click()
  await expect(section.locator('.model-picker-custom-row')).toHaveCount(0)
  await expect.poll(() => api.current().settings.modelPickerCustomModels).toEqual([])
})
