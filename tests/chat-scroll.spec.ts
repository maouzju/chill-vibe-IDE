import { expect, test, type Page } from '@playwright/test'

import type { AppState, ChatMessage } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const getActivePaneMessageList = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .message-list').first()

const getActiveComposerTextarea = (page: Page) =>
  page.locator('.pane-tab-panel.is-active .composer textarea')

const createHistoryMessage = (index: number): ChatMessage => ({
  id: `message-${index + 1}`,
  role: index % 2 === 0 ? 'assistant' : 'user',
  content: `${index % 2 === 0 ? 'Assistant' : 'User'} message ${index + 1}: ${'detail '.repeat(36)}`,
  createdAt: new Date(Date.UTC(2026, 3, 5, 12, 0, index)).toISOString(),
  meta: index % 2 === 0 ? { provider: 'codex' } : undefined,
})

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
      codex: 'gpt-5.4',
      claude: 'claude-opus-4-6',
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
      model: 'gpt-5.4',
      cards: [
        {
          id: 'card-1',
          title: 'Feature Chat',
          status: 'idle',
          size: 560,
          provider: 'codex',
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          draft: '',
          messages: Array.from({ length: 28 }, (_, index) => createHistoryMessage(index)),
        },
      ],
    },
  ],
})

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  let state = createState(theme)
  let chatRequestCount = 0

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
    chatRequestCount += 1
    await route.fulfill({
      status: 500,
      json: { message: 'blocked by scroll regression test' },
    })
  })

  return {
    readChatRequestCount: () => chatRequestCount,
  }
}

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

      emit(eventName, data) {
        const event = new MessageEvent(eventName, {
          data: JSON.stringify(data),
        })
        for (const listener of this.listeners.get(eventName) ?? []) {
          listener(event)
        }
      }
    }

    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      writable: true,
      value: MockEventSource,
    })

    window.__chatScrollTest = {
      emit(eventName, data, index = 0) {
        const source = MockEventSource.instances[index]
        if (!source) {
          throw new Error(`No mock chat stream at index ${index}`)
        }
        source.emit(eventName, data)
      },
      sourceCount() {
        return MockEventSource.instances.length
      },
    }
  })

  await installMockElectronBridge(page)

  let state = createState(theme)
  let chatRequestCount = 0

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
    chatRequestCount += 1
    await route.fulfill({
      json: { streamId: `stream-${chatRequestCount}` },
    })
  })

  return {
    readChatRequestCount: () => chatRequestCount,
  }
}

const readScrollMetrics = async (page: Page) =>
  getActivePaneMessageList(page).evaluate((node) => ({
    scrollTop: node.scrollTop,
    maxScrollTop: Math.max(node.scrollHeight - node.clientHeight, 0),
    distanceToBottom: Math.max(node.scrollHeight - node.clientHeight - node.scrollTop, 0),
  }))

const createEditFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/generated/file-${index + 1}.ts`,
    kind: 'modified' as const,
    addedLines: 20 + index,
    removedLines: 4,
    patch: [
      `diff --git a/src/generated/file-${index + 1}.ts b/src/generated/file-${index + 1}.ts`,
      `--- a/src/generated/file-${index + 1}.ts`,
      `+++ b/src/generated/file-${index + 1}.ts`,
      '@@ -1,2 +1,22 @@',
      '-export const before = true',
      `+export const after${index + 1} = true`,
      ...Array.from({ length: 18 }, (_entry, lineIndex) => `+const line${lineIndex + 1} = ${index + lineIndex + 1}`),
    ].join('\n'),
  }))

const readMockStreamSourceCount = async (page: Page) =>
  page.evaluate(
    () =>
      (
        window as typeof window & {
          __chatScrollTest?: {
            sourceCount: () => number
          }
        }
      ).__chatScrollTest?.sourceCount() ?? 0,
  )

const emitMockStreamEvent = async (
  page: Page,
  eventName: string,
  data: unknown,
  index = 0,
) => {
  await page.evaluate(
    ([nextEventName, nextData, nextIndex]) => {
      ;(
        window as typeof window & {
          __chatScrollTest?: {
            emit: (eventName: string, data: unknown, index?: number) => void
          }
        }
      ).__chatScrollTest?.emit(nextEventName, nextData, nextIndex)
    },
    [eventName, data, index] as const,
  )
}

for (const theme of ['dark', 'light'] as const) {
  test(`failed sends still snap the list back to the bottom in ${theme} theme`, async ({
    page,
  }) => {
    const mockApis = await installMockApis(page, theme)

    await page.goto(appUrl)
    await expect(page.locator('.message').last()).toBeVisible()

    const messageList = getActivePaneMessageList(page)

    await messageList.evaluate((node) => {
      node.scrollTop = Math.max(node.scrollHeight - node.clientHeight - 320, 0)
    })

    const before = await readScrollMetrics(page)
    expect(before.maxScrollTop).toBeGreaterThan(320)
    expect(before.distanceToBottom).toBeGreaterThan(200)

    const textarea = getActiveComposerTextarea(page)
    await textarea.fill('Keep my place while new output arrives')
    await page.getByRole('button', { name: /send/i }).click()

    await expect.poll(() => mockApis.readChatRequestCount()).toBe(1)
    await page.waitForTimeout(400)

    const after = await readScrollMetrics(page)
    expect(after.distanceToBottom).toBeLessThanOrEqual(1)
  })

  test(`sending a new message snaps the list back to the bottom in ${theme} theme`, async ({ page }) => {
    const mockApis = await installMockStreamingApis(page, theme)

    await page.goto(appUrl)
    await expect(page.locator('.message').last()).toBeVisible()

    const messageList = getActivePaneMessageList(page)
    await messageList.evaluate((node) => {
      node.scrollTop = Math.max(node.scrollHeight - node.clientHeight - 320, 0)
    })

    const before = await readScrollMetrics(page)
    expect(before.maxScrollTop).toBeGreaterThan(320)
    expect(before.distanceToBottom).toBeGreaterThan(200)

    const textarea = getActiveComposerTextarea(page)
    await textarea.fill('Scroll me back down after send')
    await page.getByRole('button', { name: /send/i }).click()

    await expect.poll(() => mockApis.readChatRequestCount()).toBe(1)
    await expect.poll(async () => (await readScrollMetrics(page)).distanceToBottom).toBeLessThanOrEqual(1)
  })

  test(`streamed agent output stays pinned to the bottom after a user sends a new message in ${theme} theme`, async ({
    page,
  }) => {
    const mockApis = await installMockStreamingApis(page, theme)

    await page.goto(appUrl)
    await expect(page.locator('.message').last()).toBeVisible()

    const messageList = getActivePaneMessageList(page)
    await messageList.evaluate((node) => {
      node.scrollTop = Math.max(node.scrollHeight - node.clientHeight - 320, 0)
    })

    const textarea = getActiveComposerTextarea(page)
    await textarea.fill('Send and keep following the reply')
    await page.getByRole('button', { name: /send/i }).click()

    await expect.poll(() => mockApis.readChatRequestCount()).toBe(1)
    await expect.poll(async () => readMockStreamSourceCount(page)).toBe(1)

    await emitMockStreamEvent(page, 'delta', {
      content: `${'Agent reply detail '.repeat(180)}\n${'More output '.repeat(220)}`,
    })

    await expect.poll(async () => (await readScrollMetrics(page)).distanceToBottom).toBeLessThanOrEqual(1)
  })

  test(`completion keeps tool-heavy chat output pinned to the bottom in ${theme} theme`, async ({ page }) => {
    const mockApis = await installMockStreamingApis(page, theme)

    await page.goto(appUrl)
    const textarea = getActiveComposerTextarea(page)
    await expect(textarea).toBeVisible({ timeout: 15000 })
    await textarea.fill('Finish the run without jumping upward')
    await page.getByRole('button', { name: /send/i }).click()

    await expect.poll(() => mockApis.readChatRequestCount()).toBe(1)
    await expect.poll(async () => readMockStreamSourceCount(page)).toBe(1)

    await emitMockStreamEvent(page, 'activity', {
      itemId: 'edit-pass-1',
      kind: 'edits',
      status: 'completed',
      files: createEditFiles(14),
    })

    await emitMockStreamEvent(page, 'assistant_message', {
      itemId: 'final-answer',
      content: `${'Wrapped up the edits and verified the result. '.repeat(120)}`,
    })

    await expect.poll(async () => (await readScrollMetrics(page)).distanceToBottom).toBeLessThanOrEqual(1)

    await emitMockStreamEvent(page, 'done', {})

    await expect.poll(async () => (await readScrollMetrics(page)).distanceToBottom).toBeLessThanOrEqual(1)
  })
}
