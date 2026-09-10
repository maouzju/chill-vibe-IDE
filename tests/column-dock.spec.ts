import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const createColumnFixture = (
  id: string,
  workspacePath: string,
  docked?: true,
  cardPatch: Record<string, unknown> = {},
) => ({
  id,
  title: `Workspace ${id}`,
  provider: 'codex' as const,
  workspacePath,
  model: 'gpt-5.5',
  ...(docked ? { docked } : {}),
  cards: [
    {
      id: `${id}-card`,
      title: `${id} chat`,
      status: 'idle' as const,
      size: 560,
      provider: 'codex' as const,
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      draft: '',
      messages: [],
      ...cardPatch,
    },
  ],
})

const mockAppApis = async (
  page: Page,
  theme: 'light' | 'dark',
  columns?: ReturnType<typeof createColumnFixture>[],
) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
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
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: columns ?? [
      createColumnFixture('col-1', 'd:\\Git\\alpha'),
      createColumnFixture('col-2', 'd:\\Git\\beta', true),
      createColumnFixture('col-3', 'd:\\Git\\gamma'),
    ],
  })

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = JSON.parse(route.request().postData() ?? '{}')
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

  return {
    readState: () => state,
  }
}

const readColumnTitles = (page: Page) =>
  page.locator('.workspace-column .column-title-btn').allTextContents()

for (const theme of ['light', 'dark'] as const) {
  test(`a docked column lives in the topbar and clicking it restores the column in place (${theme})`, async ({
    page,
  }) => {
    const mock = await mockAppApis(page, theme)
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto('http://localhost:5173')

    const chip = page.locator('.app-topbar-docked-column')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveText('beta')
    await expect(chip).toHaveAttribute('title', 'd:\\Git\\beta')
    await expect(page.locator('.workspace-column')).toHaveCount(2)
    expect(await readColumnTitles(page)).toEqual(['alpha', 'gamma'])

    // No drop zone while nothing is being dragged (idle chrome must recede).
    await expect(page.locator('.app-topbar-dock-zone')).toHaveCount(0)

    // The chip must be legible in this theme: it renders real text color and a visible border.
    const chipStyle = await chip.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.color, borderStyle: style.borderTopStyle, borderWidth: style.borderTopWidth }
    })
    expect(chipStyle.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(chipStyle.borderStyle).toBe('solid')
    expect(chipStyle.borderWidth).not.toBe('0px')

    await chip.click()

    await expect(chip).toHaveCount(0)
    await expect(page.locator('.workspace-column')).toHaveCount(3)
    expect(await readColumnTitles(page)).toEqual(['alpha', 'beta', 'gamma'])

    await expect.poll(() => mock.readState().columns[1]?.docked).toBeUndefined()
    await expect.poll(() => mock.readState().columns.map((column) => column.id)).toEqual([
      'col-1',
      'col-2',
      'col-3',
    ])
  })
}

test('dragging a column headline onto the topbar dock zone tucks the column away', async ({ page }) => {
  const mock = await mockAppApis(page, 'dark')
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('http://localhost:5173')

  const sourceHeadline = page.locator('.workspace-column').first().locator('.column-headline')
  await expect(sourceHeadline).toBeVisible()

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const headlineBox = await sourceHeadline.boundingBox()
  if (!headlineBox) {
    throw new Error('Expected the column headline to be visible')
  }

  await sourceHeadline.dispatchEvent('dragstart', {
    dataTransfer,
    clientX: headlineBox.x + 10,
    clientY: headlineBox.y + 10,
    bubbles: true,
    cancelable: true,
  })

  const dockZone = page.locator('.app-topbar-dock-zone')
  await expect(dockZone).toBeVisible()

  const zoneBox = await dockZone.boundingBox()
  if (!zoneBox) {
    throw new Error('Expected the dock zone to be visible')
  }

  const pointer = {
    dataTransfer,
    clientX: zoneBox.x + zoneBox.width / 2,
    clientY: zoneBox.y + zoneBox.height / 2,
    bubbles: true,
    cancelable: true,
  }

  await dockZone.dispatchEvent('dragenter', pointer)
  await dockZone.dispatchEvent('dragover', pointer)
  await expect(dockZone).toHaveClass(/is-over/)

  await dockZone.dispatchEvent('drop', pointer)

  await expect(dockZone).toHaveCount(0)
  await expect(page.locator('.workspace-column')).toHaveCount(1)
  expect(await readColumnTitles(page)).toEqual(['gamma'])

  const chips = page.locator('.app-topbar-docked-column')
  await expect(chips).toHaveCount(2)
  await expect(chips).toHaveText(['alpha', 'beta'])

  await expect.poll(() => mock.readState().columns[0]?.docked).toBe(true)
  await expect.poll(() => mock.readState().columns.map((column) => column.id)).toEqual([
    'col-1',
    'col-2',
    'col-3',
  ])
})

// 收起的列在顶栏上必须能报告"在跑"和"有新结果"——它已经不在看板里，
// chip 是它唯一的可见代表。见 docs/specs/workspace-column-dock。
test('a docked chip reports running and new-result state', async ({ page }) => {
  await mockAppApis(page, 'dark', [
    createColumnFixture('col-1', 'd:\\Git\\alpha', true, { status: 'streaming' }),
    createColumnFixture('col-2', 'd:\\Git\\beta', true, { status: 'idle', unread: true }),
    createColumnFixture('col-3', 'd:\\Git\\gamma', true),
  ])
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('http://localhost:5173')

  const running = page.locator('.app-topbar-docked-column', { hasText: 'alpha' })
  const finished = page.locator('.app-topbar-docked-column', { hasText: 'beta' })
  const quiet = page.locator('.app-topbar-docked-column', { hasText: 'gamma' })

  // 在跑：橙色呼吸边框，没有蓝点。
  await expect(running).toHaveClass(/is-running/)
  await expect(running.locator('.app-topbar-docked-column-dot')).toHaveCount(0)
  await expect(running).toHaveAttribute('title', /Running/)

  // 跑完没看：蓝点在，不呼吸。
  await expect(finished).not.toHaveClass(/is-running/)
  await expect(finished.locator('.app-topbar-docked-column-dot')).toHaveCount(1)
  await expect(finished).toHaveAttribute('title', /New result/)

  // 静默列：两样都没有，闲置时不加任何 chrome。
  await expect(quiet).not.toHaveClass(/is-running/)
  await expect(quiet.locator('.app-topbar-docked-column-dot')).toHaveCount(0)

  // 呼吸动画必须真的挂上（而不是只加了个 class）。
  const animation = await running.evaluate((element) => getComputedStyle(element).animationName)
  expect(animation).toBe('docked-column-running-breathe')
})
