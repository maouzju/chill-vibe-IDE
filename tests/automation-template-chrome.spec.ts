import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

/**
 * 模板条 / 模板配置面板的「交互装饰」回归。
 *
 * 起因：用户截图里模板胶囊上的展开按钮外面挂着一圈刺眼的白色双环 —— 那是
 * Chromium 的 UA 默认 `outline: auto` 焦点环。`.icon-button` 全局从来没定义过
 * `:focus-visible`，所以只要按钮拿到键盘焦点（点一下再切走窗口再切回来就会
 * 发生），浏览器默认环就直接糊在 20px 的小圆钮外面。
 *
 * 顺带覆盖同一次审查里查出来的另外两条：配置面板被 max-height 截断后
 * 「立即运行」整行看不见，以及模型标签被压成 `clau…` 这种无意义残字。
 */

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'
const boardCardId = 'board-1'
const workspacePath = 'd:\\Git\\chill-vibe'

const template = (
  id: string,
  name: string,
  options?: {
    builtIn?: boolean
    trigger?: boolean
    adminAccess?: boolean
    model?: string
    provider?: 'codex' | 'claude'
  },
) => ({
  id,
  name,
  requirement: `${name} 的需求原文，用来占位一段比胶囊更宽的文字。`,
  provider: options?.provider ?? ('codex' as const),
  model: options?.model ?? 'gpt-5.5',
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

const createState = (theme: 'dark' | 'light', columnCount: number) =>
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
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-5' },
      modelReasoningEfforts: { codex: {}, claude: {} },
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
          template('tpl-long', '每天早上把昨天所有失败的回归用例整理成一份复盘', {
            trigger: true,
            provider: 'claude',
            model: 'claude-opus-5',
          }),
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
      ...Array.from({ length: Math.max(0, columnCount - 1) }, (_, index) => fillerColumn(index)),
    ],
  })

const installMockApis = async (page: Page, theme: 'dark' | 'light', columnCount: number) => {
  await installMockElectronBridge(page)
  let state = createState(theme, columnCount)

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

const boot = async (page: Page, theme: 'dark' | 'light', columnCount = 1) => {
  await installMockApis(page, theme, columnCount)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(appUrl)
  await expect(page.locator('.automation-board-templates')).toBeVisible()
}

for (const theme of ['dark', 'light'] as const) {
  test(`no template control falls back to the browser default focus ring (${theme})`, async ({
    page,
  }) => {
    await boot(page, theme)
    // 配置面板也展开，把里面的输入 / 下拉 / 复选框一起纳入扫描。
    await page.locator('.automation-board-template-configure').first().click()
    await expect(page.locator('.automation-board-template-config')).toBeVisible()

    // 必须走真键盘 Tab：对 <button> 调 element.focus() 不会点亮 `:focus-visible`，
    // 而用户遇到的正是键盘 / 窗口切回后浏览器判定「该显示焦点环」的那一刻。
    const controlCount = await page
      .locator('.automation-board-templates')
      .locator('button, input, select, textarea, [tabindex]')
      .count()
    expect(controlCount).toBeGreaterThan(5)

    await page.locator('.automation-board-template-name').first().click()
    const leaks: string[] = []
    const seen = new Set<string>()

    for (let step = 0; step < controlCount * 3; step += 1) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || !el.closest('.automation-board-templates')) return null
        const style = getComputedStyle(el)
        return {
          id: `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`,
          focusVisible: el.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
        }
      })
      if (!stop) continue
      if (seen.has(stop.id)) continue
      seen.add(stop.id)
      // `outline-style: auto` 就是 UA 默认焦点环 —— 应用自己没接管。
      if (stop.focusVisible && stop.outlineStyle === 'auto') leaks.push(stop.id)
    }

    expect(seen.size).toBeGreaterThan(3)
    expect(leaks).toEqual([])
  })
}

test('the expanded template panel keeps its action row reachable when it scrolls', async ({
  page,
}) => {
  await boot(page, 'dark')
  await page.locator('.automation-board-template-configure').first().click()

  const config = page.locator('.automation-board-template-config')
  await expect(config).toBeVisible()

  const actions = config.locator('.automation-board-template-config-actions')
  await expect(actions).toBeVisible()

  // 面板顶到 max-height 后会内部滚动。此时「立即运行」不能整行掉到可视区外，
  // 否则用户以为这个功能不存在（6px 的滚动条几乎看不见）。
  const reachable = await config.evaluate((node) => {
    const row = node.querySelector<HTMLElement>('.automation-board-template-config-actions')!
    const panel = node.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    return {
      scrolls: node.scrollHeight > node.clientHeight + 1,
      visibleHeight: Math.max(0, Math.min(panel.bottom, rect.bottom) - Math.max(panel.top, rect.top)),
      rowHeight: rect.height,
    }
  })

  expect(reachable.rowHeight).toBeGreaterThan(0)
  expect(reachable.visibleHeight).toBeGreaterThanOrEqual(reachable.rowHeight - 1)
})

test('a chip never degrades the model label into a meaningless stub', async ({ page }) => {
  await boot(page, 'dark', 3)

  const labels = await page
    .locator('.automation-board-template-model')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent ?? '',
        width: node.getBoundingClientRect().width,
        full: node.scrollWidth,
      })),
    )

  expect(labels.length).toBeGreaterThan(0)
  for (const label of labels) {
    // 型号是用来佐证「这枚模板跑在哪个模型上」的，截成 `clau…` 等于没有信息。
    expect(label.width).toBeGreaterThanOrEqual(label.full - 1)
  }
})
