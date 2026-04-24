import { expect, test, type Page } from '@playwright/test'

import { WEATHER_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const createState = (theme: ThemeName) => createPlaywrightState({
  version: 1 as const,
  settings: {
    language: 'zh-CN',
    theme,
    fontScale: 1,
    lineHeightScale: 1,
    resilientProxyEnabled: true,
    experimentalWeatherEnabled: true,
    weatherCity: 'Shanghai',
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
      title: 'Layering Test',
      provider: 'codex' as const,
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      cards: [
        {
          id: 'card-1',
          title: '问题2',
          status: 'idle' as const,
          size: 560,
          provider: 'codex' as const,
          model: WEATHER_TOOL_MODEL,
          reasoningEffort: 'medium',
          draft: '',
          messages: [],
        },
      ],
    },
  ],
})

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  let state = createState(theme)

  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: () => false,
    })

    window.electronAPI = {
      ...window.electronAPI,
      fetchWeather: async () => ({
        condition: 'clear-night',
        city: 'Shanghai',
        temperature: 18,
        isDay: false,
        fetchedAt: new Date().toISOString(),
      }),
    }
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
  test(`weather tool cards keep their ambience glow visible without a redundant model picker in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const weatherCard = page.locator('[data-weather-card]').first()
    const ambientGlow = page.locator('.weather-ambient-glow').first()
    const paneView = page.locator('.pane-view').first()

    await expect(weatherCard).toBeVisible()
    await expect(ambientGlow).toBeVisible()
    await expect(paneView.locator('.model-select-shell')).toHaveCount(0)
  })
}
