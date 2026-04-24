import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'
const defaultAutoUrgeMessage = 'Please keep verifying until you have evidence.'

const readPrompts = (page: Page) =>
  page.evaluate(() => {
    const win = window as Window & { __autoUrgePrompts?: string[] }
    return win.__autoUrgePrompts ?? []
  })

const getActiveComposerTextarea = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .composer textarea')

const expectRecordedPromptsToContain = async (page: Page, expectedTexts: string[]) => {
  await expect.poll(async () => {
    const prompts = await readPrompts(page)
    let lastMatchedIndex = -1

    for (const text of expectedTexts) {
      const nextIndex = prompts.findIndex((prompt, index) => index > lastMatchedIndex && prompt.includes(text))
      if (nextIndex === -1) {
        return false
      }
      lastMatchedIndex = nextIndex
    }

    return true
  }).toBe(true)
}

const installMockApis = async (
  page: Page,
  options?: {
    language?: 'zh-CN' | 'en'
    autoUrgeEnabled?: boolean
    autoUrgeMessage?: string
    autoUrgeSuccessKeyword?: string
    cardMessages?: Array<Record<string, unknown>>
  },
) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: options?.language ?? 'en',
      theme: 'dark' as const,
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
      autoUrgeEnabled: options?.autoUrgeEnabled ?? true,
      autoUrgeProfiles: [
        {
          id: 'auto-urge-default',
          name: options?.language === 'zh-CN' ? '默认鞭策' : 'Default Type',
          message: options?.autoUrgeMessage ?? defaultAutoUrgeMessage,
          successKeyword: options?.autoUrgeSuccessKeyword ?? 'YES',
        },
      ],
      autoUrgeActiveProfileId: 'auto-urge-default',
      autoUrgeMessage: options?.autoUrgeMessage ?? defaultAutoUrgeMessage,
      autoUrgeSuccessKeyword: options?.autoUrgeSuccessKeyword ?? 'YES',
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Auto Urge',
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
            messages: options?.cardMessages ?? [],
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
      __autoUrgePrompts?: string[]
    }

    const dispatchStreamEvent = (subscriptionId: string, eventName: string, data: unknown) => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:chat-stream', {
          detail: {
            subscriptionId,
            event: eventName,
            data,
          },
        }),
      )
    }

    win.__autoUrgePrompts = []
    win.electronAPI.requestChat = async (request) => {
      win.__autoUrgePrompts = [
        ...(win.__autoUrgePrompts ?? []),
        typeof request.prompt === 'string' ? request.prompt : '',
      ]

      return {
        streamId: (win.__autoUrgePrompts?.length ?? 0) > 1 ? 'stream-2' : 'stream-1',
      }
    }
    win.electronAPI.stopChat = async () => undefined
    win.electronAPI.subscribeChatStream = async (streamId, subscriptionId) => {
      window.setTimeout(() => {
        if (streamId === 'stream-1') {
          dispatchStreamEvent(subscriptionId, 'delta', {
            content: 'I only have a guess so far, not a verified fix.',
          })
          dispatchStreamEvent(subscriptionId, 'done', {})
          return
        }

        dispatchStreamEvent(subscriptionId, 'delta', {
          content: 'Still validating. YES',
        })
        dispatchStreamEvent(subscriptionId, 'done', {})
      }, 30)
    }
    win.electronAPI.unsubscribeChatStream = async () => undefined
  })
}

test('composer settings hosts the auto urge toggle for an existing chat', async ({ page }) => {
  await installMockApis(page, {
    cardMessages: [
      {
        id: 'msg-1',
        role: 'assistant',
        content: 'I have not finished verifying yet.',
        createdAt: new Date().toISOString(),
      },
    ],
  })
  await page.goto(appUrl)
  await installMockChatBridge(page)

  const settingsTrigger = page.locator('.composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()
  const autoUrgeStatus = page.locator('.composer-auto-urge-status').first()

  await expect(page.locator('.composer-auto-pua-toggle')).toHaveCount(0)
  await expect(autoUrgeStatus).toHaveCount(0)

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()

  const autoUrgeToggle = settingsMenu.getByLabel('Auto Urge')
  await expect(autoUrgeToggle).not.toBeChecked()
  await autoUrgeToggle.check()
  await expect(autoUrgeToggle).toBeChecked()
  await expect(autoUrgeStatus).toContainText('Urging...')

  await expectRecordedPromptsToContain(page, [defaultAutoUrgeMessage])
})

test('fresh chats stay manual even when auto urge is enabled in settings', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)
  await installMockChatBridge(page)

  const settingsTrigger = page.locator('.composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()
  const textarea = getActiveComposerTextarea(page)
  const sendButton = page.getByRole('button', { name: 'Send message' })

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()
  await expect(settingsMenu.getByLabel('Auto Urge')).not.toBeChecked()

  await textarea.waitFor()
  await textarea.fill('Please fix this bug.')
  await sendButton.click()

  await expectRecordedPromptsToContain(page, ['Please fix this bug.'])
})

test('settings can add named auto urge profiles and each chat picks one manually', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)
  await installMockChatBridge(page)

  await page.locator('#app-tab-settings').click()

  const settingsPanel = page.locator('#app-panel-settings')
  const utilityGroup = settingsPanel.locator('.settings-group').filter({ hasText: 'Utility' }).first()

  await expect(utilityGroup).toBeVisible()
  await utilityGroup.getByRole('button', { name: 'Add Auto Urge Type' }).click()

  const profileCards = utilityGroup.locator('.auto-urge-profile-card')
  await expect(profileCards).toHaveCount(2)

  const customProfile = profileCards.nth(1)
  await customProfile.getByLabel('Type Name').fill('Release Guard')
  await customProfile.getByLabel('Urge Message').fill('Keep checking until release evidence is attached.')
  await customProfile.getByLabel('Success Keyword').fill('SHIP')

  await expect(utilityGroup.getByRole('button', { name: 'Use This Type' })).toHaveCount(0)
  await expect(utilityGroup.getByRole('button', { name: 'Current Type' })).toHaveCount(0)

  await page.locator('#app-tab-ambience').click()

  const settingsTrigger = page.locator('.composer-settings-trigger').first()
  const settingsMenu = page.locator('.composer-settings-menu').first()

  await settingsTrigger.click()
  await expect(settingsMenu).toBeVisible()
  await settingsMenu.locator('.composer-auto-urge-profile-select').selectOption({ label: 'Release Guard' })
  await settingsMenu.getByLabel('Auto Urge').check()

  await expectRecordedPromptsToContain(page, ['Keep checking until release evidence is attached.'])
})
