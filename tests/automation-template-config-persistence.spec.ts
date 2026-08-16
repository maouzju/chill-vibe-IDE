import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

/**
 * 症状：2026-08-16 用户报「模板的模型选择等配置需要持久保存」—— 在模板配置面板
 *   里改完模型 / 思考深度 / 超管，重开就回到旧值。
 * 这条 spec 走的是完整回路：改 → 落进出站的 state → 重新加载 → 面板读回来。
 *   只断言 reducer 或只断言磁盘 round-trip 都盖不住中间那段（渲染层读的是
 *   `state.automationBoards[workspacePath]`，任何一层把它丢了都在这里现形）。
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
            reasoningEffort: 'medium',
            thinkingEnabled: true,
            planMode: false,
            adminAccess: false,
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
 * 触发器**复用**上一轮实例卡的场景：模板已经生出过一张卡（instanceCardId 指着
 * 它），而这张卡还停在 done 道上、用的是模板改动前的模型。
 * 触发落点刻意设成 standby —— running 会真的投递一轮需求，这条 spec 要验的是
 * 执行参数追平，不是发送。
 */
const createReuseState = () => {
  const state = createState()
  const workspace = state.automationBoards[workspacePath]!
  workspace.templates[0]!.instanceCardId = 'instance-1'
  workspace.templates[0]!.trigger.lane = 'standby'

  const column = state.columns[0]!
  column.cards['instance-1'] = {
    id: 'instance-1',
    title: '上一轮的监工',
    status: 'idle',
    size: 560,
    provider: 'codex',
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    draft: '',
    messages: [],
    automationBoardTemplateId: 'tpl-monitor',
  }
  column.cards[boardCardId]!.automationBoard = {
    items: [
      {
        cardId: 'instance-1',
        lane: 'done',
        requirement: '检查当前看板每个原始需求的交付情况。',
        templateId: 'tpl-monitor',
      },
    ],
  }

  return state
}

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

const openTemplateConfig = async (page: Page) => {
  await expect(page.locator('.automation-board-templates')).toBeVisible()
  await page.locator('.automation-board-template-configure').first().click()

  const panel = page.locator('.automation-board-template-config')
  await expect(panel).toBeVisible()
  return panel
}

const fieldByLabel = (page: Page, panel: ReturnType<Page['locator']>, label: string) =>
  panel
    .locator('label.automation-board-template-field')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) })

test('template execution settings survive a reload', async ({ page }) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  const panel = await openTemplateConfig(page)

  const model = fieldByLabel(page, panel, '模型').locator('select')
  const depth = fieldByLabel(page, panel, '思考深度').locator('select')
  const admin = fieldByLabel(page, panel, '超管权限').locator('input[type="checkbox"]')

  await expect(model).toHaveValue('codex::gpt-5.5')

  await model.selectOption('claude::claude-opus-5')
  await expect(model).toHaveValue('claude::claude-opus-5')
  await depth.selectOption('high')
  await expect(depth).toHaveValue('high')
  await admin.check()
  await expect(admin).toBeChecked()

  // 重新加载 = 用户下次打开应用。mock 的写入路径已经把出站 state 存了下来，
  // 所以这次 GET 拿到的就是"持久化之后"的样子。
  await page.reload()

  const reopened = await openTemplateConfig(page)
  await expect(fieldByLabel(page, reopened, '模型').locator('select')).toHaveValue(
    'claude::claude-opus-5',
  )
  await expect(fieldByLabel(page, reopened, '思考深度').locator('select')).toHaveValue('high')
  await expect(fieldByLabel(page, reopened, '超管权限').locator('input[type="checkbox"]')).toBeChecked()
})

/**
 * 待命输入区那一排是另一条独立的存储路径（`board.composeDefaults`，挂在看板卡
 * 上而不是工作区模板上）。2026-08-16 用户机器的真实存档里这个字段**根本不存在**，
 * 而同一个 blob 里的 laneWidths 在 —— 所以它不是"没人用过"，是写不进去。
 */
test('the standby composer remembers the model and depth it was set to', async ({ page }) => {
  await installMockApis(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  const composeModel = page.locator('.automation-board-compose-model')
  await expect(composeModel).toBeVisible()
  await expect(composeModel).toHaveValue('codex::gpt-5.5')

  await composeModel.selectOption('claude::claude-opus-5')
  await expect(composeModel).toHaveValue('claude::claude-opus-5')

  await page.locator('.automation-board-compose-settings-toggle').click()
  const settings = page.locator('.automation-board-compose-settings')
  const depth = settings
    .locator('label.automation-board-template-field')
    .filter({ has: page.locator('span', { hasText: /^思考深度$/ }) })
    .locator('select')
  await depth.selectOption('high')
  await expect(depth).toHaveValue('high')

  await page.reload()

  await expect(page.locator('.automation-board-compose-model')).toHaveValue('claude::claude-opus-5')
  await page.locator('.automation-board-compose-settings-toggle').click()
  await expect(
    page
      .locator('.automation-board-compose-settings')
      .locator('label.automation-board-template-field')
      .filter({ has: page.locator('span', { hasText: /^思考深度$/ }) })
      .locator('select'),
  ).toHaveValue('high')
})

/**
 * 存下来还不够 —— 配置得真的作用到跑起来的那张卡上。
 * 2026-08-16 用户存档：模板 provider=claude，它复用的监工实例卡却仍是
 * codex/gpt-5.6-sol。改模板等于白改，用户读作"配置没保存"。
 */
test('a reused template instance picks up the model the template was changed to', async ({
  page,
}) => {
  await installMockApis(page, createReuseState)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  const instance = page.locator('[data-automation-board-item-id="instance-1"]')
  await expect(instance.locator('.automation-board-item-model')).toHaveText('gpt-5.5')

  const panel = await openTemplateConfig(page)
  await fieldByLabel(page, panel, '模型').locator('select').selectOption('claude::claude-opus-5')

  await panel.getByRole('button', { name: '立即执行一次' }).click()

  await expect(instance.locator('.automation-board-item-model')).toHaveText('claude-opus-5')
})
