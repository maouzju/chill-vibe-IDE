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

/**
 * 症状（2026-08-17 用户截图）：模板胶囊右端那排图标钮，一旦画出底色（删除钮的
 * 红圆、展开钮 hover / focus 的圆），图标明显不在圆心里 —— 内容和边框对不齐。
 *
 * 根因不在任何一条应用样式里：`.icon-button` 从来没有重置过 Chromium 给
 * `<button>` 的 UA 默认 `padding: 1px 6px`。按钮是 `display: grid` + 居中，居中
 * 的是**内容框**而不是边框盒，于是左右各 6px 的内边距把图标整体推向右侧。
 * 偏移量随按钮变小而变大：28px 钮内容框还有 14px（放得下 13px 图标，几乎看不
 * 出来），缩到 20px 只剩 6px、缩到 18.4px 只剩 4.4px，12~15px 的图标彻底放不下，
 * grid 退化成靠左，实测偏心 +3px / +5.4px。所以现象是「有些按钮不对齐」——
 * 越小的钮越明显。
 *
 * 这条用例不盯 padding，只盯最终几何：纯图标按钮的图标必须落在边框盒正中。
 */
for (const theme of ['dark', 'light'] as const) {
  test(`an icon-only button centers its glyph in the button box (${theme})`, async ({ page }) => {
    await boot(page, theme)
    await page.locator('.automation-board-template').first().hover()
    await page.locator('.automation-board-template-configure').first().click()
    await expect(page.locator('.automation-board-template-config')).toBeVisible()

    const offenders = await page.evaluate(() => {
      const rows: { cls: string; box: string; glyph: string; dx: number; dy: number }[] = []
      document.querySelectorAll('button').forEach((el) => {
        // 只看纯图标钮：带文字的按钮里图标本来就该偏，不在此列。
        if ((el.textContent ?? '').trim().length > 0) return
        const svg = el.querySelector(':scope > svg')
        if (!svg) return
        const box = el.getBoundingClientRect()
        const glyph = svg.getBoundingClientRect()
        if (box.width === 0 || glyph.width === 0) return
        const dx = glyph.x + glyph.width / 2 - (box.x + box.width / 2)
        const dy = glyph.y + glyph.height / 2 - (box.y + box.height / 2)
        if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return
        rows.push({
          cls: (el.className || '(no class)').toString(),
          box: `${box.width.toFixed(1)}x${box.height.toFixed(1)}`,
          glyph: `${glyph.width.toFixed(1)}x${glyph.height.toFixed(1)}`,
          dx: +dx.toFixed(2),
          dy: +dy.toFixed(2),
        })
      })
      return rows
    })

    expect(offenders).toEqual([])
  })
}

/**
 * 同一张截图里的第二条：暗色下删除钮**静息态**就顶着红底红框的实心圆，而同排的
 * 展开 / 改名钮是透明无框的。15349 那段注释里写明的意图是"静息只剩图标，框和
 * 底色留给 hover / focus"，但它只验了 default tone。
 *
 * `:root[data-theme='dark'] .icon-button.is-danger` 是 (0,4,0)，压得过胶囊那条
 * (0,3,0) 的覆盖，于是暗色下 danger 的底色又被画了回来 —— 亮色因为
 * `.icon-button.is-danger` 只有 (0,2,0) 所以看不到这个问题，又是一处"同一根因
 * 的两种面孔"。
 *
 * 用例只断言最终状态：一排钮静息时长得必须一样，不能单独一个常驻红点。
 */
for (const theme of ['dark', 'light'] as const) {
  test(`the delete chip button rests in the same skin as its siblings (${theme})`, async ({
    page,
  }) => {
    await boot(page, theme)
    await page.locator('.automation-board-template').first().hover()

    const skins = await page.evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const s = getComputedStyle(el)
        return { sel, background: s.backgroundColor, border: s.borderColor, shadow: s.boxShadow }
      }
      return [
        read('.automation-board-template-configure'),
        read('.automation-board-template-rename'),
        read('.automation-board-template-delete'),
      ]
    })

    expect(skins.filter(Boolean)).toHaveLength(3)
    const [configure, , remove] = skins
    expect(remove!.background).toBe(configure!.background)
    expect(remove!.border).toBe(configure!.border)
    expect(remove!.shadow).toBe(configure!.shadow)
  })
}

/**
 * 症状（2026-08-16 用户截图）：待命 composer 的「参数」区里，思考深度那个下拉
 * 渲染成 `中 ⌄⌄⌄⌄⌄⌄⌄` —— 一排七个箭头平铺满整个框。
 *
 * 根因是三件事叠在一起，单看哪一件都不像 bug：
 *   1. `.automation-board-template-field select`（特异性 0-1-1）当时用 `background`
 *      **简写** 设底色，把 `background-repeat/size/position` 一并重置成初始值
 *      （repeat / auto / 0% 0%）。
 *   2. `:root[data-theme='dark'] .reasoning-select`（0-2-0）**压过**它，把 chevron
 *      的 `background-image` 又画了回来 —— 但只画回 image，那三个被重置的属性没人管。
 *   3. 窄列下 `.model-select, .reasoning-select { max-width: none }` 把框拉宽，
 *      于是一张 10px 的箭头图从左上角平铺出七个。
 * 亮色主题下第 2 步不成立（`.reasoning-select` 只有 0-1-0，压不过），所以那边
 * 表现为「一个箭头都没有」—— 同一个根因的两种面孔，都不像"背景简写"。
 *
 * 这条用例不盯任何一条具体规则，只盯最终状态：只要一个下拉画了背景图，它就
 * 必须是不平铺的。
 */
for (const theme of ['dark', 'light'] as const) {
  test(`a dropdown chevron never tiles across the control (${theme})`, async ({ page }) => {
    // 三列 = 窄列档，正是把 `max-width: none` 打开、让平铺显形的那一档。
    await boot(page, theme, 3)

    await page.locator('.automation-board-template-configure').first().click()
    await expect(page.locator('.automation-board-template-config')).toBeVisible()

    // 待命 composer 的参数折叠区与模板面板共用同一组字段样式，一起纳入扫描。
    await page.locator('.automation-board-compose-settings-toggle').first().click()
    await expect(page.locator('.automation-board-compose-settings')).toBeVisible()

    const selects = await page.locator('.automation-board select').evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        return {
          cls: node.className || '(no class)',
          width: Math.round(node.getBoundingClientRect().width),
          backgroundImage: style.backgroundImage === 'none' ? 'none' : 'image',
          backgroundRepeat: style.backgroundRepeat,
          backgroundSize: style.backgroundSize,
        }
      }),
    )

    expect(selects.length).toBeGreaterThan(1)
    for (const entry of selects) {
      if (entry.backgroundImage === 'none') continue
      expect(entry.backgroundRepeat, `${entry.cls} tiles its chevron`).toBe('no-repeat')
      // `auto` 意味着 background-size 也被简写重置了；一张 10px 的图会按原尺寸
      // 从左上角开始铺，而不是缩到箭头该在的角落。
      expect(entry.backgroundSize, `${entry.cls} lost its chevron sizing`).not.toBe('auto')
    }
  })
}
