import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const createRestoredMessage = (index: number, createdAt: string) => ({
  id: `restored-msg-${index + 1}`,
  role: index % 2 === 0 ? ('assistant' as const) : ('user' as const),
  content: `${index % 2 === 0 ? 'Assistant' : 'User'} restored message ${index + 1}: ${'detail '.repeat(36)}`,
  createdAt,
})

const readMessageListMetrics = async (page: Page) =>
  page.locator('.pane-tab-panel.is-active .message-list').evaluate((node) => ({
    scrollTop: node.scrollTop,
    maxScrollTop: Math.max(node.scrollHeight - node.clientHeight, 0),
    distanceToBottom: Math.max(node.scrollHeight - node.clientHeight - node.scrollTop, 0),
  }))

const installExternalHistoryBridge = async (page: Page) => {
  await page.addInitScript(() => {
    const parseJson = async (response: Response) => {
      const raw = await response.text().catch(() => '')
      const payload = raw.trim().length > 0 ? JSON.parse(raw) : null

      if (!response.ok) {
        const message =
          payload && typeof payload === 'object' && typeof payload.message === 'string'
            ? payload.message
            : `Request failed (${response.status}).`
        throw new Error(message)
      }

      return payload
    }

    const electronApi = window.electronAPI as
      | (Window['electronAPI'] & {
          listExternalHistory?: (request: { workspacePath: string }) => Promise<unknown>
        })
      | undefined

    if (!electronApi) {
      return
    }

    electronApi.listExternalHistory = async (request) =>
      parseJson(await fetch(`/api/external-history?workspacePath=${encodeURIComponent(request.workspacePath)}`))
  })
}

const installStateApis = async (
  page: Page,
  initialState: ReturnType<typeof createPlaywrightState>,
) => {
  let state = initialState

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

  await page.route('**/api/session-history/*', async (route) => {
    const url = new URL(route.request().url())
    const entryId = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    const entry = state.sessionHistory.find((item) => item.id === entryId)

    if (!entry) {
      await route.fulfill({
        status: 404,
        json: { message: 'Session history entry not found.' },
      })
      return
    }

    await route.fulfill({ json: { entry } })
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })
  })

  await page.route('**/api/state/snapshot', async (route) => {
    await route.fulfill({ status: 204 })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })
}

const mockAppApis = async (
  page: Page,
  options: {
    restoredMessages?: ReturnType<typeof createRestoredMessage>[]
  } = {},
) => {
  await installMockElectronBridge(page)

  const now = new Date().toISOString()
  const restoredMessages = options.restoredMessages ?? [
    {
      id: 'msg-1',
      role: 'assistant' as const,
      content: 'Restored message',
      createdAt: now,
    },
  ]

  const state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: {
          activeProfileId: 'codex-profile-1',
          profiles: [
            { id: 'codex-profile-1', name: 'Codex', apiKey: 'sk-codex', baseUrl: 'https://api.openai.example/v1' },
          ],
        },
        claude: {
          activeProfileId: 'claude-profile-1',
          profiles: [
            { id: 'claude-profile-1', name: 'Claude', apiKey: 'sk-claude', baseUrl: 'https://api.anthropic.example' },
          ],
        },
      },
    },
    updatedAt: now,
    columns: [
      {
        id: 'col-1',
        title: 'Workspace 1',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Existing Chat',
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
    sessionHistory: [
      {
        id: 'hist-1',
        title: 'Old Session',
        sessionId: 'old-session-1',
        provider: 'codex' as const,
        model: 'gpt-5.4',
        workspacePath: 'd:\\Git\\chill-vibe',
        messages: restoredMessages,
        archivedAt: now,
      },
    ],
  })

  await installStateApis(page, state)
}

const mockBackgroundTabApis = async (page: Page) => {
  await installMockElectronBridge(page)

  const now = new Date().toISOString()
  await installStateApis(page, createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: {
          activeProfileId: 'codex-profile-1',
          profiles: [
            { id: 'codex-profile-1', name: 'Codex', apiKey: 'sk-codex', baseUrl: 'https://api.openai.example/v1' },
          ],
        },
        claude: {
          activeProfileId: 'claude-profile-1',
          profiles: [
            { id: 'claude-profile-1', name: 'Claude', apiKey: 'sk-claude', baseUrl: 'https://api.anthropic.example' },
          ],
        },
      },
    },
    updatedAt: now,
    columns: [
      {
        id: 'col-1',
        title: 'Workspace 1',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Existing Chat',
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
            title: 'Background Chat',
            status: 'idle' as const,
            size: 440,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            messages: Array.from({ length: 28 }, (_, index) =>
              createRestoredMessage(index, new Date(Date.UTC(2026, 3, 5, 13, 0, index)).toISOString()),
            ),
          },
        ],
      },
    ],
    sessionHistory: [],
  }))
}

