import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

type MockCardFixture = {
  id: string
  title: string
  messages?: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    createdAt: string
  }>
}

/**
 * Regression test: adding a card in a narrow column must not freeze the
 * renderer. The original failure was a ResizeObserver -> setState feedback
 * loop triggered by sub-pixel jitter in getBoundingClientRect().
 */
const createCardFixture = (
  id: string,
  title: string,
  messageCount = 0,
  contentRepeat = 64,
): MockCardFixture => ({
  id,
  title,
  messages: Array.from({ length: messageCount }, (_, index) => ({
    id: `${id}-message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1} ${'x'.repeat(contentRepeat)}`,
    createdAt: new Date(Date.UTC(2026, 3, 9, 0, 0, index)).toISOString(),
  })),
})

const mockAppApis = async (
  page: Page,
  options: {
    cards?: MockCardFixture[]
    language?: 'en' | 'zh-CN'
    workspacePath?: string
  } = {},
) => {
  await installMockElectronBridge(page)

  const now = new Date().toISOString()
  const {
    cards = [createCardFixture('card-1', 'Chat 1')],
    language = 'zh-CN',
    workspacePath = 'd:\\Git\\chill-vibe',
  } = options

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language,
      theme: 'dark' as const,
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
    updatedAt: now,
    columns: [
      {
        id: 'col-1',
        title: 'Dev',
        provider: 'codex' as const,
        workspacePath,
        model: 'gpt-5.5',
        cards: cards.map((card) => ({
          id: card.id,
          title: card.title,
          status: 'idle' as const,
          size: 440,
          provider: 'codex' as const,
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          draft: '',
          messages: card.messages ?? [],
        })),
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

test('adding a card in a narrow column does not freeze', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 520, height: 1200 })
  await page.goto(appUrl)

  await page.locator('.pane-tab:has-text("Chat 1")').waitFor()
  await expect(page.locator('.card-shell')).toHaveCount(1)
  await expect(page.locator('.pane-tab')).toHaveCount(1)
  await expect(page.locator('.pane-tab.is-active')).toContainText('Chat 1')

  await page.locator('.pane-add-tab').click()

  await expect(page.locator('.pane-tab')).toHaveCount(2)
  await expect(page.locator('.pane-tab-panel')).toHaveCount(2)
  await expect(page.locator('.pane-tab-panel.is-active .card-shell')).toHaveCount(1, { timeout: 3000 })
  await expect(page.locator('.pane-tab.is-active')).toContainText('\u65b0\u4f1a\u8bdd')
  await expect(page.locator('.pane-tab').filter({ hasText: 'Chat 1' })).toHaveCount(1)

  const newCardTextarea = page.locator('.pane-tab-panel.is-active .card-shell textarea')
  await newCardTextarea.click({ timeout: 2000 })
  await expect(newCardTextarea).toBeFocused()
})

test('adding a tab with many existing chats stays responsive without maximum-depth crashes', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  await page.setViewportSize({ width: 900, height: 900 })
  await mockAppApis(page, {
    language: 'en',
    cards: Array.from({ length: 18 }, (_, index) =>
      createCardFixture(`card-${index + 1}`, `Chat ${index + 1}`, 180, 400),
    ),
  })
  await page.goto(appUrl)

  await page.getByRole('button', { name: 'Chat 1', exact: true }).waitFor()
  pageErrors.length = 0

  await page.locator('.pane-add-tab').click()

  await expect(page.locator('.pane-tab.is-active')).toContainText('New chat', { timeout: 10000 })
  await expect(page.locator('.pane-tab-panel.is-active .textarea')).toBeVisible({ timeout: 10000 })
  expect(
    pageErrors.some((message) => message.includes('Maximum update depth exceeded')),
  ).toBeFalsy()
})
