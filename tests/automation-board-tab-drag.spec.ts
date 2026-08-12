import { expect, test, type Page } from '@playwright/test'

import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const mockAppApis = async (page: Page) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'board-1',
            title: 'Automation Board',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: AUTOMATIONBOARD_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            // 只给 items：看板的其余字段有 schema 默认值，写死它们会让这个
            // fixture 跟着看板 schema 的每次演进一起腐烂。
            automationBoard: { items: [] },
          },
          {
            id: 'chat-1',
            title: 'Ship the login page',
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

  return { readState: () => state }
}

test('dragging a chat tab keeps the automation board on screen so it can be the drop target', async ({
  page,
}) => {
  const mock = await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  // 127.0.0.1 而不是 localhost：Windows 上 localhost 先解析到 ::1，另一个
  // checkout 的 Vite 常年占着 [::1]:5173，那样这个 spec 会静悄悄地验证别人的代码。
  await page.goto('http://127.0.0.1:5173')

  const board = page.locator('.automation-board')
  const boardTab = page.locator('.pane-tab[data-pane-tab-id="board-1"]')
  const chatTab = page.locator('.pane-tab[data-pane-tab-id="chat-1"]')
  const standbyLane = page.locator('.automation-board-lane[data-lane="standby"] .automation-board-lane-body')

  await expect(board).toBeVisible()
  await expect(boardTab).toHaveClass(/is-active/)
  await expect(chatTab).toBeVisible()

  // Real pointerdown on the chat tab: this is what arms PaneView's 80ms
  // activation fallback, the thing that used to hide the board mid-gesture.
  const tabBox = await chatTab.boundingBox()
  if (!tabBox) {
    throw new Error('Expected the chat tab to be visible')
  }
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(250)

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    const payload = JSON.stringify({
      type: 'tab',
      columnId: 'col-1',
      paneId: 'col-1-pane',
      tabId: 'chat-1',
    })
    dt.setData('application/x-chill-vibe', payload)
    dt.setData('text/plain', payload)
    return dt
  })

  await chatTab.dispatchEvent('dragstart', {
    dataTransfer,
    clientX: tabBox.x + tabBox.width / 2,
    clientY: tabBox.y + tabBox.height / 2,
    bubbles: true,
    cancelable: true,
  })

  // The whole point: the board must still be the visible panel, otherwise the
  // user has nothing to drop onto.
  await expect(boardTab).toHaveClass(/is-active/)
  await expect(board).toBeVisible()
  await expect(standbyLane).toBeVisible()

  const laneBox = await standbyLane.boundingBox()
  if (!laneBox) {
    throw new Error('Expected the standby lane to be visible during the drag')
  }
  const lanePointer = {
    dataTransfer,
    clientX: laneBox.x + laneBox.width / 2,
    clientY: laneBox.y + laneBox.height / 2,
    bubbles: true,
    cancelable: true,
  }

  await standbyLane.dispatchEvent('dragenter', lanePointer)
  await standbyLane.dispatchEvent('dragover', lanePointer)
  await standbyLane.dispatchEvent('drop', lanePointer)
  await page.mouse.up()

  await expect(page.locator('.automation-board-item')).toHaveCount(1)
  await expect(chatTab).toHaveCount(0)
  await expect
    .poll(() => mock.readState().columns[0]?.cards?.['board-1']?.automationBoard?.items?.length ?? 0)
    .toBe(1)
})
