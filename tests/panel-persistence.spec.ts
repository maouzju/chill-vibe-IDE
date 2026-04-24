import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  let snapshotRequests = 0
  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN' as const,
      theme,
      activeTopTab: 'ambience' as const,
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
        title: 'Panel Persistence Test',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
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
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    snapshotRequests += 1
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

  return {
    readActiveTopTab: () => state.settings.activeTopTab,
    readSnapshotRequests: () => snapshotRequests,
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`active top panel persists across reloads in ${theme} theme`, async ({ page }) => {
    const controls = await installMockApis(page, theme)
    await page.goto(appUrl)

    const ambiencePanel = page.locator('#app-panel-ambience')
    const routingTab = page.locator('#app-tab-routing')
    const routingPanel = page.locator('#app-panel-routing')
    const settingsTab = page.locator('#app-tab-settings')
    const settingsPanel = page.locator('#app-panel-settings')

    await expect(ambiencePanel).toBeVisible()

    await settingsTab.click()
    await expect(settingsPanel).toBeVisible()
    await expect(ambiencePanel).toBeHidden()
    await expect.poll(() => controls.readActiveTopTab()).toBe('settings')
    await expect.poll(() => controls.readSnapshotRequests()).toBeGreaterThan(0)

    await page.reload()
    await expect(settingsPanel).toBeVisible()
    await expect(ambiencePanel).toBeHidden()

    const snapshotRequestsBeforeRouting = controls.readSnapshotRequests()

    await routingTab.click()
    await expect(routingPanel).toBeVisible()
    await expect(ambiencePanel).toBeHidden()
    await expect.poll(() => controls.readActiveTopTab()).toBe('routing')
    await expect.poll(() => controls.readSnapshotRequests()).toBeGreaterThan(snapshotRequestsBeforeRouting)

    await page.reload()
    await expect(routingPanel).toBeVisible()
    await expect(ambiencePanel).toBeHidden()
  })
}