const mockHistorySearchApis = async (page: Page) => {
  await installMockElectronBridge(page)
  await installExternalHistoryBridge(page)

  const now = new Date().toISOString()
  await installStateApis(page, createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: {
          activeProfileId: 'codex-profile-1',
          profiles: [
            { id: 'codex-profile-1', name: 'Codex', apiKey: 'sk-codex', baseUrl: 'https://api.openai.example/v1' },
          ],
        },
        claude: {
          activeProfileId: 'claude-profile-1',
          profiles: [
            { id: 'claude-profile-1', name: 'Claude', apiKey: 'sk-claude', baseUrl: 'https://api.anthropic.example' },
          ],
        },
      },
    },
    updatedAt: now,
    columns: [
      {
        id: 'col-1',
        title: 'Workspace 1',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Existing Chat',
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
    sessionHistory: [
      {
        id: 'hist-search-1',
        title: 'Release checklist',
        sessionId: 'release-checklist',
        provider: 'codex' as const,
        model: 'gpt-5.4',
        workspacePath: 'd:\\Git\\chill-vibe',
        messages: [
          {
            id: 'message-search-1',
            role: 'assistant' as const,
            content: 'Search the regression details before packaging the build.',
            createdAt: now,
          },
        ],
        archivedAt: now,
      },
      {
        id: 'hist-search-2',
        title: 'Planning sync',
        sessionId: 'planning-sync',
        provider: 'claude' as const,
        model: 'claude-opus-4-7',
        workspacePath: 'd:\\Git\\docs-site',
        messages: [
          {
            id: 'message-search-2',
            role: 'assistant' as const,
            content: 'Review the docs wording after the feature lands.',
            createdAt: now,
          },
        ],
        archivedAt: now,
      },
    ],
  }))

  await page.route('**/api/external-history*', async (route) => {
    await route.fulfill({
      json: {
        sessions: [
          {
            id: 'external-search-1',
            title: 'Imported release prep',
            provider: 'codex',
            model: 'gpt-5.4',
            workspacePath: 'd:\\Git\\chill-vibe',
            messageCount: 12,
            startedAt: '2026-04-08T03:00:00.000Z',
            updatedAt: '2026-04-08T05:00:00.000Z',
          },
          {
            id: 'external-search-2',
            title: 'Claude research thread',
            provider: 'claude',
            model: 'claude-opus-4-1',
            workspacePath: 'd:\\Git\\docs-site',
            messageCount: 8,
            startedAt: '2026-04-07T03:00:00.000Z',
            updatedAt: '2026-04-07T05:00:00.000Z',
          },
        ],
      },
    })
  })
}

const openSessionHistoryMenu = async (page: Page) => {
  await page.locator('.column-actions .icon-button').first().click()
  await page.locator('.session-history-menu').waitFor()
}

test('restored session card receives a border flash animation class', async ({ page }) => {
  await mockAppApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await openSessionHistoryMenu(page)
  await page.locator('.session-history-item').first().click()

  const firstCard = page.locator('.card-shell').first()
  await expect(firstCard).toHaveClass(/is-restored-flash/)
})

test('restored card flash works in light theme', async ({ page }) => {
  await mockAppApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light')
  })

  await openSessionHistoryMenu(page)
  await page.locator('.session-history-item').first().click()

  const firstCard = page.locator('.card-shell').first()
  await expect(firstCard).toHaveClass(/is-restored-flash/)
})

test('restored card flash animation class is removed after animation ends', async ({ page }) => {
  await mockAppApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await openSessionHistoryMenu(page)
  await page.locator('.session-history-item').first().click()

  const firstCard = page.locator('.card-shell').first()
  await expect(firstCard).toHaveClass(/is-restored-flash/)

  await page.waitForTimeout(1500)
  await expect(firstCard).not.toHaveClass(/is-restored-flash/)
})

