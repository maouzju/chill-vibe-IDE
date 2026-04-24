import { expect, test, type Page } from '@playwright/test'

import type { AppState, ChatMessage } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const getActiveMessageList = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .message-list').first()

const readMessageListMetrics = async (page: Page) =>
  getActiveMessageList(page).evaluate((node) => ({
    scrollTop: node.scrollTop,
    maxScrollTop: Math.max(node.scrollHeight - node.clientHeight, 0),
    distanceToBottom: Math.max(node.scrollHeight - node.clientHeight - node.scrollTop, 0),
  }))

const readAskUserCardHeight = async (page: Page) =>
  page.locator('.ask-user-card').evaluate((node) => node.getBoundingClientRect().height)

const scrollMessageListToBottom = async (page: Page) => {
  await getActiveMessageList(page).evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
}

const positionAskUserCardNearTop = async (page: Page) => {
  await getActiveMessageList(page).evaluate((node) => {
    const nextScrollTop = Math.max(node.scrollHeight - node.clientHeight - 320, 0)
    node.scrollTop = nextScrollTop
  })
}

const createHistoryMessage = (index: number): ChatMessage => ({
  id: `history-${index + 1}`,
  role: index % 2 === 0 ? 'assistant' : 'user',
  content: `${index % 2 === 0 ? 'Assistant' : 'User'} message ${index + 1}: ${'detail '.repeat(30)}`,
  createdAt: new Date(Date.UTC(2026, 3, 18, 12, 0, index)).toISOString(),
  meta: index % 2 === 0 ? { provider: 'codex' } : undefined,
})

const askUserOptions = [
  {
    label: 'Fast path',
    description:
      'Keep the current shape and patch the smallest diff while preserving the existing flow. '.repeat(
        5,
      ).trim(),
  },
  {
    label: 'Safer refactor',
    description:
      'Do a slightly larger cleanup first so the next changes do not keep reopening the same edge cases. '.repeat(
        5,
      ).trim(),
  },
  {
    label: 'Verify first',
    description:
      'Pause implementation long enough to confirm the exact repro surface before changing behavior. '.repeat(
        5,
      ).trim(),
  },
  {
    label: 'Instrument it',
    description:
      'Add narrow logging or targeted checks so the next run shows where the regression actually starts. '.repeat(
        5,
      ).trim(),
  },
]

const createAskUserMessage = (): ChatMessage => ({
  id: 'ask-user-message-1',
  role: 'assistant',
  content: '',
  createdAt: new Date(Date.UTC(2026, 3, 18, 12, 1, 0)).toISOString(),
  meta: {
    provider: 'codex',
    kind: 'ask-user',
    itemId: 'ask-user-message-1',
    structuredData: JSON.stringify({
      itemId: 'ask-user-message-1',
      kind: 'ask-user',
      status: 'completed',
      header: 'Need direction',
      question: 'Which approach should I take?',
      multiSelect: false,
      options: askUserOptions,
    }),
  },
})

const createState = (theme: ThemeName): AppState =>
  createPlaywrightState({
    version: 1,
    settings: {
      language: 'en',
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
    updatedAt: new Date('2026-04-18T12:10:00.000Z').toISOString(),
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
            title: 'Ask User Scroll Repro',
            status: 'idle',
            size: 560,
            provider: 'codex',
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [
              ...Array.from({ length: 28 }, (_, index) => createHistoryMessage(index)),
              createAskUserMessage(),
            ],
          },
        ],
      },
    ],
  })

