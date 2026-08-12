import { expect, test, type Page } from '@playwright/test'

import { automationBoardSupervisorTemplateId } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

/**
 * 用户报的场景：看板监工「拖出为独立 tab」之后没法拖回去。
 *
 * fixture 直接构造拖出**之后**的状态（项已从 board.items 摘掉、弹出的卡是这个
 * pane 的活动 tab、看板因此成了非活动面板），因为 bug 的前提正是这个状态 ——
 * 不经过抽屉里的那颗按钮，是为了不让这条断言依赖 item 卡的 UI 结构。
 */
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
            automationBoard: { items: [] },
          },
          {
            id: 'sup-1',
            title: 'Board supervisor',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            adminAccess: true,
            // 拖出那一刻落在卡上的模板血缘 —— 拖回来必须认回它，否则防自触发失效。
            automationBoardTemplateId: automationBoardSupervisorTemplateId,
          },
        ],
        layout: {
          type: 'pane' as const,
          id: 'col-1-pane',
          tabs: ['board-1', 'sup-1'],
          activeTabId: 'sup-1',
          tabHistory: ['board-1', 'sup-1'],
        },
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
    readItems: () => state.columns[0]?.cards?.['board-1']?.automationBoard?.items ?? [],
  }
}

// 127.0.0.1 而不是 localhost：Windows 上 localhost 先解析到 ::1，另一个 checkout
// 的 Vite 常年占着 [::1]:5173，那样这个 spec 会静悄悄地验证别人的代码。
const appUrl = 'http://127.0.0.1:5173'

test('dragging a popped-out board item brings the board back on screen as a drop target', async ({
  page,
}) => {
  const mock = await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)

  const board = page.locator('.automation-board')
  const boardTab = page.locator('.pane-tab[data-pane-tab-id="board-1"]')
  const supTab = page.locator('.pane-tab[data-pane-tab-id="sup-1"]')
  const standbyLane = page.locator(
    '.automation-board-lane[data-lane="standby"] .automation-board-lane-body',
  )

  // 出发点就是 bug 的现场：弹出的卡占着视图，看板面板压根没挂载。
  await expect(supTab).toHaveClass(/is-active/)
  await expect(board).toHaveCount(0)

  const tabBox = await supTab.boundingBox()
  if (!tabBox) {
    throw new Error('Expected the popped-out tab to be visible')
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
      tabId: 'sup-1',
    })
    dt.setData('application/x-chill-vibe', payload)
    dt.setData('text/plain', payload)
    return dt
  })

  await supTab.dispatchEvent('dragstart', {
    dataTransfer,
    clientX: tabBox.x + tabBox.width / 2,
    clientY: tabBox.y + tabBox.height / 2,
    bubbles: true,
    cancelable: true,
  })

  // 修复点：拖起来的那一刻看板必须让位显示出来，否则泳道落点不存在。
  await expect(boardTab).toHaveClass(/is-active/)
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
  // 刻意不派发 dragend：drop 成功后这个 tab 已经不在 DOM 里了，真实浏览器也只会
  // 把 dragend 送给一个已卸载的节点。视图该留在看板上，不该"还原"到一个没了的 tab。
  await page.mouse.up()

  await expect(page.locator('.automation-board-item')).toHaveCount(1)
  await expect(supTab).toHaveCount(0)
  await expect.poll(() => mock.readItems().length).toBe(1)
  // 血缘认回来了：否则监工每答完一轮都会把自己再叫起来一轮。
  await expect.poll(() => mock.readItems()[0]?.templateId ?? '').toBe(
    automationBoardSupervisorTemplateId,
  )
})

test('an aborted drag puts the view back on the tab it borrowed the screen from', async ({
  page,
}) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)

  const boardTab = page.locator('.pane-tab[data-pane-tab-id="board-1"]')
  const supTab = page.locator('.pane-tab[data-pane-tab-id="sup-1"]')
  await expect(supTab).toHaveClass(/is-active/)

  const tabBox = await supTab.boundingBox()
  if (!tabBox) {
    throw new Error('Expected the popped-out tab to be visible')
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
      tabId: 'sup-1',
    })
    dt.setData('application/x-chill-vibe', payload)
    dt.setData('text/plain', payload)
    return dt
  })

  await supTab.dispatchEvent('dragstart', {
    dataTransfer,
    clientX: tabBox.x + tabBox.width / 2,
    clientY: tabBox.y + tabBox.height / 2,
    bubbles: true,
    cancelable: true,
  })
  await expect(boardTab).toHaveClass(/is-active/)

  // 半途放手（没落到任何泳道上）：借来的屏幕必须还回去，否则每一次误拖都会把
  // 用户正在看的东西悄悄换成看板。
  await supTab.dispatchEvent('dragend', { dataTransfer, bubbles: true })
  await page.mouse.up()

  await expect(supTab).toHaveClass(/is-active/)
  await expect(page.locator('.automation-board')).toHaveCount(0)
})

test('the tab context menu can move a popped-out card back into the board without dragging', async ({
  page,
}) => {
  const mock = await mockAppApis(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)

  const supTab = page.locator('.pane-tab[data-pane-tab-id="sup-1"]')
  await expect(supTab).toHaveClass(/is-active/)

  await supTab.click({ button: 'right' })
  const absorbEntry = page
    .locator('.pane-tab-context-menu button', { hasText: 'Move into automation board' })
    .first()
  await expect(absorbEntry).toBeEnabled()
  await absorbEntry.click()

  await expect(supTab).toHaveCount(0)
  await expect(page.locator('.automation-board-item')).toHaveCount(1)
  await expect.poll(() => mock.readItems().length).toBe(1)
  // 空闲卡进待命道：transitions 表在这一格给出 interrupt:false + send:'none'，
  // 也就是"只搬家，不动会话"。
  await expect.poll(() => mock.readItems()[0]?.lane ?? '').toBe('standby')
  await expect.poll(() => mock.readItems()[0]?.templateId ?? '').toBe(
    automationBoardSupervisorTemplateId,
  )
})
