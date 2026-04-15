import { expect, test, type Page, type Locator } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const selectModel = async (page: Page, trigger: Locator, label: string) => {
  await trigger.click()
  await page.locator('.model-dropdown-option').filter({ hasText: label }).click()
}

const createCardState = (overrides: Record<string, unknown> = {}) => ({
  id: 'card-1',
  title: 'Feature Chat',
  status: 'idle' as const,
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
  draft: '',
  messages: [],
  ...overrides,
})

const createState = (theme: ThemeName, cardOverrides: Record<string, unknown> = {}) =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-6',
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
        title: 'Preference Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [createCardState(cardOverrides)],
      },
    ],
  })

const installMockApis = async (
  page: Page,
  theme: ThemeName,
  options?: {
    cardOverrides?: Record<string, unknown>
  },
) => {
  await installMockElectronBridge(page)

  let state = createState(theme, options?.cardOverrides)

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
    await route.fulfill({
      json: {
        state: 'idle',
        logs: [],
      },
    })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`model-specific reasoning preferences persist across reloads in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const activePanePanel = page.locator('.pane-tab-panel.is-active')
    const modelSelect = activePanePanel.locator('.model-select').first()
    const settingsTrigger = activePanePanel.locator('.composer-settings-trigger').first()
    const reasoningSelect = page.locator('.composer-settings-menu .reasoning-select').first()
    const activeTab = page.locator('.pane-tab.is-active').first()

    await modelSelect.waitFor()
    await expect(activeTab).toHaveAttribute('draggable', 'true')
    await expect(page.locator('.card-drag-handle')).toHaveCount(0)

    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('medium')

    await reasoningSelect.selectOption('high')
    await expect(reasoningSelect).toHaveValue('high')

    await page.waitForTimeout(550)

    await selectModel(page, modelSelect, 'Opus 4.6')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('max')

    await reasoningSelect.selectOption('low')
    await expect(reasoningSelect).toHaveValue('low')

    await page.waitForTimeout(550)

    await selectModel(page, modelSelect, 'GPT-5.4')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('high')

    await selectModel(page, modelSelect, 'Opus 4.6')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('low')

    await page.reload()

    await expect(modelSelect).toHaveText('Opus 4.6')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('low')

    await selectModel(page, modelSelect, 'GPT-5.4')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('high')
  })

  test(`composer secondary settings stay openable while streaming in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme, {
      cardOverrides: {
        status: 'streaming',
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: 'Still answering',
            createdAt: new Date().toISOString(),
          },
        ],
      },
    })
    await page.goto('http://localhost:5173')

    const settingsTrigger = page.locator('.pane-tab-panel.is-active .composer-settings-trigger').first()
    const settingsMenu = page.locator('.composer-settings-menu').first()

    await expect(settingsTrigger).toBeEnabled()
    await settingsTrigger.click()
    await expect(settingsMenu).toBeVisible()
  })
}
