import { expect, test, type Page } from '@playwright/test'

import { createPane, createSplit } from '../shared/default-state.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const mockAppApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
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
        title: 'Source',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-source',
            title: 'Source Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
      {
        id: 'col-2',
        title: 'Target',
        provider: 'claude' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'claude-opus-4-7',
        cards: [
          {
            id: 'card-target',
            title: 'Target Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'claude' as const,
            model: 'claude-opus-4-7',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
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

test('dragging a tab onto the lower half of another pane splits it downward', async ({ page }) => {
  const mock = await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('http://localhost:5173')

  const sourceTab = page.locator('.workspace-column').first().locator('.pane-tab', { hasText: 'Source Chat' })
  const targetColumn = page.locator('.workspace-column').nth(1)
  const targetPaneContent = targetColumn.locator('.pane-content').first()

  await expect(sourceTab).toBeVisible()
  await expect(targetPaneContent).toBeVisible()

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    const payload = JSON.stringify({
      type: 'tab',
      columnId: 'col-1',
      paneId: 'col-1-pane',
      tabId: 'card-source',
    })
    dt.setData('application/x-chill-vibe', payload)
    dt.setData('text/plain', payload)
    return dt
  })

  const paneBox = await targetPaneContent.boundingBox()
  if (!paneBox) {
    throw new Error('Expected the target pane content to be visible')
  }

  const pointer = {
    clientX: paneBox.x + paneBox.width / 2,
    clientY: paneBox.y + paneBox.height * 0.72,
    bubbles: true,
    cancelable: true,
  }

  await sourceTab.dispatchEvent('dragstart', { dataTransfer, ...pointer })
  await targetPaneContent.dispatchEvent('dragenter', { dataTransfer, ...pointer })
  await targetPaneContent.dispatchEvent('dragover', { dataTransfer, ...pointer })

  await expect(targetPaneContent).toHaveClass(/is-drop-bottom/)

  await targetPaneContent.dispatchEvent('drop', { dataTransfer, ...pointer })

  await expect(targetColumn.locator('.split-container[data-direction="vertical"]')).toHaveCount(1)
  await expect(targetColumn.locator('.pane-view')).toHaveCount(2)

  await expect
    .poll(() => mock.readState().columns[1]?.layout?.type)
    .toBe('split')
  await expect
    .poll(() => mock.readState().columns[1]?.layout?.type === 'split' ? mock.readState().columns[1]?.layout.direction : null)
    .toBe('vertical')
})

test('dragging a tab onto the lower half of another pane in the same column keeps the tab visible', async ({ page }) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
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
        title: 'Board',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        layout: createSplit(
          'horizontal',
          [
            createPane(['card-left'], 'card-left', 'pane-left'),
            createPane(['card-right'], 'card-right', 'pane-right'),
          ],
          [0.5, 0.5],
          'split-root',
        ),
        cards: [
          {
            id: 'card-left',
            title: 'Left Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
          {
            id: 'card-right',
            title: 'Right Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
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

  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('http://localhost:5173')

  const sourceTab = page.locator('.pane-view').first().locator('.pane-tab', { hasText: 'Left Chat' })
  const targetPane = page.locator('.pane-view').nth(1)
  const targetPaneContent = targetPane.locator('.pane-content')

  await expect(sourceTab).toBeVisible()
  await expect(targetPaneContent).toBeVisible()

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    const payload = JSON.stringify({
      type: 'tab',
      columnId: 'col-1',
      paneId: 'pane-left',
      tabId: 'card-left',
    })
    dt.setData('application/x-chill-vibe', payload)
    dt.setData('text/plain', payload)
    return dt
  })

  const paneBox = await targetPaneContent.boundingBox()
  if (!paneBox) {
    throw new Error('Expected the target pane content to be visible')
  }

  const pointer = {
    clientX: paneBox.x + paneBox.width / 2,
    clientY: paneBox.y + paneBox.height * 0.72,
    bubbles: true,
    cancelable: true,
  }

  await sourceTab.dispatchEvent('dragstart', { dataTransfer, ...pointer })
  await targetPaneContent.dispatchEvent('dragenter', { dataTransfer, ...pointer })
  await targetPaneContent.dispatchEvent('dragover', { dataTransfer, ...pointer })

  await expect(targetPaneContent).toHaveClass(/is-drop-bottom/)

  await targetPaneContent.dispatchEvent('drop', { dataTransfer, ...pointer })
  await expect(page.locator('.split-container[data-direction="vertical"]')).toHaveCount(1)
  await expect(page.locator('.pane-view')).toHaveCount(2)
  await expect(page.locator('.pane-tab', { hasText: 'Left Chat' })).toHaveCount(1)
  await expect(page.locator('.pane-view').nth(1).locator('.pane-tab.is-active', { hasText: 'Left Chat' })).toBeVisible()
})