const installMockStreamingApis = async (page: Page, theme: ThemeName) => {
  await page.addInitScript(() => {
    class MockEventSource {
      static instances = []
      url
      withCredentials = false
      listeners = new Map()
      onerror = null

      constructor(url) {
        this.url = url
        MockEventSource.instances.push(this)
      }

      addEventListener(eventName, listener) {
        const existing = this.listeners.get(eventName) ?? []
        existing.push(listener)
        this.listeners.set(eventName, existing)
      }

      removeEventListener(eventName, listener) {
        const existing = this.listeners.get(eventName)
        if (!existing) {
          return
        }

        this.listeners.set(
          eventName,
          existing.filter((candidate) => candidate !== listener),
        )
      }

      close() {}
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      writable: true,
      value: MockEventSource,
    })
  })

  await installMockElectronBridge(page)

  let state = createState(theme)
  const chatRequests: string[] = []
  const stopRequests: string[] = []
  let nextStreamNumber = 1

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

  await page.route('**/api/chat/message', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    chatRequests.push(typeof body.prompt === 'string' ? body.prompt : '')
    await route.fulfill({
      json: {
        streamId: `stream-${nextStreamNumber++}`,
      },
    })
  })

  await page.route('**/api/chat/stop/*', async (route) => {
    stopRequests.push(decodeURIComponent(route.request().url().split('/').at(-1) ?? ''))
    await route.fulfill({ status: 204 })
  })

  return {
    readChatRequests: () => chatRequests.slice(),
    readStopRequests: () => stopRequests.slice(),
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`answering ask-user does not snap a scrolled-up transcript to the bottom in ${theme} theme`, async ({
    page,
  }) => {
    const mockApis = await installMockStreamingApis(page, theme)

    await page.goto(appUrl)
    await expect(page.locator('.ask-user-card')).toBeVisible()

    await scrollMessageListToBottom(page)
    await expect
      .poll(async () => (await readMessageListMetrics(page)).distanceToBottom)
      .toBeLessThanOrEqual(1)

    await positionAskUserCardNearTop(page)
    await expect(page.locator('.ask-user-option').filter({ hasText: 'Fast path' })).toBeVisible()

    const before = await readMessageListMetrics(page)
    expect(before.distanceToBottom).toBeGreaterThan(200)

    await page.locator('.ask-user-option').filter({ hasText: 'Fast path' }).click()
    await page.keyboard.press('Enter')

    await expect
      .poll(() => mockApis.readChatRequests())
      .toEqual([
        expect.stringContaining('Latest user message:\nFast path'),
      ])
    await expect(page.locator('.ask-user-card.is-answered')).toBeVisible()
    await expect(getActiveMessageList(page)).toBeVisible()

    const after = await readMessageListMetrics(page)
    expect(after.distanceToBottom).toBeGreaterThan(120)
  })

  test(`answering ask-user keeps the transcript pinned when already at the bottom in ${theme} theme`, async ({
    page,
  }) => {
    const mockApis = await installMockStreamingApis(page, theme)

    await page.goto(appUrl)
    await expect(page.locator('.ask-user-card')).toBeVisible()

    await scrollMessageListToBottom(page)
    await expect
      .poll(async () => (await readMessageListMetrics(page)).distanceToBottom)
      .toBeLessThanOrEqual(1)

    await page.locator('.ask-user-option').filter({ hasText: 'Fast path' }).click()
    await page.keyboard.press('Enter')

    await expect
      .poll(() => mockApis.readChatRequests())
      .toEqual([
        expect.stringContaining('Latest user message:\nFast path'),
      ])
    await expect(page.locator('.ask-user-card.is-answered')).toBeVisible()
    await expect
      .poll(async () => (await readMessageListMetrics(page)).distanceToBottom)
      .toBeLessThanOrEqual(1)
  })

  test(`answering ask-user keeps the card height stable in ${theme} theme`, async ({
    page,
  }) => {
    const mockApis = await installMockStreamingApis(page, theme)

    await page.goto(appUrl)
    await expect(page.locator('.ask-user-card')).toBeVisible()

    const before = await readAskUserCardHeight(page)

    await page.locator('.ask-user-option').filter({ hasText: 'Fast path' }).click()
    await page.keyboard.press('Enter')

    await expect
      .poll(() => mockApis.readChatRequests())
      .toEqual([
        expect.stringContaining('Latest user message:\nFast path'),
      ])
    await expect(page.locator('.ask-user-card.is-answered')).toBeVisible()

    const after = await readAskUserCardHeight(page)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(4)
  })
}

test('ask-user double submit only starts one follow-up send and never interrupts itself', async ({ page }) => {
  const mockApis = await installMockStreamingApis(page, 'dark')

  await page.goto(appUrl)
  await expect(page.locator('.ask-user-card')).toBeVisible()

  await page.locator('.ask-user-option').filter({ hasText: 'Fast path' }).click()
  await expect(page.locator('.ask-user-submit')).toBeEnabled()

  await page.evaluate(() => {
    const button = document.querySelector('.ask-user-submit')
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Ask-user submit button was not found.')
    }

    button.click()
    button.click()
  })

  await expect
    .poll(() => mockApis.readChatRequests().length)
    .toBe(1)
  await expect
    .poll(() => mockApis.readStopRequests().length)
    .toBe(0)
  await expect(page.locator('.fatal-error-shell')).toHaveCount(0)
  await expect(page.locator('.ask-user-card.is-answered')).toBeVisible()
})
