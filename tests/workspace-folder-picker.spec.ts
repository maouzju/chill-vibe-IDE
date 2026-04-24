import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const selectedWorkspacePath = 'd:\\Git\\picked-workspace'

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  await page.addInitScript(({ pickedPath }) => {
    const pickerWindow = window as Window & {
      __folderDialogCallCount?: number
      electronAPI: Window['electronAPI']
    }

    pickerWindow.__folderDialogCallCount = 0
    pickerWindow.electronAPI.openFolderDialog = async () => {
      pickerWindow.__folderDialogCallCount = (pickerWindow.__folderDialogCallCount ?? 0) + 1
      return pickedPath
    }
  }, { pickedPath: selectedWorkspacePath })

  const now = new Date().toISOString()

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
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
    updatedAt: now,
    columns: [
      {
        id: 'col-1',
        title: 'Workspace 1',
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
    await route.fulfill({ status: 204, body: '' })
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

  await page.route('**/api/onboarding/status', async (route) => {
    await route.fulfill({
      json: {
        ready: true,
        missing: [],
      },
    })
  })
}

const readFolderDialogCallCount = (page: Page) =>
  page.evaluate(() => {
    const pickerWindow = window as Window & { __folderDialogCallCount?: number }
    return pickerWindow.__folderDialogCallCount ?? 0
  })

for (const theme of ['dark', 'light'] as const) {
  test(`folder picker button opens the desktop dialog while the path input is focused in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const titleButton = page.getByRole('button', { name: 'chill-vibe' })
    await titleButton.waitFor()
    await titleButton.click()

    const pathInput = page.locator('.workspace-path-input')
    await expect(pathInput).toBeFocused()

    await page.getByRole('button', { name: /Select folder/i }).click()

    await expect.poll(() => readFolderDialogCallCount(page)).toBe(1)
    await expect(page.getByRole('button', { name: 'picked-workspace' })).toBeVisible()
  })
}
