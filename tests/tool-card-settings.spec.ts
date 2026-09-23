import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { revealSettingsItem } from './settings-panel-helpers.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createState = (theme: 'dark' | 'light' = 'dark') =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
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
        title: 'Card Types',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-1',
            title: '',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, theme: 'dark' | 'light' = 'dark') => {
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

// 单列布局：可见的设置项必须一个接一个往下排（展开子区块后也不能并排/重叠）。
const expectVisibleSettingsItemsStacked = async (page: Page) => {
  const rects = await page.locator('#app-panel-settings .settings-item:visible').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    }),
  )
  expect(rects.length).toBeGreaterThan(0)
  expect(rects.every((rect, index) => index === 0 || rect.top >= rects[index - 1]!.bottom - 1)).toBe(true)
}

test('settings keep archived brainstorm tooling hidden while auto urge stays under automation', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)

  const settingsPanel = page.locator('#app-panel-settings')
  const utilityGroup = settingsPanel.locator('#settings-item-auto-urge')
  const cardTypeGroup = settingsPanel.locator('#settings-item-tool-cards')
  const experimentalGroup = settingsPanel.locator('#settings-item-experimental')
  const quickToolButtons = page.locator('.pane-view').first().locator('.chat-empty-tool-button')

  // 自动化看板 2026-08-17 转正为默认开启，所以快捷工具是四个。
  await expect(quickToolButtons).toHaveCount(4)
  await expect(quickToolButtons.nth(0)).toContainText('Git')
  await expect(quickToolButtons.nth(1)).toContainText('Files')
  await expect(quickToolButtons.nth(2)).toContainText('Sticky Note')
  await expect(quickToolButtons.nth(3)).toContainText('Automation Board')

  await page.locator('#app-tab-settings').click()
  await expect(settingsPanel).toBeVisible()

  await revealSettingsItem(page, 'auto-urge')
  await expect(utilityGroup).toContainText('Auto Urge')
  await revealSettingsItem(page, 'tool-cards')
  await expect(cardTypeGroup).not.toContainText('Auto Urge')

  const gitToggle = cardTypeGroup.getByLabel('Git')
  const filesToggle = cardTypeGroup.getByLabel('Files')
  const stickyToggle = cardTypeGroup.getByLabel('Sticky Note')
  const automationBoardToggle = cardTypeGroup.getByLabel('Automation Board')
  const brainstormToggle = cardTypeGroup.getByLabel('Brainstorm')

  await expect(gitToggle).toBeChecked()
  await expect(filesToggle).toBeChecked()
  await expect(stickyToggle).toBeChecked()
  await expect(automationBoardToggle).toBeChecked()
  await expect(brainstormToggle).toHaveCount(0)

  await gitToggle.uncheck()
  // 看板虽然默认开，开关仍然要能真正关掉它——只断言默认四个的话，
  // 「开关点了没反应」也会一路绿。
  await automationBoardToggle.uncheck()

  // 天气/音乐/白噪音是实验功能，住在「系统 → 一般不用动」。
  await revealSettingsItem(page, 'experimental')
  const weatherToggle = experimentalGroup.getByLabel('Weather')
  const musicToggle = experimentalGroup.getByLabel('NetEase Music')
  const whiteNoiseToggle = experimentalGroup.getByLabel('White Noise')
  await expect(weatherToggle).not.toBeChecked()
  await expect(musicToggle).not.toBeChecked()
  await expect(whiteNoiseToggle).not.toBeChecked()
  await weatherToggle.check()

  await page.locator('#app-tab-ambience').click()
  // Git 与看板关掉、天气打开：Files / Sticky Note / Weather
  await expect(quickToolButtons).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Git' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Files' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Sticky Note' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Automation Board' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Brainstorm' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Weather' })).toHaveCount(1)
})

