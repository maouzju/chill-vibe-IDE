import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark' as const,
      repeatLoopEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-repeat',
        title: 'Repeat Loop',
        provider: 'codex' as const,
        workspacePath: 'D:/Git/chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-repeat-1',
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

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    state = createPlaywrightState(JSON.parse(route.request().postData() ?? '{}'))
    await route.fulfill({ json: state })
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
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })
  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })
}

const installMockChatBridge = async (page: Page) => {
  await page.evaluate(() => {
    const win = window as Window & {
      electronAPI: NonNullable<typeof window.electronAPI>
      __repeatLoopPrompts?: string[]
    }

    const dispatchStreamEvent = (subscriptionId: string, eventName: string, data: unknown) => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:chat-stream', {
          detail: { subscriptionId, event: eventName, data },
        }),
      )
    }

    win.__repeatLoopPrompts = []
    win.electronAPI.requestChat = async (request) => {
      const prompts = [
        ...(win.__repeatLoopPrompts ?? []),
        typeof request.prompt === 'string' ? request.prompt : '',
      ]
      win.__repeatLoopPrompts = prompts
      return { streamId: `repeat-stream-${prompts.length}` }
    }
    win.electronAPI.stopChat = async () => undefined
    win.electronAPI.subscribeChatStream = async (streamId, subscriptionId) => {
      const iteration = Number(streamId.split('-').at(-1) ?? '1')
      window.setTimeout(() => {
        dispatchStreamEvent(subscriptionId, 'delta', {
          content: `Completed repeat iteration ${iteration}.`,
        })
        dispatchStreamEvent(subscriptionId, 'done', {})
      }, iteration === 1 ? 60 : 900)
    }
    win.electronAPI.unsubscribeChatStream = async () => undefined
  })
}

const readPrompts = (page: Page) =>
  page.evaluate(() => {
    const win = window as Window & { __repeatLoopPrompts?: string[] }
    return win.__repeatLoopPrompts ?? []
  })

test('a checked repeat loop opens a fresh tab, reruns the earliest prompt, and stops after unchecking', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)
  await installMockChatBridge(page)

  const activePanel = page.locator('.pane-tab-panel.is-active')
  const settingsTrigger = activePanel.locator('.composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()
  const activeTextarea = activePanel.locator('.composer textarea')

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()
  const activeRepeatToggle = settingsMenu.getByLabel('Repeat loop')
  await expect(activeRepeatToggle).toBeVisible()
  await activeRepeatToggle.check()
  await settingsTrigger.click()
  await activeTextarea.fill('Run the same verification from scratch.')
  await activePanel.getByRole('button', { name: 'Send message' }).click()

  await expect.poll(() => readPrompts(page)).toEqual([
    'Run the same verification from scratch.',
    'Run the same verification from scratch.',
  ])
  await expect(page.locator('.pane-tab')).toHaveCount(2)
  await expect(activePanel.locator('.repeat-loop-status')).toBeVisible()
  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()
  await expect(activeRepeatToggle).toBeChecked()
  await expect(activePanel.locator('.composer textarea')).toHaveValue('')

  await activeRepeatToggle.uncheck()
  await expect(activeRepeatToggle).not.toBeChecked()
  await expect(activePanel.locator('.repeat-loop-status')).toBeHidden()
  await settingsTrigger.click()
  await page.waitForTimeout(1_100)

  await expect(page.locator('.pane-tab')).toHaveCount(2)
  await expect.poll(() => readPrompts(page)).toEqual([
    'Run the same verification from scratch.',
    'Run the same verification from scratch.',
  ])
})
