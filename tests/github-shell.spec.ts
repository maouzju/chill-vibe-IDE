import { expect, test, type Locator, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const readComputedValue = async (locator: Locator, property: string) =>
  locator.evaluate((node, cssProperty) => getComputedStyle(node).getPropertyValue(cssProperty), property)

const readRgb = (value: string) => {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  const srgbMatch = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/)

  if (match) {
    return match.slice(1, 4).map(Number)
  }

  if (srgbMatch) {
    return srgbMatch.slice(1, 4).map((channel) => Math.round(Number(channel) * 255))
  }

  throw new Error(`Could not parse RGB value: ${value}`)
}

const maxChannel = (value: number[]) => Math.max(...value)

const readRadius = async (locator: Locator, property: 'border-radius' | 'border-top-left-radius') =>
  Number.parseFloat(await readComputedValue(locator, property))

const readRect = async (locator: Locator) =>
  locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()

    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    }
  })

const mockAppApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
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
          activeProfileId: 'codex-profile-1',
          profiles: [
            {
              id: 'codex-profile-1',
              name: 'Codex Proxy',
              apiKey: 'sk-codex',
              baseUrl: 'https://api.openai.example/v1',
            },
          ],
        },
        claude: {
          activeProfileId: 'claude-profile-1',
          profiles: [
            {
              id: 'claude-profile-1',
              name: 'Claude Proxy',
              apiKey: 'sk-claude',
              baseUrl: 'https://api.anthropic.example',
            },
          ],
        },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Workspace 1',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
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
}

test('shell stays flat and low-depth across themes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await mockAppApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  const ambienceTab = page.locator('#app-tab-ambience')
  const settingsTab = page.locator('#app-tab-settings')

  const readShell = async (theme: 'dark' | 'light') => {
    await page.evaluate((nextTheme) => {
      document.documentElement.setAttribute('data-theme', nextTheme)
    }, theme)

    await ambienceTab.click()

    const addWorkspaceButton = page.locator('.app-topbar-add-column')
    const addWorkspaceRadius = await readRadius(addWorkspaceButton, 'border-radius')
    const addWorkspaceShadow = await readComputedValue(addWorkspaceButton, 'box-shadow')
    const cardShadow = await readComputedValue(page.locator('.card-shell').first(), 'box-shadow')
    const topTabRadius = await readRadius(page.locator('.app-tab').first(), 'border-top-left-radius')
    const iconButtonRadius = await readRadius(page.locator('.icon-button').first(), 'border-radius')

    await settingsTab.click()

    const settingsPanel = page.locator('#app-panel-settings .settings-panel')

    return {
      addWorkspaceRadius,
      addWorkspaceShadow,
      cardShadow,
      topTabRadius,
      iconButtonRadius,
      themeChipRadius: await readRadius(page.locator('#app-panel-settings .theme-chip').first(), 'border-radius'),
      textButtonRadius: await readRadius(page.locator('#app-panel-settings .btn').first(), 'border-radius'),
      settingsPanelRadius: await readRadius(settingsPanel, 'border-radius'),
      settingsPanelBackdrop: await readComputedValue(settingsPanel, 'backdrop-filter'),
      settingsPanelShadow: await readComputedValue(settingsPanel, 'box-shadow'),
    }
  }

  for (const theme of ['dark', 'light'] as const) {
    const shell = await readShell(theme)

    expect(shell.topTabRadius).toBeLessThanOrEqual(8)
    expect(shell.iconButtonRadius).toBeLessThanOrEqual(8)
    expect(shell.themeChipRadius).toBeLessThanOrEqual(8)
    expect(shell.textButtonRadius).toBeLessThanOrEqual(8)
    expect(shell.settingsPanelRadius).toBeLessThanOrEqual(12)
    expect(shell.addWorkspaceRadius).toBeLessThanOrEqual(8)
    expect(shell.addWorkspaceShadow).toBe('none')
    expect(shell.cardShadow).toBe('none')
    expect(shell.settingsPanelBackdrop).toBe('none')
    expect(shell.settingsPanelShadow).toBe('none')
  }
})

