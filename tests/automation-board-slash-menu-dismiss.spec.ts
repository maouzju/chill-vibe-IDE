import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const boardCardId = 'board-1'
const workspacePath = 'd:\\Git\\chill-vibe'

const createState = (boardDraft: string) =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      automationBoardCardEnabled: true,
      wakeTimerEnabled: true,
      repeatLoopEnabled: true,
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    automationBoards: { [workspacePath]: { templates: [] } },
    columns: [
      {
        id: 'col-board',
        title: '自动化工作区',
        provider: 'codex' as const,
        workspacePath,
        model: 'gpt-5.5',
        layout: createPane([boardCardId], boardCardId, 'pane-board'),
        cards: [
          {
            id: boardCardId,
            title: '看板',
            status: 'idle' as const,
            size: 720,
            provider: 'codex' as const,
            model: AUTOMATIONBOARD_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            automationBoard: { items: [], draft: boardDraft },
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, boardDraft: string) => {
  await installMockElectronBridge(page)

  let state = createState(boardDraft)

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
    await route.fulfill({ json: { state: 'idle', logs: [] } })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({
      json: [
        { name: 'review', description: '审查改动', source: 'app' },
        { name: 'release', description: '发布检查', source: 'native' },
      ],
    })
  })
}

const slashMenu = (page: Page) => page.locator('.automation-board-slash-command-menu')

// 症状：待命输入框打出 `/re` 弹出补全菜单后，鼠标点到旁边任意一处，菜单不关，
//   继续以 position:fixed 浮在窗口上挡住内容，还自己吃掉 onMouseDown。
// 根因：唯一能置 slashMenuDismissed 的入口是 textarea 自己 keydown 里的 Escape；
//   菜单 createPortal 到 document.body，焦点一旦离开 textarea 就再也按不到那个
//   Escape（ChatCard 3989-4012 有的那段全局 mousedown/Escape 抄漏了）。
// 为什么不能用 textarea 的 onBlur 关：菜单项自己就是按钮，点它必然先 blur，
//   blur 关菜单等于点不中任何一条补全。
test('clicking outside the standby composer closes the slash completion menu', async ({ page }) => {
  await installMockApis(page, '')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const composer = page.locator('.automation-board-lane-compose textarea')
  await expect(composer).toBeVisible()
  await composer.fill('/re')
  await expect(slashMenu(page)).toBeVisible()

  // 「点旁边任意一张卡/一块空白」：已完成道在横向上完全避开了菜单（菜单宽度=
  // textarea 宽度、左对齐在待命道上），所以这一下必然落在菜单外面。
  await page.locator('[data-lane="done"]').click({ position: { x: 12, y: 12 } })

  await expect(slashMenu(page)).toHaveCount(0)
  // 草稿本身不能被顺手清掉：关的是菜单，不是用户打了一半的需求。
  await expect(composer).toHaveValue('/re')
})

// 症状（更糟，重启后仍在）：上一次打的 `/re` 随 board.draft 落了盘，重启应用或
//   切走再切回这张看板卡，用户什么都没做，一个补全面板就凭空浮在界面上。
// 根因：slashMenuOpen 只看 draft 的文本形状，而 draft 初值来自持久化的
//   board.draft —— 组件一挂载 slashQuery 就非 null，slashMenuDismissed 还是 false。
// 为什么不能改成「挂载后清掉 draft」：草稿持久化本身是刻意设计（见 965 行注释），
//   要压的是"自动弹菜单"，不是那段没写完的需求。
test('a persisted slash-shaped draft does not pop the menu open on mount', async ({ page }) => {
  await installMockApis(page, '/re')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const composer = page.locator('.automation-board-lane-compose textarea')
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue('/re')

  // 菜单必须是"用户这次输入"触发的，恢复草稿不算输入。
  await expect(slashMenu(page)).toHaveCount(0)

  // 但补全本身不能因此废掉：在恢复的草稿上继续打字，菜单照常出来。
  await composer.click()
  await composer.pressSequentially('l')
  await expect(slashMenu(page)).toBeVisible()
})
