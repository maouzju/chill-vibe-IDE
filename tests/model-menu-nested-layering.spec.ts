import { expect, test, type Page } from '@playwright/test'

import { createPane, createSplit } from '../shared/default-state.ts'
import type { AppState } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const createNestedSplitState = (theme: ThemeName) => createPlaywrightState({
  version: 1 as const,
  settings: {
    language: 'en',
    theme,
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
  updatedAt: new Date().toISOString(),
  columns: [
    {
      id: 'col-nested',
      title: 'Nested Layering Test',
      provider: 'codex' as const,
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.4',
      cards: [
        {
          id: 'card-left',
          title: 'Reference Pane',
          status: 'idle' as const,
          size: 560,
          provider: 'codex' as const,
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          draft: 'Keep this pane mounted beside the nested split.',
          messages: [],
        },
        {
          id: 'card-top',
          title: 'Covering Top Pane',
          status: 'idle' as const,
          size: 560,
          provider: 'codex' as const,
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          draft: 'The lower pane menu should layer above this surface.',
          messages: [],
        },
        {
          id: 'card-bottom',
          title: 'Picker Owner',
          status: 'idle' as const,
          size: 560,
          provider: 'codex' as const,
          model: 'gpt-5.4',
          reasoningEffort: 'medium',
          draft: 'Open the card type menu from the lower-right pane.',
          messages: [],
        },
      ],
      layout: createSplit(
        'horizontal',
        [
          createPane(['card-left'], 'card-left', 'pane-left'),
          createSplit(
            'vertical',
            [
              createPane(['card-top'], 'card-top', 'pane-top'),
              createPane(['card-bottom'], 'card-bottom', 'pane-bottom'),
            ],
            [0.78, 0.22],
            'split-right',
          ),
        ],
        [0.52, 0.48],
        'split-root',
      ),
    },
  ],
})

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
    await route.fulfill({ json: [] })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`nested split model menu stays above upper sibling panes in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, createNestedSplitState(theme))
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto('http://localhost:5173')

    const paneViews = page.locator('.pane-view')
    const topPane = paneViews.nth(1)
    const bottomPane = paneViews.nth(2)
    const modelSelect = bottomPane.locator('.composer-input-row .model-select').first()
    const modelMenu = page.locator('.model-dropdown-menu').first()

    await expect(paneViews).toHaveCount(3)
    await expect(topPane).toBeVisible()
    await expect(bottomPane).toBeVisible()
    await expect(modelSelect).toBeVisible()

    await modelSelect.click()
    await expect(modelMenu).toBeVisible()

    const menuUsesBodyLayer = await page.evaluate(() => {
      const menu = document.querySelector('.model-dropdown-menu')
      return menu?.parentElement === document.body
    })

    expect(menuUsesBodyLayer).toBeTruthy()

    const [menuBox, topPaneBox] = await Promise.all([
      modelMenu.boundingBox(),
      topPane.boundingBox(),
    ])

    if (!menuBox || !topPaneBox) {
      throw new Error('Expected nested pane geometry to be measurable')
    }

    const overlapTop = Math.max(menuBox.y, topPaneBox.y)
    const overlapBottom = Math.min(menuBox.y + menuBox.height, topPaneBox.y + topPaneBox.height)
    const overlapHeight = overlapBottom - overlapTop

    expect(overlapHeight).toBeGreaterThan(48)

    const hit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      return {
        className: target instanceof HTMLElement ? target.className : '',
        insideMenu: Boolean(target instanceof Element && target.closest('.model-dropdown-menu')),
      }
    }, {
      x: menuBox.x + menuBox.width / 2,
      y: overlapTop + overlapHeight / 2,
    })

    expect(
      hit.insideMenu,
      `Expected the lower pane menu to stay on top of the upper pane, got ${hit.className}`,
    ).toBeTruthy()
  })
}
