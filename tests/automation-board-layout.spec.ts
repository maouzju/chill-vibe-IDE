import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const boardCardId = 'board-1'
const workspacePath = 'd:\\Git\\chill-vibe'

/**
 * 这条 spec 的整个存在理由：看板卡活在**可调宽的列**里，列宽和视口宽没有
 * 任何关系。三列铺开的 1440 视口下，单列只有 ~450px —— 旧的
 * `@media (max-width: 900px)` 永远不触发，于是三条泳道被压到每条 130px。
 *
 * 所以这里固定视口 1440、只改**同时开几列**（用户真实的变窄方式）：媒体查询
 * 版本在三档下都返回三条轨道，容器查询版本才会跟着列宽换布局。
 * 不用 `column.width` 是因为它是**比例**（`flexGrow: width`），单列时无论填
 * 多少都会长满整行。
 */
const message = (id: string, index: number, content: string) => ({
  id,
  role: index % 3 === 0 ? ('user' as const) : ('assistant' as const),
  content,
  createdAt: new Date(Date.parse('2026-08-11T00:00:00.000Z') + index * 1_000).toISOString(),
})

const itemCard = (
  id: string,
  title: string,
  messageCount: number,
  status: 'idle' | 'streaming' = 'idle',
) => ({
  id,
  title,
  status,
  size: 560,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'medium',
  draft: '',
  messages: Array.from({ length: messageCount }, (_, index) =>
    message(`${id}-m${index}`, index, `agent line ${index} about ${title.toLowerCase()}`),
  ),
})

const template = (
  id: string,
  name: string,
  options?: { builtIn?: boolean; trigger?: boolean; adminAccess?: boolean },
) => ({
  id,
  name,
  requirement: `${name} 的需求原文，用来占位一段比胶囊更宽的文字。`,
  provider: 'codex' as const,
  model: 'gpt-5.5',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  adminAccess: options?.adminAccess ?? false,
  builtIn: options?.builtIn ?? false,
  trigger: {
    enabled: options?.trigger ?? false,
    kind: 'last-item-settled' as const,
    lane: 'running' as const,
    minIntervalMinutes: 5,
  },
  instanceCardId: '',
  wakeTimerActive: false,
  repeatLoopActive: false,
})

const fillerColumn = (index: number) => ({
  id: `col-filler-${index}`,
  title: `Workspace ${index + 2}`,
  provider: 'codex' as const,
  workspacePath: `d:\\Git\\filler-${index}`,
  model: 'gpt-5.5',
  cards: [
    {
      id: `filler-card-${index}`,
      title: 'Chat',
      status: 'idle' as const,
      size: 560,
      provider: 'codex' as const,
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      draft: '',
      messages: [],
    },
  ],
})

const createState = (
  columnCount: number,
  theme: 'dark' | 'light',
  laneWidths?: { standby: number; running: number; done: number },
) =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      automationBoardCardEnabled: true,
      wakeTimerEnabled: true,
      repeatLoopEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-5',
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
    updatedAt: '2026-08-12T00:00:00.000Z',
    automationBoards: {
      [workspacePath]: {
        templates: [
          template('tpl-supervisor', '看板监工', {
            builtIn: true,
            trigger: true,
            adminAccess: true,
          }),
          template('tpl-review', '发版前复查'),
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
            automationBoard: {
              ...(laneWidths ? { laneWidths } : {}),
              items: [
                {
                  cardId: 'item-standby-a',
                  lane: 'standby' as const,
                  requirement: '把结账流程的回归测试补齐，覆盖优惠券叠加的边界。',
                },
                {
                  cardId: 'item-standby-b',
                  lane: 'standby' as const,
                  requirement: '登录页改深色模式',
                },
                {
                  cardId: 'item-running',
                  lane: 'running' as const,
                  requirement: '重写会话历史的索引重建脚本，并补一条守卫测试。',
                },
                {
                  cardId: 'item-done',
                  lane: 'done' as const,
                  requirement: '修掉 tab 栏滚轮误路由',
                },
              ],
            },
          },
          itemCard('item-standby-a', '补齐结账回归测试', 0),
          itemCard('item-standby-b', '登录页改深色模式', 0),
          itemCard('item-running', '重建会话历史索引', 8, 'streaming'),
          itemCard('item-done', '修掉 tab 栏滚轮误路由', 4),
        ],
      },
      ...Array.from({ length: Math.max(0, columnCount - 1) }, (_, index) => fillerColumn(index)),
    ],
  })

