import { expect, test, type Page } from '@playwright/test'

import { BRAINSTORM_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      brainstormCardEnabled: true,
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
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Brainstorm Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Brainstorm',
            status: 'idle' as const,
            size: 660,
            provider: 'codex' as const,
            model: BRAINSTORM_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            brainstorm: {
              prompt: '',
              provider: 'codex' as const,
              model: 'gpt-5.4',
              answerCount: 6,
              failedAnswers: [],
              answers: [],
            },
            messages: [],
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createState()

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

const installMockBrainstormChatBridge = async (page: Page) => {
  await page.evaluate(() => {
    const win = window as Window & {
      electronAPI: NonNullable<typeof window.electronAPI>
      __brainstormRequests?: Array<{
        provider: string
        model: string
        prompt: string
      }>
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

    win.__brainstormRequests = []

    win.electronAPI.requestChat = async (request) => {
      const requests = [
        ...(win.__brainstormRequests ?? []),
        {
          provider: String(request.provider ?? ''),
          model: String(request.model ?? ''),
          prompt: String(request.prompt ?? ''),
        },
      ]
      win.__brainstormRequests = requests
      return { streamId: `brainstorm-stream-${requests.length}` }
    }

    win.electronAPI.stopChat = async () => undefined
    win.electronAPI.subscribeChatStream = async (streamId, subscriptionId) => {
      const responses = [
        '',
        'Confetti checkpoints\n- Reward the first three setup wins\n- Let users see momentum immediately',
        'Pick-your-path onboarding\n- Offer ship fast and learn deeply routes\n- Match the tone to the path',
        'Buddy unlock\n- Invite a teammate to reveal one hidden shortcut\n- Make collaboration the playful payoff',
        'Warm-up quest\n- Turn the setup into a tiny side quest\n- Keep the reward practical, not childish',
      ]

      const streamIndex = Number(streamId.split('-').pop() ?? '0')
      const response = responses[streamIndex] ?? `Extra idea ${streamIndex}`

      window.setTimeout(() => {
        dispatchStreamEvent(subscriptionId, 'delta', { content: response })
        dispatchStreamEvent(subscriptionId, 'done', {})
      }, 30)
    }

    win.electronAPI.unsubscribeChatStream = async () => undefined
  })
}

const readBrainstormRequests = (page: Page) =>
  page.evaluate(() =>
    (
      (window as Window & {
        __brainstormRequests?: Array<{ provider: string; model: string; prompt: string }>
      }).__brainstormRequests ?? []
    ).map((request) => ({ ...request })),
  )

const normalizeMultiline = (value: string | null) => value?.replace(/\s+/g, ' ').trim() ?? ''

test('brainstorm card forwards the raw topic, fills answers in parallel, and refills deleted slots', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)
  await installMockBrainstormChatBridge(page)

  await expect(page.locator('[data-brainstorm-card]')).toBeVisible()

  const topic = 'How can we make onboarding feel more playful for new users?'

  await page.locator('.brainstorm-textarea').fill(topic)
  await page.locator('.brainstorm-count-input').fill('3')
  await page.getByRole('button', { name: 'Start Brainstorm' }).click()

  await expect.poll(() => readBrainstormRequests(page).then((requests) => requests.length)).toBe(3)
  await expect.poll(() => readBrainstormRequests(page)).toEqual([
    { provider: 'codex', model: 'gpt-5.4', prompt: topic },
    { provider: 'codex', model: 'gpt-5.4', prompt: topic },
    { provider: 'codex', model: 'gpt-5.4', prompt: topic },
  ])
  await expect(page.locator('.brainstorm-answer-card')).toHaveCount(3)
  await expect(page.locator('.brainstorm-answer-card').nth(0)).toContainText('Confetti checkpoints')
  await expect(page.locator('.brainstorm-answer-card').nth(1)).toContainText('Pick-your-path onboarding')
  await expect(page.locator('.brainstorm-answer-card').nth(2)).toContainText('Buddy unlock')

  const deletedAnswer = await page.locator('.brainstorm-answer-card').nth(0).locator('.brainstorm-answer-body').textContent()
  await page.locator('.brainstorm-answer-card').nth(0).locator('.brainstorm-answer-delete').click()

  await expect.poll(() => readBrainstormRequests(page).then((requests) => requests.length)).toBe(4)
  const requestsAfterDelete = await readBrainstormRequests(page)
  expect(requestsAfterDelete.at(-1)).toEqual({
    provider: 'codex',
    model: 'gpt-5.4',
    prompt: topic,
  })
  expect(normalizeMultiline(deletedAnswer)).not.toHaveLength(0)

  await expect(page.locator('.brainstorm-answer-card')).toHaveCount(3)
  await expect(page.locator('.brainstorm-answer-card').last()).toContainText('Warm-up quest')
})

test('brainstorm card lets users choose the request model per card', async ({ page }) => {
  await installMockApis(page)
  await page.goto(appUrl)
  await installMockBrainstormChatBridge(page)

  const cardShell = page.locator('.card-shell').first()
  const modelSelect = cardShell.locator('.model-select').first()

  await expect(modelSelect).toBeVisible()
  await modelSelect.click()
  await page.getByRole('option', { name: 'Opus 4.6' }).click()

  await page.locator('.brainstorm-textarea').fill('Pitch three directions for a calmer empty state.')
  await page.locator('.brainstorm-count-input').fill('1')
  await page.getByRole('button', { name: 'Start Brainstorm' }).click()

  await expect.poll(() => readBrainstormRequests(page)).toEqual([
    {
      provider: 'claude',
      model: 'claude-opus-4-6',
      prompt: 'Pitch three directions for a calmer empty state.',
    },
  ])
})