test('restored session with a short latest reply keeps the latest user prompt visible without forcing a sticky overlay', async ({ page }) => {
  const restoredMessages = [
    ...Array.from({ length: 7 }, (_, index) =>
      createRestoredMessage(index, new Date(Date.UTC(2026, 3, 5, 12, 0, index)).toISOString()),
    ),
    {
      id: 'restored-user-last',
      role: 'user' as const,
      content: 'Keep this prompt visible after restore.',
      createdAt: new Date(Date.UTC(2026, 3, 5, 12, 1, 0)).toISOString(),
    },
    {
      id: 'restored-assistant-last',
      role: 'assistant' as const,
      content: 'Short latest reply so the user prompt should stay sticky instead of dropping to the very bottom.',
      createdAt: new Date(Date.UTC(2026, 3, 5, 12, 1, 1)).toISOString(),
    },
  ]

  await mockAppApis(page, { restoredMessages })
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await openSessionHistoryMenu(page)
  await page.locator('.session-history-item').first().click()
  await page.locator('[data-renderable-id="restored-user-last"]').waitFor()
  await page.locator('[data-renderable-id="restored-assistant-last"]').waitFor()

  await expect(page.locator('[data-renderable-id="restored-user-last"]')).toContainText(
    'Keep this prompt visible after restore.',
  )
  await expect(page.locator('[data-renderable-id="restored-assistant-last"]')).toBeVisible()
  await expect(page.locator('.message-sticky-overlay')).toHaveCount(0)
})

test('restored session with a very long latest reply still lands on the latest output', async ({ page }) => {
  const restoredMessages = [
    ...Array.from({ length: 7 }, (_, index) =>
      createRestoredMessage(index, new Date(Date.UTC(2026, 3, 5, 12, 0, index)).toISOString()),
    ),
    {
      id: 'restored-user-long-tail',
      role: 'user' as const,
      content: 'This one should still open at the newest output because the final answer is long.',
      createdAt: new Date(Date.UTC(2026, 3, 5, 12, 1, 0)).toISOString(),
    },
    {
      id: 'restored-assistant-long-tail',
      role: 'assistant' as const,
      content: Array.from(
        { length: 72 },
        (_, index) => `Long restored reply line ${index + 1}: ${'detail '.repeat(16)}`,
      ).join('\n\n'),
      createdAt: new Date(Date.UTC(2026, 3, 5, 12, 1, 1)).toISOString(),
    },
  ]

  await mockAppApis(page, { restoredMessages })
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await openSessionHistoryMenu(page)
  await page.locator('.session-history-item').first().click()
  await page.locator('[data-renderable-id="restored-assistant-long-tail"]').waitFor()

  await expect(page.locator('[data-renderable-id="restored-assistant-long-tail"]')).toBeVisible()

  await expect
    .poll(async () => (await readMessageListMetrics(page)).distanceToBottom)
    .toBeLessThanOrEqual(1)
})

test('bringing a background tab to the front scrolls its message list to the latest message', async ({ page }) => {
  await mockBackgroundTabApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await page.locator('.pane-tab', { hasText: 'Background Chat' }).click()

  await expect
    .poll(async () => (await readMessageListMetrics(page)).distanceToBottom)
    .toBeLessThanOrEqual(1)
})

test('session history search filters internal entries by message content and shows a no-match empty state', async ({
  page,
}) => {
  await mockHistorySearchApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await openSessionHistoryMenu(page)

  const searchInput = page.getByLabel('搜索会话历史')
  await searchInput.fill('regression details')

  const historyItems = page.locator('.session-history-item')
  await expect(historyItems).toHaveCount(1)
  await expect(historyItems.first()).toContainText('Release checklist')

  await searchInput.fill('missing-history-term')
  await expect(historyItems).toHaveCount(0)
  await expect(page.locator('.session-history-empty')).toContainText('没有匹配的历史会话')
})

test('session history search filters external entries by summary metadata and shows a no-match empty state', async ({
  page,
}) => {
  await mockHistorySearchApis(page)
  await page.goto('http://localhost:5173')
  await page.locator('.card-shell').first().waitFor()

  await openSessionHistoryMenu(page)
  await page.getByRole('button', { name: '外部历史' }).click()

  const historyItems = page.locator('.session-history-item')
  await expect(historyItems).toHaveCount(2)

  const searchInput = page.getByLabel('搜索会话历史')
  await searchInput.fill('docs-site')

  await expect(historyItems).toHaveCount(1)
  await expect(historyItems.first()).toContainText('Claude research thread')

  await searchInput.fill('missing-external-history')
  await expect(historyItems).toHaveCount(0)
  await expect(page.locator('.session-history-empty')).toContainText('没有匹配的外部会话')
})
