import { expect, test, type Page, type Locator } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { appUrl } from './playwright-app-url.ts'

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
  model: 'gpt-6-luna',
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
        codex: 'gpt-6-luna',
        claude: 'claude-opus-5-5',
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
        model: 'gpt-6-luna',
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
    await page.goto(appUrl)

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

    await selectModel(page, modelSelect, 'Opus 5.5')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('max')

    await reasoningSelect.selectOption('low')
    await expect(reasoningSelect).toHaveValue('low')

    await page.waitForTimeout(550)

    await selectModel(page, modelSelect, 'GPT-6 Luna')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('high')

    await selectModel(page, modelSelect, 'Opus 5.5')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('low')

    await page.reload()

    await expect(modelSelect).toHaveText('Opus 5.5')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('low')

    await selectModel(page, modelSelect, 'GPT-6 Luna')
    await settingsTrigger.click()
    await expect(reasoningSelect).toHaveValue('high')
  })

  test(`composer settings trigger becomes a reasoning knob adjustable by wheel in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto(appUrl)

    const knob = page.locator('.pane-tab-panel.is-active .composer-settings-trigger.is-reasoning-knob').first()
    const flash = page.locator('.pane-tab-panel.is-active .composer-reasoning-flash')
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'medium')
    // 档位直接写成圈内数字（低=1），不再靠数细刻度：gpt-6-luna 共 5 档，中 = 第 2 档。
    await expect(knob.locator('.knob-level')).toHaveText('2')
    await expect(knob.locator('.knob-fill')).toHaveCount(1)
    await expect(knob).toHaveAttribute('title', /中（第 2\/5 档）/)

    await knob.hover()
    await page.mouse.wheel(0, -100)
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'high')
    await expect(knob.locator('.knob-level')).toHaveText('3')
    // 滚一格就在旋钮上方报出档位名，数字和名字当场对上。
    await expect(flash).toHaveText('高 · 3/5')
    await page.mouse.wheel(0, -100)
    await page.mouse.wheel(0, -100)
    await page.mouse.wheel(0, -100)
    // 到顶停住不回绕，气泡照样报「已在最高」。
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'max')
    await expect(knob.locator('.knob-level')).toHaveText('5')
    await expect(flash).toHaveText('最高 · 5/5')
    await page.mouse.wheel(0, 100)
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'xhigh')
    await expect(knob.locator('.knob-level')).toHaveText('4')
    // 气泡是一次性的，过一会自己消失，不常驻占地方。
    await expect(flash).toHaveCount(0, { timeout: 3_000 })

    await knob.click()
    await expect(page.locator('.composer-settings-menu .reasoning-select').first()).toHaveValue('xhigh')
    await page.keyboard.press('Escape')
    // 关菜单不会补播旧气泡。
    await expect(flash).toHaveCount(0)
    await expect(knob).toHaveScreenshot(`reasoning-knob-${theme}.png`)
  })

  test(`reasoning knob keeps auto off the dial in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme, {
      cardOverrides: { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'auto' },
    })
    await page.goto(appUrl)

    const knob = page.locator('.pane-tab-panel.is-active .composer-settings-trigger.is-reasoning-knob').first()
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'auto')
    // 自动 = 跟随 CLI 默认，不占刻度：弧全空，圈内显示 A 而不是数字。
    await expect(knob.locator('.knob-fill')).toHaveCount(0)
    await expect(knob.locator('.knob-auto')).toHaveText('A')
    await expect(knob).toHaveScreenshot(`reasoning-knob-auto-${theme}.png`)

    await knob.hover()
    await page.mouse.wheel(0, 100)
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'medium')
    // Claude 明确档位 6 档（低…Ultracode），中 = 第 2 档，与 Codex 同一数字同一档。
    await expect(knob.locator('.knob-level')).toHaveText('2')
    await page.mouse.wheel(0, 100)
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'low')
    // 从「低」继续往下滚停在「低」，不会滚进「自动」（那反而想得更多）。
    await page.mouse.wheel(0, 100)
    await expect(knob).toHaveAttribute('data-reasoning-effort', 'low')
    await expect(knob.locator('.knob-auto')).toHaveCount(0)
    await expect(knob.locator('.knob-level')).toHaveText('1')
    await expect(page.locator('.pane-tab-panel.is-active .composer-reasoning-flash')).toHaveText('低 · 1/6')
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
    await page.goto(appUrl)

    const settingsTrigger = page.locator('.pane-tab-panel.is-active .composer-settings-trigger').first()
    const settingsMenu = page.locator('.composer-settings-menu').first()

    await expect(settingsTrigger).toBeEnabled()
    await settingsTrigger.click()
    await expect(settingsMenu).toBeVisible()
  })
}
