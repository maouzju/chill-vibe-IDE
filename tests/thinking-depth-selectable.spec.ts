import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

/**
 * 症状：2026-08-16 用户截图报「这什么垃圾UI啊，怎么还没法设置」—— 模板面板里
 *   「思考深度」是一个灰掉的「超高」，点不动也没写为什么。
 * 根因：深度下拉被「思考」复选框 disable，而这两行在视觉上没有任何从属关系，
 *   用户无从得知要先去勾上面那个框。
 * 这条 spec 钉的是修复后的完整回路：深度可点 → 点了之后思考自动开 → 两个控件
 *   的状态一致。只断言「不是 disabled」挡不住有人把自动开思考那半边删掉。
 */

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'
const boardCardId = 'board-1'
const workspacePath = 'd:\\Git\\chill-vibe'

const createState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      automationBoardCardEnabled: true,
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: '2026-08-16T00:00:00.000Z',
    automationBoards: {
      [workspacePath]: {
        templates: [
          {
            id: 'tpl-monitor',
            name: '看板监工',
            requirement: '检查当前看板每个原始需求的交付情况。',
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
            // 复现用户那张截图的状态：思考关着。
            thinkingEnabled: false,
            planMode: false,
            adminAccess: true,
            builtIn: false,
            trigger: {
              enabled: false,
              kind: 'last-item-settled' as const,
              lane: 'running' as const,
              minIntervalMinutes: 5,
            },
            instanceCardId: '',
            wakeTimerActive: false,
            repeatLoopActive: false,
          },
        ],
      },
    },
    columns: [
      {
        id: 'col-board',
        title: 'Automation Workspace',
        provider: 'codex' as const,
        workspacePath,
        model: 'gpt-5.5',
        layout: createPane([boardCardId], boardCardId, 'pane-board'),
        cards: [
          {
            id: boardCardId,
            title: 'Automation',
            status: 'idle' as const,
            size: 720,
            provider: 'codex' as const,
            model: AUTOMATIONBOARD_TOOL_MODEL,
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
            automationBoard: { items: [] },
          },
        ],
      },
    ],
  })

/**
 * 同一条语义的第二个渲染点：聊天 composer 的设置菜单。两处共用
 * `shouldEnableThinkingForDepthChange`，但调用形态不同（这边是 toggle 回调），
 * 所以两边都得有端到端覆盖 —— 只测看板挡不住有人把 ChatCard 那半边改回去。
 */
const createChatState = () =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: '2026-08-16T00:00:00.000Z',
    columns: [
      {
        id: 'col-chat',
        title: 'Chat Workspace',
        provider: 'codex' as const,
        workspacePath,
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-1',
            title: '普通会话',
            status: 'idle' as const,
            size: 520,
            provider: 'codex' as const,
            model: 'gpt-5.5',
            reasoningEffort: 'xhigh',
            thinkingEnabled: false,
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, factory: () => ReturnType<typeof createState> = createState) => {
  await installMockElectronBridge(page)
  let state = factory()

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
    await route.fulfill({ json: [] })
  })
}

test('picking a thinking depth turns thinking back on instead of staying locked', async ({
  page,
}) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  await expect(page.locator('.automation-board-templates')).toBeVisible()
  await page.locator('.automation-board-template-configure').first().click()

  const panel = page.locator('.automation-board-template-config')
  await expect(panel).toBeVisible()

  // 触发器那块的「放进哪条道」也是 .reasoning-select，所以必须按标签切行定位，
  // 否则 strict mode 会撞上两个 select。
  const depth = panel
    .locator('label.automation-board-template-field')
    .filter({ has: page.locator('span', { hasText: /^思考深度$/ }) })
    .locator('select')
  const thinking = panel
    .locator('label.automation-board-template-field')
    .filter({ has: page.locator('span', { hasText: /^思考$/ }) })
    .locator('input[type="checkbox"]')

  // 起点就是用户截图里的样子：思考关着，深度显示着一个当前并不生效的档位。
  await expect(thinking).not.toBeChecked()
  await expect(depth).toBeEnabled()
  await expect(depth).toHaveClass(/is-thinking-off/)
  // chevron 是"这是个下拉"的唯一视觉线索，而它曾被面板的 background 简写整个擦掉
  // （见 index.css 里 .automation-board-template-field 上方那段）。没有它，即使控件
  // 可点，用户看到的仍是一块静态文字 —— 那正是这次报障的观感来源。
  await expect(depth).toHaveCSS('background-image', /url\(/)

  await depth.selectOption('high')

  // 选了深度 = 表达了"我要思考"，两个控件必须一起到位，否则用户改了个寂寞。
  await expect(depth).toHaveValue('high')
  await expect(thinking).toBeChecked()
  await expect(depth).not.toHaveClass(/is-thinking-off/)
})