test('clear user data stays behind a confirmation dialog', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)

  await page.evaluate(() => {
    ;(window as typeof window & { __clearUserDataCalls?: number }).__clearUserDataCalls = 0
    if (!window.electronAPI) {
      throw new Error('Expected Electron bridge to be available.')
    }

    window.electronAPI.clearUserData = async () => {
      ;(window as typeof window & { __clearUserDataCalls?: number }).__clearUserDataCalls =
        ((window as typeof window & { __clearUserDataCalls?: number }).__clearUserDataCalls ?? 0) + 1
    }
  })

  await page.locator('#app-tab-settings').click()
  await revealSettingsItem(page, 'data')

  const clearButton = page.getByRole('button', { name: 'Clear User Data' })
  const dialog = page.getByRole('dialog', { name: 'Clear User Data?' })

  await expect(clearButton).toBeVisible()
  await clearButton.click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Local chat history, board layout, and session metadata')
  await expect(dialog).toContainText('Provider profiles, API keys, music sign-in, and saved preferences')
  await expect(dialog).toContainText('Cached attachments, white-noise audio, and other local cached files')

  await dialog.locator('.settings-danger-actions').getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => page.evaluate(() => window.__clearUserDataCalls ?? 0)).toBe(0)

  await clearButton.click()
  await dialog.locator('.settings-danger-actions').getByRole('button', { name: 'Clear and Restart' }).click()
  await expect.poll(async () => page.evaluate(() => window.__clearUserDataCalls ?? 0)).toBe(1)
})

for (const theme of ['dark', 'light'] as const) {
  test(`settings groups stay in one column while sections expand in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 1280, height: 1400 })
    await page.goto(appUrl)

    await page.locator('#app-tab-settings').click()
    await expect(page.locator('#app-panel-settings')).toBeVisible()

    await revealSettingsItem(page, 'general')
    await expectVisibleSettingsItemsStacked(page)

    await page.locator('#agent-done-sound-toggle').check()
    await page.locator('#all-agents-done-sound-toggle').check()
    await expect(page.locator('#agent-done-sound-toggle')).toBeChecked()
    await expect(page.locator('#all-agents-done-sound-toggle')).toBeChecked()
    const agentDoneVolume = page.locator('#agent-done-sound-volume')
    const allAgentsDoneVolume = page.locator('#all-agents-done-sound-volume')
    await expect(agentDoneVolume).toHaveValue('0.7')
    await expect(allAgentsDoneVolume).toHaveValue('0.7')
    await allAgentsDoneVolume.fill('0.25')
    await expect(allAgentsDoneVolume).toHaveValue('0.25')
    await expect(agentDoneVolume).toHaveValue('0.7')
    await revealSettingsItem(page, 'auto-urge')
    await page.locator('#auto-urge-toggle').check()
    await expect(page.locator('.auto-urge-profile-card')).toHaveCount(1)
    await expectVisibleSettingsItemsStacked(page)

    await revealSettingsItem(page, 'experimental')
    await page.locator('#experimental-weather-toggle').check()
    await expect(page.locator('#weather-city-input')).toBeVisible()
    await expectVisibleSettingsItemsStacked(page)
  })

  test(`settings card types stay legible in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto(appUrl)

    const settingsPanel = page.locator('#app-panel-settings')

    await page.locator('#app-tab-settings').click()
    await expect(settingsPanel).toBeVisible()
    const cardTypeGroup = await revealSettingsItem(page, 'tool-cards')
    await expect(cardTypeGroup).toContainText('Git')
    await expect(cardTypeGroup).toContainText('Files')
    await expect(cardTypeGroup).toContainText('Sticky Note')
    await expect(cardTypeGroup).not.toContainText('NetEase Music')
    const utilityGroup = await revealSettingsItem(page, 'auto-urge')
    await expect(utilityGroup).toContainText('Auto Urge')
    await revealSettingsItem(page, 'tool-cards')

    await expect(cardTypeGroup).toHaveScreenshot(`card-type-settings-experimental-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
    await expect(utilityGroup).toHaveScreenshot(`card-type-settings-utility-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}