const installMockApis = async (
  page: Page,
  columnCount: number,
  theme: 'dark' | 'light',
  laneWidths?: { standby: number; running: number; done: number },
) => {
  await installMockElectronBridge(page)

  let state = createState(columnCount, theme, laneWidths)

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

const countLaneTracks = (page: Page) =>
  page
    .locator('.automation-board-lanes')
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length)

const widths = [
  { label: 'wide', columnCount: 1, tracks: 3 },
  { label: 'medium', columnCount: 2, tracks: 2 },
  { label: 'narrow', columnCount: 3, tracks: 1 },
] as const

for (const theme of ['dark', 'light'] as const) {
  for (const width of widths) {
    test(`automation board reflows to ${width.tracks} lane column(s) at ${width.label} pane width (${theme})`, async ({
      page,
    }) => {
      await installMockApis(page, width.columnCount, theme)
      // 视口在三档里**保持不变**：换的只有同时开几列。旧的视口媒体查询在这里
      // 全档都是三轨，因此这条断言就是它的红。
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto(appUrl)

      const board = page.locator('.automation-board')
      await expect(board).toBeVisible()
      await expect(page.locator('.automation-board-item')).toHaveCount(4)

      await expect(board).toHaveScreenshot(`automation-board-${width.label}-${theme}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.004,
      })

      expect(await countLaneTracks(page)).toBe(width.tracks)
    })
  }
}

test('a squeezed board keeps every lane readable instead of shrinking three of them', async ({
  page,
}) => {
  await installMockApis(page, 3, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  await expect(page.locator('.automation-board')).toBeVisible()

  const laneWidths = await page
    .locator('.automation-board-lane')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width))

  expect(laneWidths).toHaveLength(3)
  // 一条泳道要放下「标题 + 型号标签 + 状态点」这一行才算可读。三等分一个
  // ~450px 的窄列会让每条只剩 ~140px，那是旧版真实发生的事。
  for (const laneWidth of laneWidths) {
    expect(laneWidth).toBeGreaterThan(240)
  }
})

const laneWidths = (page: Page) =>
  page
    .locator('.automation-board-lane')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width))

test('dragging a lane divider widens one lane and makes the other two give way', async ({
  page,
}) => {
  await installMockApis(page, 1, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)
  await expect(page.locator('.automation-board')).toBeVisible()

  const before = await laneWidths(page)

  const handle = page.locator('.automation-board-lane-resize-handle').first()
  const box = (await handle.boundingBox())!
  const centerY = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, centerY)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 200, centerY, { steps: 8 })
  await page.mouse.up()

  const after = await laneWidths(page)

  expect(after[0]!).toBeGreaterThan(before[0]! + 150)
  expect(after[1]!).toBeLessThan(before[1]!)
  expect(after[2]!).toBeLessThan(before[2]!)
  // 分隔条与左侧泳道同格、不占独立轨道，所以拖完轨数还是 3。
  expect(await countLaneTracks(page)).toBe(3)

  // 双击回到均分。
  await handle.dblclick()
  const reset = await laneWidths(page)
  expect(Math.abs(reset[0]! - reset[1]!)).toBeLessThan(2)
  expect(Math.abs(reset[1]! - reset[2]!)).toBeLessThan(2)
})

test('a saved lane ratio applies on a wide board and steps aside on a narrow one', async ({
  page,
}) => {
  await installMockApis(page, 1, 'dark', { standby: 600, running: 300, done: 300 })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)
  await expect(page.locator('.automation-board')).toBeVisible()

  const wide = await laneWidths(page)
  expect(wide[0]!).toBeGreaterThan(wide[1]! * 1.6)

  await page.close()

  // 同一份自定义宽度，换到窄档：内联样式若写的是 grid-template-columns 而不是
  // 一个自定义属性，这里会被永久钉死成三轨。
  const narrow = await page.context().newPage()
  await installMockApis(narrow, 3, 'dark', { standby: 600, running: 300, done: 300 })
  await narrow.setViewportSize({ width: 1440, height: 1000 })
  await narrow.goto(appUrl)
  await expect(narrow.locator('.automation-board')).toBeVisible()

  expect(await countLaneTracks(narrow)).toBe(1)
  await expect(narrow.locator('.automation-board-lane-resize-handle').first()).toBeHidden()
})

test('the compose row keeps the model picker and the primary action on one line', async ({
  page,
}) => {
  await installMockApis(page, 2, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  const actions = page.locator('.automation-board-lane-compose-actions')
  await expect(actions).toBeVisible()

  const select = actions.locator('.automation-board-compose-model')
  const button = actions.locator('.btn')
  const selectBox = (await select.boundingBox())!
  const buttonBox = (await button.boundingBox())!
  expect(Math.abs(selectBox.y - buttonBox.y)).toBeLessThan(4)
})

// 两套主题都要拍：面板底色、分组标题、chevron、超管警告红都是分主题的 token，
// 只钉一张 dark 的话，亮色下的对比度回归不会被任何用例接住。
for (const theme of ['dark', 'light'] as const) {
test(`an expanded template panel uses two field columns on a wide board (${theme})`, async ({ page }) => {
  await installMockApis(page, 1, theme)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  await page.locator('.automation-board-template-configure').first().click()

  const config = page.locator('.automation-board-template-config')
  await expect(config).toBeVisible()

  const tracks = await config.evaluate(
    (node) => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length,
  )
  expect(tracks).toBe(2)

  // 旧版这里断言的是"需求和触发器都整行跨栏" —— 那时面板没有分组结构，8 个控件
  // 按文档序自己往格子里掉，只能靠强制跨栏来阻止相关控件被劈到左右两栏。
  // 现在按语义分组显式落位：名称与操作行跨栏，需求独占左栏并跨两行，执行方式与
  // 触发器叠在右栏。断言跟着改成"每一组都落在它该在的位置"。
  const areas = await config.evaluate((node) => {
    const at = (selector: string) => {
      const style = getComputedStyle(node.querySelector(selector)!)
      return `${style.gridColumnStart}/${style.gridRowStart}`
    }
    return {
      name: at('.automation-board-template-field.is-name'),
      requirement: at('.automation-board-template-group.is-requirement'),
      execution: at('.automation-board-template-group.is-execution'),
      trigger: at('.automation-board-template-group.is-trigger'),
      actions: at('.automation-board-template-config-actions'),
    }
  })
  expect(areas).toEqual({
    name: 'name/name',
    requirement: 'req/req',
    execution: 'exec/exec',
    trigger: 'trigger/trigger',
    actions: 'actions/actions',
  })

  // 需求组在双栏里跨两行，所以它必须比右栏任意一组都高；同时任何一组都不能被
  // 压得装不下自己的内容（窄栏下曾经把整组压成 0 高，标题和 textarea 全溢出）。
  const heights = await config.evaluate((node) => {
    const box = (selector: string) => {
      const el = node.querySelector<HTMLElement>(selector)!
      return { h: Math.round(el.getBoundingClientRect().height), need: el.scrollHeight }
    }
    return {
      requirement: box('.automation-board-template-group.is-requirement'),
      execution: box('.automation-board-template-group.is-execution'),
      trigger: box('.automation-board-template-group.is-trigger'),
    }
  })
  for (const [name, entry] of Object.entries(heights)) {
    expect(entry.h, `${name} collapsed below its content`).toBeGreaterThanOrEqual(entry.need - 1)
  }
  expect(heights.requirement.h).toBeGreaterThan(heights.execution.h)

  await expect(page.locator('.automation-board')).toHaveScreenshot(
    `automation-board-template-config-wide-${theme}.png`,
    { animations: 'disabled', maxDiffPixelRatio: 0.004 },
  )
})
}

test('an open item drawer stays inside its card on a stacked board', async ({ page }) => {
  await installMockApis(page, 3, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  const card = page.locator('.automation-board-item[data-automation-board-item-id="item-standby-a"]')
  await card.locator('.automation-board-item-more').click()

  const drawer = card.locator('.automation-board-item-drawer')
  await expect(drawer).toBeVisible()

  const cardBox = (await card.boundingBox())!
  const drawerBox = (await drawer.boundingBox())!
  expect(drawerBox.y + drawerBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1)

  await expect(page.locator('.automation-board')).toHaveScreenshot(
    'automation-board-item-drawer-narrow-dark.png',
    { animations: 'disabled', maxDiffPixelRatio: 0.004 },
  )
})

// 「清空已完成」一次带走几十张卡（会话归档进历史，不是真删），所以它必须先问一次，
// 也必须只出现在已完成道 —— 待命/执行中的项还在编排里，批量删它们没有对应的用户意图。
test('clearing the done lane drops its items after a confirm', async ({ page }) => {
  await installMockApis(page, 1, 'dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)

  const doneLane = page.locator('.automation-board-lane[data-lane="done"]')
  await expect(doneLane.locator('.automation-board-item')).toHaveCount(1)
  await expect(
    page.locator('.automation-board-lane:not([data-lane="done"]) .automation-board-lane-clear'),
  ).toHaveCount(0)

  // 先拒一次：确认框不是装饰，取消必须什么都不做。
  page.once('dialog', (dialog) => void dialog.dismiss())
  await doneLane.locator('.automation-board-lane-clear').click()
  await expect(doneLane.locator('.automation-board-item')).toHaveCount(1)

  page.once('dialog', (dialog) => void dialog.accept())
  await doneLane.locator('.automation-board-lane-clear').click()

  await expect(doneLane.locator('.automation-board-item')).toHaveCount(0)
  // 其余泳道原样：清空只吃已完成道。
  await expect(page.locator('.automation-board-item')).toHaveCount(3)
  // 空泳道不留一个点了没反应的按钮。
  await expect(doneLane.locator('.automation-board-lane-clear')).toHaveCount(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`the done lane head keeps the clear action legible (${theme})`, async ({ page }) => {
    await installMockApis(page, 1, theme)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(appUrl)

    const head = page.locator('.automation-board-lane[data-lane="done"] .automation-board-lane-head')
    await expect(head.locator('.automation-board-lane-clear')).toBeVisible()

    // 标题吃掉多余空间，计数胶囊与按钮贴在右侧成一组 —— 计数跑到正中间就是
    // 那条 flex: 1 掉了。
    const gap = await head.evaluate((node) => {
      const count = node.querySelector<HTMLElement>('.automation-board-lane-count')!
      const clear = node.querySelector<HTMLElement>('.automation-board-lane-clear')!
      return Math.round(clear.getBoundingClientRect().left - count.getBoundingClientRect().right)
    })
    expect(gap).toBeLessThanOrEqual(12)

    await expect(head).toHaveScreenshot(`automation-board-done-lane-head-${theme}.png`, {
      animations: 'disabled',
    })
  })
}

// "N 在跑"是强调色 + 呼吸圆点，两个主题都要能从旁边那颗中性计数胶囊里分出来。
for (const theme of ['dark', 'light'] as const) {
  test(`the running lane head separates live work from the item count (${theme})`, async ({
    page,
  }) => {
    await installMockApis(page, 1, theme)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(appUrl)

    const head = page.locator(
      '.automation-board-lane[data-lane="running"] .automation-board-lane-head',
    )
    await expect(head.locator('.automation-board-lane-running')).toBeVisible()
    await expect(head.locator('.automation-board-lane-running')).toHaveText(/1/)
    // 不在跑的泳道不长出这个按钮。
    await expect(
      page.locator('.automation-board-lane[data-lane="done"] .automation-board-lane-running'),
    ).toHaveCount(0)

    await expect(head).toHaveScreenshot(`automation-board-running-lane-head-${theme}.png`, {
      animations: 'disabled',
    })
  })
}
