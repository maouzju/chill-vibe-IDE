import { expect, test, type Page } from '@playwright/test'

import type { AppState } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createState = (theme: 'dark' | 'light'): AppState => createPlaywrightState({
  version: 1,
  settings: {
    language: 'en',
    theme,
    fontScale: 1,
    lineHeightScale: 1,
    resilientProxyEnabled: true,
    requestModels: {
      codex: 'gpt-5.4',
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
  updatedAt: '2026-04-07T08:00:00.000Z',
  columns: [
    {
      id: 'col-1',
      title: 'Workspace 1',
      provider: 'codex',
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      cards: [
        {
          id: 'card-1',
          title: 'Feature Chat',
          status: 'streaming',
          size: 560,
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          draft: '',
          streamId: 'stream-1',
          sessionId: 'session-1',
          messages: [
            {
              id: 'command-1',
              role: 'assistant',
              content: '',
              createdAt: '2026-04-07T08:00:01.000Z',
              meta: {
                provider: 'codex',
                kind: 'command',
                structuredData: JSON.stringify({
                  itemId: 'item_1',
                  status: 'completed',
                  command: 'git status --short',
                  output: 'M src/App.tsx',
                  exitCode: 0,
                }),
              },
            },
            {
              id: 'command-2',
              role: 'assistant',
              content: '',
              createdAt: '2026-04-07T08:00:02.000Z',
              meta: {
                provider: 'codex',
                kind: 'command',
                structuredData: JSON.stringify({
                  itemId: 'item_2',
                  status: 'completed',
                  command: 'pnpm test',
                  output: '2 passed',
                  exitCode: 0,
                }),
              },
            },
            {
              id: 'reasoning-1',
              role: 'assistant',
              content: '',
              createdAt: '2026-04-07T08:00:03.000Z',
              meta: {
                provider: 'codex',
                kind: 'reasoning',
                structuredData: JSON.stringify({
                  itemId: 'item_3',
                  status: 'completed',
                  text: '**Planning**\n\nCheck the renderer bridge next.',
                }),
              },
            },
          ],
        },
      ],
    },
  ],
})

const installMockApis = async (page: Page, theme: 'dark' | 'light') => {
  await installMockElectronBridge(page)

  let state = createState(theme)

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

for (const theme of ['dark', 'light'] as const) {
  test(`command groups collapse after the stream switches to reasoning in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme)
    await page.goto(appUrl)

    const commandGroup = page.locator('.structured-command-group').first()
    const reasoningCard = page.locator('.structured-reasoning-card').first()

    await expect(commandGroup.locator('.structured-group-summary-text')).toContainText('Ran 2 commands')
    await expect(reasoningCard).toContainText('Check the renderer bridge next.')
    await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(0)
    await expect(commandGroup.locator('.structured-command-stack')).toHaveCount(0)
    await expect(commandGroup.locator('.structured-group-chevron')).not.toHaveClass(/is-open/)
  })
}
