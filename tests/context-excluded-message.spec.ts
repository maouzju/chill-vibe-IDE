import { expect, test, type Page } from '@playwright/test'

import type { AppState, ChatMessage } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { appUrl } from './playwright-app-url.ts'

type ThemeName = 'dark' | 'light'

const at = (index: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, index)).toISOString()

const createMessages = (): ChatMessage[] => [
  { id: 'm-user', role: 'user', content: 'Please finish the migration.', createdAt: at(0) },
  { id: 'm-real', role: 'assistant', content: 'Working on it, running the build now.', createdAt: at(1), meta: { provider: 'claude' } },
  {
    id: 'm-err',
    role: 'assistant',
    content: 'API Error: Request rejected (429) · upstream overloaded (request id: 20261118155443676-fc1cd409)',
    createdAt: at(2),
    meta: { provider: 'claude' },
  },
  { id: 'm-sys', role: 'system', content: 'Connection lost, retrying in 5 minutes.', createdAt: at(3) },
  { id: 'm-final', role: 'assistant', content: 'Build finished, all green.', createdAt: at(4), meta: { provider: 'claude' } },
]

const createState = (theme: ThemeName): AppState => createPlaywrightState({
  version: 1,
  settings: {
    language: 'en',
    theme,
    activeTopTab: 'ambience',
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
  updatedAt: new Date('2026-04-05T12:10:00.000Z').toISOString(),
  columns: [
    {
      id: 'col-1',
      title: 'Workspace 1',
      provider: 'codex',
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      cards: [
        {
          id: 'card-1',
          title: 'Feature Chat',
          status: 'idle',
          size: 560,
          provider: 'claude',
          model: 'claude-opus-4-7',
          reasoningEffort: 'medium',
          draft: '',
          messages: createMessages(),
        },
      ],
    },
  ],
})

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)
  const state = createState(theme)
  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    await route.fulfill({ json: state })
  })
  await page.route('**/api/state/snapshot', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    }),
  )
  await page.route('**/api/setup/status', (route) => route.fulfill({ json: { state: 'idle', logs: [] } }))
  await page.route('**/api/slash-commands', (route) => route.fulfill({ json: [] }))
}

for (const theme of ['dark', 'light'] as const) {
  test(`messages that never reach the model are greyed out in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto(appUrl)
    await expect(page.locator('.message').last()).toBeVisible()

    // 报错回显 + 普通系统提示置灰；真实回复不受影响
    await expect(page.locator('.message-context-excluded')).toHaveCount(2)
    await expect(page.locator('.message-context-excluded').first()).toContainText('API Error')
    await expect(page.locator('.message-assistant:not(.message-context-excluded)')).toHaveCount(2)
    await expect(page.locator('.message-user.message-context-excluded')).toHaveCount(0)

    await page.locator('.pane-tab-panel.is-active .message-list').first().scrollIntoViewIfNeeded()
    await expect(page.locator('.pane-tab-panel.is-active .message-list').first()).toHaveScreenshot(
      `context-excluded-messages-${theme}.png`,
    )
  })
}
