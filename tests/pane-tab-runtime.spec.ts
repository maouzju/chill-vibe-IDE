import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import type { AppState, ChatMessage } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const createHistoryMessage = (cardId: string, index: number): ChatMessage => ({
  id: `${cardId}-message-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `${cardId} message ${index + 1}: ${'detail '.repeat(48)}`,
  createdAt: new Date(Date.UTC(2026, 3, 12, 1, Math.floor(index / 60), index % 60)).toISOString(),
  meta: index % 2 === 0 ? undefined : { provider: 'codex' },
})

const createChatCard = (
  id: string,
  title: string,
  options: {
    messageCount?: number
    status?: 'idle' | 'streaming'
    streamId?: string
    sessionId?: string
  } = {},
) => ({
  id,
  title,
  status: options.status ?? 'idle',
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.4',
  reasoningEffort: 'medium',
  draft: '',
  streamId: options.streamId,
  sessionId: options.sessionId,
  messages: Array.from({ length: options.messageCount ?? 0 }, (_, index) => createHistoryMessage(id, index)),
})

const createState = (): AppState => {
  const cards = [
    createChatCard('card-1', 'History 1', { messageCount: 180 }),
    createChatCard('card-2', 'Live Crash Repro', {
      messageCount: 220,
      status: 'streaming',
      streamId: 'hidden-stream-1',
      sessionId: 'hidden-session-1',
    }),
    createChatCard('card-3', 'History 2', { messageCount: 180 }),
    createChatCard('card-4', 'History 3', { messageCount: 180 }),
    createChatCard('card-5', 'History 4', { messageCount: 180 }),
    createChatCard('card-6', 'Fresh Chat', { messageCount: 0 }),
  ]

  return createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme: 'dark',
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
    updatedAt: new Date('2026-04-12T01:30:00.000Z').toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Crash Repro',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards,
        layout: createPane(cards.map((card) => card.id), 'card-1', 'pane-1'),
      },
    ],
  })
}

const emitStreamEvent = async (
  page: Page,
  streamId: string,
  eventName: string,
  payload: unknown,
) => {
  await page.evaluate(
    ({ targetStreamId, targetEventName, nextPayload }) => {
      ;(
        window as typeof window & {
          __paneTabRuntimeTest?: {
            emit: (streamId: string, eventName: string, payload: unknown) => void
          }
        }
      ).__paneTabRuntimeTest?.emit(targetStreamId, targetEventName, nextPayload)
    },
    {
      targetStreamId: streamId,
      targetEventName: eventName,
      nextPayload: payload,
    },
  )
}

const installMockApis = async (page: Page) => {
  await page.addInitScript(() => {
    const sourcesByUrl = new Map<string, Set<MockEventSource>>()

    class MockEventSource {
      url: string
      withCredentials = false
      private listeners = new Map<string, Set<(event: MessageEvent) => void>>()

      constructor(url: string) {
        this.url = url
        const existing = sourcesByUrl.get(url)
        if (existing) {
          existing.add(this)
        } else {
          sourcesByUrl.set(url, new Set([this]))
        }
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type)
        if (listeners) {
          listeners.add(listener)
          return
        }

        this.listeners.set(type, new Set([listener]))
      }

      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        const listeners = this.listeners.get(type)
        if (!listeners) {
          return
        }

        listeners.delete(listener)
        if (listeners.size === 0) {
          this.listeners.delete(type)
        }
      }

      emit(type: string, data: unknown) {
        const listeners = this.listeners.get(type)
        if (!listeners || listeners.size === 0) {
          return
        }

        const event = new MessageEvent(type, { data: JSON.stringify(data) })
        for (const listener of listeners) {
          listener(event)
        }
      }

      close() {
        const sources = sourcesByUrl.get(this.url)
        if (!sources) {
          return
        }

        sources.delete(this)
        if (sources.size === 0) {
          sourcesByUrl.delete(this.url)
        }
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      writable: true,
      value: MockEventSource,
    })

    Object.defineProperty(window, '__paneTabRuntimeTest', {
      configurable: true,
      writable: true,
      value: {
        emit(streamId: string, eventName: string, payload: unknown) {
          const url = `/api/chat/stream/${encodeURIComponent(streamId)}`
          const sources = sourcesByUrl.get(url)
          if (!sources) {
            return 0
          }

          for (const source of sources) {
            source.emit(eventName, payload)
          }

          return sources.size
        },
      },
    })
  })

  await installMockElectronBridge(page)

  let state = createState()
  let requestCount = 0
  const prompts: string[] = []
  const streamIds: string[] = []

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
    requestCount += 1
    const request = JSON.parse(route.request().postData() ?? '{}')
    prompts.push(request.prompt ?? '')
    const streamId = `request-stream-${requestCount}`
    streamIds.push(streamId)
    await route.fulfill({
      json: { streamId },
    })
  })

  await page.route('**/api/chat/stop/*', async (route) => {
    await route.fulfill({ json: { stopped: true } })
  })

  return {
    readState: () => state,
    readRequestCount: () => requestCount,
    readPrompts: () => prompts.slice(),
    readStreamIds: () => streamIds.slice(),
  }
}

test('long pane tab switching stays interactive while hidden streams and fresh runs continue', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  const mock = await installMockApis(page)

  await page.setViewportSize({ width: 1440, height: 940 })
  await page.goto(appUrl)

  await expect(page.locator('.pane-tab')).toHaveCount(6)
  await expect(page.locator('.pane-tab.is-streaming:not(.is-active)')).toHaveCount(1)
  await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('History 1')

  for (const title of ['History 2', 'History 3', 'History 4', 'Fresh Chat']) {
    await page.locator('.pane-tab').filter({ hasText: title }).first().click()
    await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText(title)
  }

  await emitStreamEvent(page, 'hidden-stream-1', 'delta', {
    content: 'background stream delta after repeated tab switches',
  })
  await emitStreamEvent(page, 'hidden-stream-1', 'done', { stopped: false })

  await expect.poll(() => mock.readState().columns[0]?.cards['card-2']?.status).toBe('idle')

  const activePane = page.locator('.pane-tab-panel.is-active')
  const textarea = activePane.locator('.composer textarea')
  const sendButton = activePane.getByRole('button', { name: 'Send message' })

  await expect(textarea).toBeVisible()

  for (const prompt of ['first runtime check', 'second runtime check']) {
    await textarea.fill(prompt)
    await sendButton.click()

    await expect.poll(() => mock.readState().columns[0]?.cards['card-6']?.status).toBe('streaming')

    const streamId = mock.readStreamIds().at(-1)
    expect(streamId).toBeTruthy()

    await emitStreamEvent(page, streamId!, 'session', {
      sessionId: `${streamId}-session`,
    })
    await emitStreamEvent(page, streamId!, 'delta', {
      content: `${prompt} response`,
    })
    await emitStreamEvent(page, streamId!, 'done', { stopped: false })

    await expect.poll(() => mock.readState().columns[0]?.cards['card-6']?.status).toBe('idle')
    await page.locator('.pane-tab').filter({ hasText: 'History 3' }).first().click()
    await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('History 3')
    await page.locator('.pane-tab').filter({ hasText: 'Fresh Chat' }).first().click()
    await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Fresh Chat')
  }

  expect(mock.readRequestCount()).toBe(2)
  const prompts = mock.readPrompts()
  expect(prompts[0]).toBe('first runtime check')
  expect(prompts[1]).toContain('second runtime check')
  expect(pageErrors).toEqual([])

  await expect(page.locator('.pane-view')).toBeVisible()
  await expect(activePane.locator('.message-list')).toBeVisible()
})
