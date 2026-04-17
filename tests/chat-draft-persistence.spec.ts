import { expect, test, type Page } from '@playwright/test'

import { createCard, createDefaultState, createPane, createSplit } from '../shared/default-state.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const installMockApis = async (page: Page, initialState?: ReturnType<typeof createPlaywrightState>) => {
  await installMockElectronBridge(page)

  let saveStateRequests = 0
  let snapshotRequests = 0
  let state = initialState ?? createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN' as const,
      theme: 'dark' as const,
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
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Draft Persistence',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: 'idle' as const,
            size: 560,
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

  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: () => false,
    })
  })

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      saveStateRequests += 1
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    snapshotRequests += 1
    state = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({ status: 204, body: '' })
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

  return {
    readSaveStateRequests: () => saveStateRequests,
    readSnapshotRequests: () => snapshotRequests,
  }
}

test('chat drafts survive a reload only after a durable save', async ({ page }) => {
  const counters = await installMockApis(page)
  await page.goto(appUrl)

  const textarea = page.locator('.textarea').first()
  const draftText = '这段草稿需要立刻持久化保存'

  await textarea.waitFor()
  await textarea.fill(draftText)
  await expect(textarea).toHaveValue(draftText)

  await page.waitForTimeout(400)
  expect(counters.readSnapshotRequests()).toBe(0)

  await page.locator('.card-shell').first().click()
  await expect.poll(() => counters.readSnapshotRequests()).toBeGreaterThan(0)

  await page.reload()
  await textarea.waitFor()
  await expect(textarea).toHaveValue(draftText)
})

test('rapid draft bursts coalesce into one durable save and keep the latest text', async ({ page }) => {
  const counters = await installMockApis(page)
  await page.goto(appUrl)

  const textarea = page.locator('.textarea').first()
  const bursts = [
    'Rapid draft pressure test: ',
    'users keep changing their mind mid-sentence, ',
    'the composer should stay responsive, ',
    'the debounce should avoid writing on every burst, ',
    'and the final text still needs to survive a reload.',
  ]

  await textarea.waitFor()
  await textarea.click()

  const saveBaseline = counters.readSnapshotRequests()
  let expectedDraft = ''

  for (const burst of bursts) {
    await page.keyboard.type(burst)
    expectedDraft += burst
    await expect(textarea).toHaveValue(expectedDraft)
    await page.waitForTimeout(120)
    expect(counters.readSnapshotRequests()).toBe(
      saveBaseline,
    )
  }

  await page.waitForTimeout(3_200)
  await expect.poll(() => counters.readSnapshotRequests() - saveBaseline).toBe(1)

  await page.reload()
  await textarea.waitFor()
  await expect(textarea).toHaveValue(expectedDraft)
})

test('drafts persist for chat panes created from the real default-state helpers', async ({ page }) => {
  const state = createDefaultState('d:\\Git\\chill-vibe', 'en')
  state.settings.theme = 'dark'
  state.columns = [state.columns[0]!]

  const firstColumn = state.columns[0]!
  const firstCardId = Object.keys(firstColumn.cards)[0]!
  const secondCard = createCard('Review Chat', 420, firstColumn.provider, firstColumn.model, 'medium', 'en')

  firstColumn.cards = {
    ...firstColumn.cards,
    [secondCard.id]: secondCard,
  }
  firstColumn.layout = createSplit(
    'horizontal',
    [
      createPane([firstCardId], firstCardId, 'pane-left'),
      createPane([secondCard.id], secondCard.id, 'pane-right'),
    ],
    [0.62, 0.38],
    'split-root',
  )

  const counters = await installMockApis(page, createPlaywrightState(state))

  await page.goto(appUrl)

  const textarea = page.locator('.pane-view').first().locator('.textarea')
  const draftText = 'pane draft should survive reload'

  await textarea.waitFor()
  await textarea.click()
  await page.keyboard.type(draftText)
  await expect(textarea).toHaveValue(draftText)

  await page.waitForTimeout(3_200)
  await expect.poll(() => counters.readSnapshotRequests()).toBeGreaterThan(0)

  await page.reload()
  await textarea.waitFor()
  await expect(textarea).toHaveValue(draftText)
})

test('same-pane tab switches keep the latest draft when inactive chat bodies unload', async ({ page }) => {
  const initialState = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
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
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Pane Draft Tabs',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Draft Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
          {
            id: 'card-2',
            title: 'Reference Chat',
            status: 'idle' as const,
            size: 560,
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

  const counters = await installMockApis(page, initialState)
  await page.goto(appUrl)

  const activePane = page.locator('.pane-tab-panel.is-active')
  const textarea = activePane.locator('.textarea')
  const draftText = 'pane tab draft should survive tab switches'

  await textarea.waitFor()
  await textarea.fill(draftText)
  await expect(textarea).toHaveValue(draftText)

  await page.locator('.pane-tab').filter({ hasText: 'Reference Chat' }).first().click()
  await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Reference Chat')
  await expect.poll(() => counters.readSnapshotRequests()).toBeGreaterThan(0)

  await page.locator('.pane-tab').filter({ hasText: 'Draft Chat' }).first().click()
  await expect(page.locator('.pane-tab.is-active .pane-tab-label')).toHaveText('Draft Chat')
  await expect(page.locator('.pane-tab-panel.is-active .textarea')).toHaveValue(draftText)

  await page.reload()
  await page.locator('.pane-tab').filter({ hasText: 'Draft Chat' }).first().click()
  await expect(page.locator('.pane-tab-panel.is-active .textarea')).toHaveValue(draftText)
})
