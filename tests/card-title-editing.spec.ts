import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const createCardState = (id: string, title: string) => ({
  id,
  title,
  status: 'idle' as const,
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  messages: [],
})

const createState = (theme: ThemeName) =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
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
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Header Hit Targets',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          createCardState('card-1', 'Feature Chat'),
          createCardState('card-2', 'Review'),
        ],
      },
    ],
  })

const createOverflowingTabState = (theme: ThemeName) =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
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
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Overflow Tabs',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        width: 260,
        cards: [
          createCardState('card-1', 'Feature Chat'),
          createCardState('card-2', 'Review and polish'),
          createCardState('card-3', 'Release notes'),
          createCardState('card-4', 'Follow-up fixes'),
          createCardState('card-5', 'Regression sweep'),
          createCardState('card-6', 'Regression evidence checklist'),
          createCardState('card-7', 'Release verification follow-up'),
        ],
      },
    ],
  })

const createToolLauncherState = (theme: ThemeName) => {
  const state = createState(theme)
  state.settings.experimentalMusicEnabled = true
  state.settings.experimentalWhiteNoiseEnabled = true
  state.settings.experimentalWeatherEnabled = true
  return state
}

const installMockApis = async (
  page: Page,
  theme: ThemeName,
  options?: { state?: ReturnType<typeof createPlaywrightState> },
) => {
  await installMockElectronBridge(page)

  let state = options?.state ?? createState(theme)

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

  await page.route('**/api/git/status**', async (route) => {
    const workspacePath =
      new URL(route.request().url()).searchParams.get('workspacePath') ?? 'd:\\Git\\chill-vibe'
    await route.fulfill({
      json: {
        workspacePath,
        isRepository: true,
        repoRoot: workspacePath,
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasConflicts: false,
        clean: true,
        summary: {
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
        },
        changes: [],
        description: '',
      },
    })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

}

for (const theme of ['dark', 'light'] as const) {
  test(`clicking a pane tab activates it while the content header stays title-free in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const featureTab = page.locator('.pane-tab', { hasText: 'Feature Chat' })
    const reviewTab = page.locator('.pane-tab', { hasText: 'Review' })
    const duplicatedTitles = page.locator('.pane-content .card-title')
    const activePanePanel = page.locator('.pane-view').first().locator('.pane-content > .pane-tab-panel.is-active')

    await expect(featureTab).toHaveClass(/is-active/)
    await expect(reviewTab).not.toHaveClass(/is-active/)
    await expect(duplicatedTitles).toHaveCount(0)

    await reviewTab.click()

    await expect(reviewTab).toHaveClass(/is-active/)
    await expect(featureTab).not.toHaveClass(/is-active/)
    await expect(duplicatedTitles).toHaveCount(0)
    await expect(page.locator('.pane-content .card-header .model-select-shell')).toHaveCount(0)
    await expect(activePanePanel.locator('.composer-input-row .model-select-shell')).toBeVisible()
  })

  test(`clicking a pane tab close button closes only that tab in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const featureTab = page.locator('.pane-tab', { hasText: 'Feature Chat' })
    const reviewTab = page.locator('.pane-tab', { hasText: 'Review' })
    const featureClose = featureTab.locator('.pane-tab-close')

    await expect(page.locator('.pane-tab')).toHaveCount(2)
    await expect(featureTab).toHaveClass(/is-active/)
    await expect(featureClose).toBeVisible()

    await featureClose.click()

    await expect(featureTab).toHaveCount(0)
    await expect(page.locator('.pane-tab')).toHaveCount(1)
    await expect(reviewTab).toHaveClass(/is-active/)
    await expect(page.locator('.pane-content .card-title')).toHaveCount(0)
  })

  test(`clicking a pane tab lets the user type immediately in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const reviewTab = page.locator('.pane-tab', { hasText: 'Review' })
    const composer = page
      .locator('.pane-view')
      .first()
      .locator('.pane-content > .pane-tab-panel.is-active .composer textarea')

    await expect(composer).not.toBeFocused()

    await reviewTab.click()

    await expect(reviewTab).toHaveClass(/is-active/)
    await expect(composer).toBeFocused()

    await page.keyboard.type('hello after tab switch')
    await expect(composer).toHaveValue('hello after tab switch')
  })

  test(`double-clicking empty pane tab bar space opens a new tab in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const tabStrip = page.locator('.pane-tab-strip').first()
    const existingTabs = page.locator('.pane-tab')
    const activeTab = page.locator('.pane-tab.is-active')
    const composer = page
      .locator('.pane-view')
      .first()
      .locator('.pane-content > .pane-tab-panel.is-active .composer textarea')
    const tabStripBox = await tabStrip.boundingBox()

    if (!tabStripBox) {
      throw new Error('Expected the pane tab strip to be visible')
    }

    await expect(existingTabs).toHaveCount(2)

    await tabStrip.dblclick({
      position: {
        x: tabStripBox.width - 16,
        y: tabStripBox.height / 2,
      },
    })

    await expect(existingTabs).toHaveCount(3)
    await expect(activeTab).toContainText(/新会话|New Chat/)
    await expect(composer).toBeFocused()
  })

  test(`slight pointer movement while pressing a pane tab still activates it in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.goto('http://localhost:5173')

    const featureTab = page.locator('.pane-tab', { hasText: 'Feature Chat' })
    const reviewTab = page.locator('.pane-tab', { hasText: 'Review' })
    const reviewComposer = page
      .locator('.pane-view')
      .first()
      .locator('.pane-content > .pane-tab-panel.is-active .composer textarea')
    const reviewBox = await reviewTab.boundingBox()

    if (!reviewBox) {
      throw new Error('Expected the Review tab to be visible')
    }

    await page.mouse.move(reviewBox.x + reviewBox.width / 2, reviewBox.y + reviewBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(reviewBox.x + reviewBox.width / 2 + 4, reviewBox.y + reviewBox.height / 2 + 1)
    await page.mouse.up()

    await expect(reviewTab).toHaveClass(/is-active/)
    await expect(featureTab).not.toHaveClass(/is-active/)
    await expect(reviewComposer).toBeFocused()
  })

  test(`pane tabs stay reachable without horizontal wheel panning in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme, { state: createOverflowingTabState(theme) })
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto('http://localhost:5173')

    const tabStrip = page.locator('.pane-tab-strip').first()
    const lastTab = page.locator('.pane-tab', { hasText: 'Release verification follow-up' })
    const tabStripBox = await tabStrip.boundingBox()

    if (!tabStripBox) {
      throw new Error('Expected the pane tab strip to be visible')
    }

    const initialMetrics = await tabStrip.evaluate((node) => ({
      scrollLeft: node.scrollLeft,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }))

    expect(initialMetrics.scrollWidth).toBeLessThanOrEqual(initialMetrics.clientWidth + 1)
    await expect(lastTab).toBeVisible()

    await page.mouse.move(tabStripBox.x + tabStripBox.width / 2, tabStripBox.y + tabStripBox.height / 2)
    await page.mouse.wheel(0, 280)

    await expect
      .poll(async () => tabStrip.evaluate((node) => node.scrollLeft))
      .toBeLessThanOrEqual(initialMetrics.scrollLeft + 1)

    await expect(lastTab).toBeVisible()
  })

  test(`model picker docks beside the composer while quick tool entries live in the empty chat canvas in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme, { state: createToolLauncherState(theme) })
    await page.goto('http://localhost:5173')

    const paneView = page.locator('.pane-view').first()
    const composerRow = paneView.locator('.composer-input-row')
    const composerModelSelect = composerRow.locator('.model-select-shell').first()
    const headerModelSelect = paneView.locator('.card-header .model-select-shell')
    const emptyToolButtons = paneView.locator('.chat-empty-tool-button')

    await expect(composerModelSelect).toBeVisible()
    await expect(headerModelSelect).toHaveCount(0)
    await expect(page.locator('.app-topbar-tool-button')).toHaveCount(0)
    await expect(emptyToolButtons).toHaveCount(6)

    const [rowBox, selectBox, textareaBox] = await Promise.all([
      composerRow.boundingBox(),
      composerModelSelect.boundingBox(),
      paneView.locator('.composer textarea').boundingBox(),
    ])

    if (!rowBox || !selectBox || !textareaBox) {
      throw new Error('Expected the composer row geometry to be measurable')
    }

    expect(selectBox.x).toBeLessThan(textareaBox.x)
    expect(Math.abs(selectBox.y - textareaBox.y)).toBeLessThan(12)

    await composerModelSelect.locator('.model-select').click()
    const dropdown = page.locator('.model-dropdown-menu').first()
    await expect(dropdown).toBeVisible()
    await expect(dropdown).not.toContainText('Git')
    await expect(dropdown).not.toContainText('Files')
    await expect(dropdown).not.toContainText('Sticky Note')
    await expect(dropdown).not.toContainText('SPEC')
    await expect(dropdown).not.toContainText('PM')
    await expect(dropdown).not.toContainText('Weather')
    await expect(dropdown).not.toContainText('Music')
    await expect(dropdown).not.toContainText('White Noise')

    await page.getByRole('button', { name: /Weather|天气/ }).click()
    await expect(page.locator('[data-weather-card]')).toBeVisible()
    await expect(page.locator('.pane-tab', { hasText: /Weather|天气/ })).toHaveCount(1)
  })

  test(`quick tool entries collapse to a single column in a narrow pane in ${theme} theme`, async ({ page }) => {
    const state = createToolLauncherState(theme)

    await installMockApis(page, theme, { state })
    await page.setViewportSize({ width: 430, height: 820 })
    await page.goto('http://localhost:5173')

    const toolButtons = page.locator('.pane-view').first().locator('.chat-empty-tool-button')
    await expect(toolButtons).toHaveCount(6)

    const [firstBox, secondBox] = await Promise.all([
      toolButtons.nth(0).boundingBox(),
      toolButtons.nth(1).boundingBox(),
    ])

    if (!firstBox || !secondBox) {
      throw new Error('Expected narrow-pane tool button geometry to be measurable')
    }

    expect(Math.abs(firstBox.x - secondBox.x)).toBeLessThan(4)
    expect(secondBox.y).toBeGreaterThan(firstBox.y + firstBox.height - 4)
  })
}