test('navigation and mobile column chrome stay compact and GitHub-like', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('http://localhost:5173')
  await page.locator('.workspace-column').first().waitFor()

  const topbar = page.locator('.app-topbar-frame')
  const inactiveTab = page.locator('#app-tab-routing')
  const activeTab = page.locator('#app-tab-ambience')
  const columnHeader = page.locator('.column-header').first()

  const darkTopbar = readRgb(await readComputedValue(topbar, 'background-color'))
  const darkInactiveTab = readRgb(await readComputedValue(inactiveTab, 'background-color'))
  const darkActiveTab = readRgb(await readComputedValue(activeTab, 'background-color'))
  const darkTopbarDragRegion = await readComputedValue(topbar, '-webkit-app-region')
  const darkActiveTabDragRegion = await readComputedValue(activeTab, '-webkit-app-region')
  const darkWindowControlDragRegion = await readComputedValue(
    page.locator('.window-control-button').first(),
    '-webkit-app-region',
  )
  const darkTopbarHeight = (await readRect(topbar)).height
  const darkColumnHeaderHeight = (await readRect(columnHeader)).height
  const darkPaneTabBarHeight = (await readRect(page.locator('.pane-tab-bar').first())).height

  expect(darkInactiveTab).toEqual(darkTopbar)
  expect(darkActiveTab).toEqual(darkTopbar)
  expect(darkTopbarDragRegion).toBe('drag')
  expect(darkActiveTabDragRegion).toBe('no-drag')
  expect(darkWindowControlDragRegion).toBe('no-drag')
  expect(darkTopbarHeight).toBeGreaterThanOrEqual(34)
  expect(darkTopbarHeight).toBeLessThanOrEqual(42)
  expect(darkColumnHeaderHeight).toBeLessThanOrEqual(25)
  expect(darkPaneTabBarHeight).toBeLessThanOrEqual(44)
  await expect(page.locator('.card-header')).toHaveCount(0)

  const themeToggle = page.locator('#app-panel-settings .theme-toggle').first()

  await page.locator('#app-tab-settings').click()
  await themeToggle.locator('.theme-chip').first().click()
  await page.locator('#app-tab-ambience').click()

  const lightTopbar = readRgb(await readComputedValue(topbar, 'background-color'))
  const lightInactiveTab = readRgb(await readComputedValue(inactiveTab, 'background-color'))
  const lightActiveTab = readRgb(await readComputedValue(activeTab, 'background-color'))
  const lightPage = readRgb(await readComputedValue(page.locator('body'), 'background-color'))
  const lightTopbarHeight = (await readRect(topbar)).height
  const lightColumnHeaderHeight = (await readRect(columnHeader)).height

  expect(lightInactiveTab).toEqual(lightTopbar)
  expect(lightActiveTab).toEqual(lightTopbar)
  expect(lightTopbarHeight).toBeGreaterThanOrEqual(34)
  expect(lightTopbarHeight).toBeLessThanOrEqual(42)
  expect(lightColumnHeaderHeight).toBeLessThanOrEqual(25)
  expect(maxChannel(lightPage)).toBeGreaterThanOrEqual(240)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.workspace-column').first().waitFor()

  const mobileTitle = page.locator('.column-title-btn').first()
  const mobileActions = page.locator('.column-actions').first()
  const mobileHeader = page.locator('.column-header').first()
  const mobileTopbar = page.locator('.app-topbar-frame')

  const titleRect = await readRect(mobileTitle)
  const actionsRect = await readRect(mobileActions)
  const headerRect = await readRect(mobileHeader)
  const mobileTopbarRect = await readRect(mobileTopbar)

  expect(Math.abs(titleRect.top - actionsRect.top)).toBeLessThanOrEqual(8)
  expect(actionsRect.top - headerRect.top).toBeLessThanOrEqual(12)
  expect(mobileTopbarRect.height).toBeGreaterThanOrEqual(34)
  expect(mobileTopbarRect.height).toBeLessThanOrEqual(42)
  expect(headerRect.height).toBeLessThanOrEqual(25)
})
