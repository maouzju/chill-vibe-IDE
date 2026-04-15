import { expect, test, type Page } from '@playwright/test'

import { createPane, createSplit } from '../shared/default-state.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState, getColumnCardIds } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createSinglePaneState = () => {
  const now = new Date().toISOString()

  return createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
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
        title: 'Dev',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Chat 1',
            status: 'idle' as const,
            size: 440,
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
}

const createSplitPaneState = () => {
  const now = new Date().toISOString()

  return createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
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
        title: 'Dev',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Chat 1',
            status: 'idle' as const,
            size: 440,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
          {
            id: 'card-2',
            title: 'Chat 2',
            status: 'idle' as const,
            size: 440,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
        layout: createSplit(
          'horizontal',
          [
            createPane(['card-1'], 'card-1', 'pane-left'),
            createPane(['card-2'], 'card-2', 'pane-right'),
          ],
          [0.5, 0.5],
          'split-root',
        ),
      },
    ],
  })
}

const mockAppApis = async (page: Page, initialState = createSinglePaneState()) => {
  await installMockElectronBridge(page)

  let state = initialState

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
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

  return {
    readState: () => state,
  }
}

test('adding a card from the pane tab strip appends a new active tab to the pane', async ({ page }) => {
  const mock = await mockAppApis(page)
  await page.goto(appUrl)

  await page.locator('.pane-tab:has-text("Chat 1")').waitFor()
  await page.locator('.pane-view').first().locator('.pane-add-tab').click()

  await expect(page.locator('.pane-content > .pane-tab-panel:not([hidden]) .card-shell')).toHaveCount(1)
  await expect(page.locator('.pane-tab')).toHaveCount(2)
  await expect(page.locator('.pane-tab').first()).toContainText('Chat 1')
  await expect(page.locator('.pane-tab').nth(1)).not.toContainText('Chat 1')
  await expect(page.locator('.pane-tab.is-active')).not.toContainText('Chat 1')
  await expect.poll(() => getColumnCardIds(mock.readState())[0]).toBe('card-1')
  await expect.poll(() => getColumnCardIds(mock.readState()).length).toBe(2)
})

test('adding a card from the pane tab strip follows the active split pane', async ({ page }) => {
  await mockAppApis(page, createSplitPaneState())
  await page.goto(appUrl)

  const leftPane = page.locator('.pane-view').first()
  const rightPane = page.locator('.pane-view').nth(1)

  await expect(leftPane.locator('.pane-tab')).toHaveCount(1)
  await expect(rightPane.locator('.pane-tab')).toHaveCount(1)

  await rightPane.locator('.pane-tab').getByText('Chat 2').click()
  await rightPane.locator('.pane-add-tab').click()

  await expect(leftPane.locator('.pane-tab')).toHaveCount(1)
  await expect(rightPane.locator('.pane-tab')).toHaveCount(2)
  await expect(rightPane.locator('.pane-tab.is-active')).not.toContainText('Chat 2')
})
