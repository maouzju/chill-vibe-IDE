import { expect, test, type Page } from '@playwright/test'

import { BRAINSTORM_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createBrainstormToolState = (theme: 'dark' | 'light') =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      brainstormCardEnabled: true,
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
        title: 'Brainstorm Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'brainstorm-card',
            title: 'Brainstorm',
            status: 'idle' as const,
            size: 660,
            provider: 'codex' as const,
            model: BRAINSTORM_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: 'How can we make onboarding feel more playful for new users?',
            brainstorm: {
              prompt: 'How can we make onboarding feel more playful for new users?',
              provider: 'codex' as const,
              model: 'gpt-5.5',
              answerCount: 6,
              failedAnswers: [],
              answers: [
                {
                  id: 'idea-1',
                  content: 'Starter streak\n- Reward the first three setup steps\n- Show a visible momentum meter',
                  status: 'done' as const,
                  error: '',
                },
                {
                  id: 'idea-2',
                  content: 'Choose-your-own setup path\n- Let users pick ship fast or learn deeply\n- Tailor the checklist tone',
                  status: 'done' as const,
                  error: '',
                },
                {
                  id: 'idea-3',
                  content: 'First-win remix\n- Turn the first success into a shareable mini card\n- Encourage team bragging rights',
                  status: 'done' as const,
                  error: '',
                },
                {
                  id: 'idea-4',
                  content: 'Workspace side quest\n- Hide one optional surprise action after the basics',
                  status: 'done' as const,
                  error: '',
                },
                {
                  id: 'idea-5',
                  content: '',
                  status: 'error' as const,
                  error: 'Route was unavailable for this answer.',
                },
                {
                  id: 'idea-6',
                  content: 'Buddy unlock\n- Let an invited teammate unlock an extra onboarding shortcut',
                  status: 'done' as const,
                  error: '',
                },
              ],
            },
            messages: [],
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, theme: 'dark' | 'light') => {
  await installMockElectronBridge(page)

  let state = createBrainstormToolState(theme)

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
  test(`brainstorm card visual stays legible in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 1280, height: 920 })
    await page.goto(appUrl)

    const brainstormCard = page.locator('[data-brainstorm-card]').first()

    await expect(brainstormCard).toBeVisible()
    await expect(brainstormCard).toContainText('Brainstorm')
    await expect(brainstormCard).toContainText('Answer count')
    await expect(brainstormCard).toContainText('Delete all')

    await expect(brainstormCard).toHaveScreenshot(`brainstorm-card-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`brainstorm card visual stays compact in ${theme} narrow layout`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 680, height: 920 })
    await page.goto(appUrl)

    const brainstormCard = page.locator('[data-brainstorm-card]').first()

    await expect(brainstormCard).toBeVisible()
    await expect(brainstormCard).toHaveScreenshot(`brainstorm-card-narrow-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}
