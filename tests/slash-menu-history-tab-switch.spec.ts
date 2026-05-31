import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import type { AppState, ChatMessage, SlashCommand } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = 'http://localhost:5173'

const slashCommands: SlashCommand[] = [
  {
    name: 'compact',
    source: 'native',
    description: 'Compact the current session context.',
  },
  {
    name: 'review',
    source: 'native',
    description: 'Review the current changes in this workspace.',
  },
  {
    name: 'check-all',
    source: 'skill',
    skillProvider: 'codex',
    description: 'Run the broad repo-local regression workflow and collect screenshot-backed evidence.',
  },
  {
    name: 'agent-reach',
    source: 'skill',
    skillProvider: 'claude',
    description: 'Search the web and supported platforms while keeping the workspace context.',
  },
  {
    name: 'context',
    source: 'native',
    description: 'Show the current context and token usage.',
  },
]

const createHistoryMessage = (cardId: string, index: number): ChatMessage => ({
  id: `${cardId}-message-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `${cardId} message ${index + 1}: ${'detail '.repeat(64)}`,
  createdAt: new Date(Date.UTC(2026, 3, 12, 1, Math.floor(index / 60), index % 60)).toISOString(),
  meta: index % 2 === 0 ? undefined : { provider: 'codex' },
})

const createState = (theme: 'dark' | 'light'): AppState => {
  const cards = [
    {
      id: 'card-history-1',
      title: 'Very Long History 1',
      status: 'idle' as const,
      size: 560,
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: '',
      messages: Array.from({ length: 260 }, (_, index) => createHistoryMessage('card-history-1', index)),
    },
    {
      id: 'card-history-2',
      title: 'Very Long History 2',
      status: 'idle' as const,
      size: 560,
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: '',
      messages: Array.from({ length: 340 }, (_, index) => createHistoryMessage('card-history-2', index)),
    },
    {
      id: 'card-fresh',
      title: 'Fresh Chat',
      status: 'idle' as const,
      size: 560,
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: '',
      messages: [],
    },
  ]

  return createPlaywrightState({
    version: 1 as const,
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
    updatedAt: new Date('2026-04-12T01:30:00.000Z').toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Slash History Repro',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards,
        layout: createPane(cards.map((card) => card.id), 'card-fresh', 'pane-1'),
      },
    ],
  })
}

const installMockApis = async (page: Page, initialState: AppState) => {
  await installMockElectronBridge(page)

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
    await route.fulfill({ json: slashCommands })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`switching from long history tabs keeps slash menu stable in ${theme} theme`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })

    await installMockApis(page, createState(theme))
    await page.setViewportSize({ width: 1320, height: 860 })
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      if (window.electronAPI) {
        window.electronAPI.queueStateSave = () => undefined
      }
    })

    const activeTab = page.locator('.pane-tab.is-active .pane-tab-label')
    const slashMenu = page.locator('.slash-command-menu').first()
    const activePanel = page.locator('.pane-tab-panel.is-active')
    const paneContent = page.locator('.pane-content').first()

    await expect(activeTab).toHaveText('Fresh Chat')

    const assertSlashMenuInsidePane = async (title: string) => {
      const textarea = activePanel.locator('.composer textarea').first()
      await expect(textarea).toBeVisible()
      await textarea.fill('/')
      await expect(slashMenu).toBeVisible()
      await expect.poll(async () => slashMenu.locator('.slash-command-item').count()).toBe(slashCommands.length)

      const [menuBox, paneContentBox] = await Promise.all([
        slashMenu.boundingBox(),
        paneContent.boundingBox(),
      ])

      expect(menuBox, `expected slash menu geometry for ${title}`).toBeTruthy()
      expect(paneContentBox, `expected pane geometry for ${title}`).toBeTruthy()
      if (!menuBox || !paneContentBox) {
        return
      }

      expect(menuBox.x).toBeGreaterThanOrEqual(paneContentBox.x - 1)
      expect(menuBox.y).toBeGreaterThanOrEqual(paneContentBox.y - 1)
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(paneContentBox.x + paneContentBox.width + 1)
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(paneContentBox.y + paneContentBox.height + 1)

      const menuUsesBodyLayer = await page.evaluate(() => {
        const menu = document.querySelector('.slash-command-menu')
        return menu?.parentElement === document.body
      })
      expect(menuUsesBodyLayer).toBeTruthy()
      await textarea.press('Escape')
      await expect(slashMenu).toBeHidden()
    }

    for (const title of ['Very Long History 1', 'Very Long History 2', 'Fresh Chat']) {
      await page.locator('.pane-tab').filter({ hasText: title }).first().click()
      await expect(activeTab).toHaveText(title)
      await assertSlashMenuInsidePane(title)
    }

    expect(pageErrors).toEqual([])

    const panelStillVisible = await activePanel.locator('.message-list').isVisible()
    expect(panelStillVisible).toBeTruthy()

    await expect(page.locator('.pane-view')).toBeVisible()
    await expect(page.locator('.pane-tab.is-active')).toContainText('Fresh Chat')
  })
}
