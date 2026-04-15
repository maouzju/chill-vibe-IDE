import { expect, test, type Page } from '@playwright/test'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const createBoardColumnFixture = (index: number, width?: number) => {
  const provider = index % 2 === 0 ? ('codex' as const) : ('claude' as const)
  const model = provider === 'codex' ? 'gpt-5.4' : 'claude-opus-4-6'

  return {
    id: `col-${index + 1}`,
    title: `Workspace ${index + 1}`,
    provider,
    workspacePath: 'd:\\Git\\chill-vibe',
    model,
    width,
    cards: [
      {
        id: `card-${index + 1}`,
        title: provider === 'codex' ? 'Feature Chat' : 'Plan Chat',
        status: 'idle' as const,
        size: 560,
        provider,
        model,
        reasoningEffort: 'medium',
        draft: '',
        messages: [],
      },
    ],
  }
}

const mockAppApis = async (
  page: Page,
  columnCount = 2,
  options?: { widths?: number[] },
) => {
  await installMockElectronBridge(page)

  const now = new Date().toISOString()

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
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
    updatedAt: now,
    columns: Array.from(
      { length: columnCount },
      (_, index) => createBoardColumnFixture(index, options?.widths?.[index]),
    ),
  })

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: createPlaywrightState(state) })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
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

  await page.route('**/api/state/snapshot', async (route) => {
    state = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({ json: { ok: true } })
  })

  return {
    getState: () => state,
  }
}

test('board seams stay aligned and quiet across themes in a narrow viewport', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 462, height: 1178 })
  await page.goto('http://localhost:5173')
  await page.locator('.workspace-column').nth(1).waitFor()
  await page.locator('.board').evaluate((node) => {
    node.scrollLeft = 210
  })

  const readLayout = async (theme: 'dark' | 'light') => {
    await page.evaluate((nextTheme) => {
      document.documentElement.setAttribute('data-theme', nextTheme)
    }, theme)

    return page.evaluate(() => {
      const columns = Array.from(document.querySelectorAll('.workspace-column'))
      const left = columns[0]
      const right = columns[1]
      const rightTitle = right?.querySelector('.column-title-btn, .workspace-path-stack')
      const rightCard = right?.querySelector('.card-shell, .empty-card')
      const handle = left?.querySelector('.column-resize-handle')

      if (!left || !right || !rightTitle || !rightCard || !handle) {
        throw new Error('Expected board layout fixtures to exist')
      }

      const leftRect = left.getBoundingClientRect()
      const rightRect = right.getBoundingClientRect()
      const titleRect = rightTitle.getBoundingClientRect()
      const cardRect = rightCard.getBoundingClientRect()
      const handlePseudo = getComputedStyle(handle, '::after')

      return {
        seamGap: rightRect.left - leftRect.right,
        headerInset: titleRect.left - rightRect.left,
        bodyInset: cardRect.left - rightRect.left,
        titleCardDelta: titleRect.left - cardRect.left,
        idleHandleOpacity: Number(handlePseudo.opacity),
      }
    })
  }

  for (const theme of ['dark', 'light'] as const) {
    const layout = await readLayout(theme)

    expect(layout.seamGap).toBeCloseTo(6, 1)
    expect(layout.headerInset).toBeCloseTo(0, 1)
    expect(layout.bodyInset).toBeCloseTo(0, 1)
    expect(layout.titleCardDelta).toBeCloseTo(0, 1)
    expect(layout.idleHandleOpacity).toBe(0)
  }
})

test('dragging the column divider left shrinks the left column before persisting the new width', async ({ page }) => {
  const api = await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('http://localhost:5173')
  await page.locator('.workspace-column').nth(1).waitFor()

  const leftColumn = page.locator('.workspace-column').first()
  const rightColumn = page.locator('.workspace-column').nth(1)
  const resizeHandle = leftColumn.locator('.column-resize-handle')

  const beforeLeft = (await leftColumn.boundingBox())?.width ?? 0
  const beforeRight = (await rightColumn.boundingBox())?.width ?? 0
  const handleBox = await resizeHandle.boundingBox()

  expect(handleBox).not.toBeNull()

  const startX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2
  const startY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX - 150, startY, { steps: 12 })
  await page.mouse.up()

  const afterLeft = (await leftColumn.boundingBox())?.width ?? 0
  const afterRight = (await rightColumn.boundingBox())?.width ?? 0

  expect(afterLeft).toBeLessThan(beforeLeft)
  expect(afterRight).toBeGreaterThan(beforeRight)
  await expect.poll(() => api.getState().columns[0]?.width).toBeGreaterThan(0)
})

test('dragging a middle divider resizes the columns on both sides of the seam together', async ({ page }) => {
  const api = await mockAppApis(page, 4)
  await page.setViewportSize({ width: 1680, height: 960 })
  await page.goto('http://localhost:5173')
  await page.locator('.workspace-column').nth(3).waitFor()

  const columns = page.locator('.workspace-column')
  const middleHandle = columns.nth(1).locator('.column-resize-handle')
  const beforeWidths = await Promise.all(
    Array.from({ length: 4 }, (_, index) => columns.nth(index).boundingBox().then((box) => box?.width ?? 0)),
  )
  const handleBox = await middleHandle.boundingBox()

  expect(handleBox).not.toBeNull()

  const startX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2
  const startY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 100, startY, { steps: 12 })
  await page.mouse.up()

  const afterWidths = await Promise.all(
    Array.from({ length: 4 }, (_, index) => columns.nth(index).boundingBox().then((box) => box?.width ?? 0)),
  )

  expect(afterWidths[0]).toBeGreaterThan(beforeWidths[0] ?? 0)
  expect(afterWidths[1]).toBeGreaterThan(beforeWidths[1] ?? 0)
  expect(afterWidths[2]).toBeLessThan(beforeWidths[2] ?? 0)
  expect(afterWidths[3]).toBeLessThan(beforeWidths[3] ?? 0)
  await expect
    .poll(() => api.getState().columns.map((column) => column.width ?? 0).every((width) => width > 0))
    .toBe(true)
})

test('saved explicit column widths still stretch to fill a fullscreen-wide board', async ({ page }) => {
  await mockAppApis(page, 4, {
    widths: [406, 616, 306, 281],
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('http://localhost:5173')
  await page.locator('.workspace-column').nth(3).waitFor()

  const readLayout = async (theme: 'dark' | 'light') => {
    await page.evaluate((nextTheme) => {
      document.documentElement.setAttribute('data-theme', nextTheme)
    }, theme)

    return page.evaluate(() => {
      const board = document.querySelector('.board')
      const columns = Array.from(document.querySelectorAll('.workspace-column'))
      const lastColumn = columns.at(-1)

      if (!board || !lastColumn) {
        throw new Error('Expected board and columns to exist')
      }

      const boardRect = board.getBoundingClientRect()
      const lastRect = lastColumn.getBoundingClientRect()

      return {
        trailingGap: Math.round(boardRect.right - lastRect.right),
        columnWidths: columns.map((column) => Math.round(column.getBoundingClientRect().width)),
      }
    })
  }

  for (const theme of ['dark', 'light'] as const) {
    const layout = await readLayout(theme)
    expect(layout.trailingGap).toBeLessThanOrEqual(12)
    expect(layout.columnWidths[0]).toBeGreaterThan(406)
    expect(layout.columnWidths[1]).toBeGreaterThan(616)
  }
})