/**
 * 2026-08-16 发布前审计补的洞：`onChange` 只在**值真的变了**时才发。而用户报障
 * 那张截图里，卡上存的就是「超高」—— 他想要的恰恰是屏幕上灰着的那一档。点开下拉、
 * 再点一次「超高」，浏览器一个事件都不发，思考仍然是关的，观感与修复前一模一样。
 * 所以判据必须是「碰了这个控件」而不是「换了一个值」。
 */
test('re-picking the tier already on screen still turns thinking on', async ({ page }) => {
  await installMockApis(page, createChatState)
  await page.goto(appUrl)

  const panel = page.locator('.pane-tab-panel.is-active')
  await panel.locator('.composer-settings-trigger').first().click()

  const menu = page.locator('.composer-settings-menu').first()
  const row = (label: string) =>
    menu
      .locator('.composer-settings-row')
      .filter({ has: page.locator('.composer-settings-label', { hasText: new RegExp(`^${label}$`) }) })
  const depth = row('思考深度').locator('select')
  const thinking = row('思考').locator('input[type="checkbox"]')

  // 卡上存的就是 xhigh，也就是下拉里当前选中的那一项。
  await expect(depth).toHaveValue('xhigh')
  await expect(thinking).not.toBeChecked()

  // 不改值，只是去碰这个控件 —— 这已经表达了"我要调思考"。
  await depth.click()

  await expect(thinking).toBeChecked()
  await expect(depth).toHaveValue('xhigh')
  await expect(depth).not.toHaveClass(/is-thinking-off/)

  // 开思考的回调是 toggle 不是 patch，而 pointerdown 与 change 各挂了一份。
  // 真实鼠标两条都会走，第二条必须被 `shouldEnableThinkingForDepthChange` 判掉，
  // 否则用户点开下拉、再选一档，思考会被第二次调用关回去。
  await depth.selectOption('high')
  await expect(depth).toHaveValue('high')
  await expect(thinking).toBeChecked()
})

test('the chat composer depth select behaves the same way', async ({ page }) => {
  await installMockApis(page, createChatState)
  await page.goto(appUrl)

  const panel = page.locator('.pane-tab-panel.is-active')
  await panel.locator('.composer-settings-trigger').first().click()

  // 菜单里有一排开关（唤醒定时器 / 重复循环 / 思考 / 计划模式…），必须按标签切行，
  // first() 会抓到最上面那个无关的复选框。
  const menu = page.locator('.composer-settings-menu').first()
  const row = (label: string) =>
    menu
      .locator('.composer-settings-row')
      .filter({ has: page.locator('.composer-settings-label', { hasText: new RegExp(`^${label}$`) }) })
  const depth = row('思考深度').locator('select')
  const thinking = row('思考').locator('input[type="checkbox"]')

  await expect(thinking).not.toBeChecked()
  await expect(depth).toBeEnabled()
  await expect(depth).toHaveClass(/is-thinking-off/)

  await depth.selectOption('high')

  await expect(depth).toHaveValue('high')
  await expect(thinking).toBeChecked()
  await expect(depth).not.toHaveClass(/is-thinking-off/)
})
