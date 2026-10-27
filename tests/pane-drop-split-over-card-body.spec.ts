import { expect, test, type Page } from '@playwright/test'

import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { appUrl } from './playwright-app-url.ts'

// 症状（2026-10-27 用户报）：同一 pane 里开两张文件树，把其中一张的 tab 拖到另一张文件树的内容上，
// 蓝色分栏预览亮了，松手却什么都不发生。根因：文件树的 drop 处理不看拖的是什么，一律 stopPropagation，
// pane 的 drop 永远收不到。这里在鼠标落点的真实元素上派发事件，覆盖各类卡片内容区。

type CardSeed = { id: string; title: string; model: string }

const card = ({ id, title, model }: CardSeed) => ({
  id,
  title,
  status: 'idle' as const,
  size: 560,
  provider: 'claude' as const,
  model,
  reasoningEffort: 'medium',
  draft: '',
  messages: [],
})

const setup = async (page: Page, seeds: CardSeed[]) => {
  await installMockElectronBridge(page)
  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en' as const,
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: { codex: 'gpt-5.5', claude: 'claude-opus-4-7' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Board',
        provider: 'claude' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'claude-opus-4-7',
        cards: seeds.map(card),
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
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    }),
  )
  await page.route('**/api/setup/status', (route) => route.fulfill({ json: { state: 'idle', logs: [] } }))
  await page.route('**/api/slash-commands', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/files/list', (route) =>
    route.fulfill({
      json: {
        entries: Array.from({ length: 40 }, (_, index) => ({ name: `file-${index}.ts`, isDirectory: index < 5 })),
      },
    }),
  )

  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)
}

const cases: Array<{ name: string; dragged: CardSeed; target: CardSeed }> = [
  {
    name: 'file tree',
    dragged: { id: 'f1', title: 'Files 1', model: '__filetree_tool__' },
    target: { id: 'f2', title: 'Files 2', model: '__filetree_tool__' },
  },
  {
    name: 'sticky note',
    dragged: { id: 'n1', title: 'Note 1', model: '__stickynote_tool__' },
    target: { id: 'n2', title: 'Note 2', model: '__stickynote_tool__' },
  },
  {
    name: 'chat',
    dragged: { id: 'c1', title: 'Chat 1', model: 'claude-opus-4-7' },
    target: { id: 'c2', title: 'Chat 2', model: 'claude-opus-4-7' },
  },
]

for (const { name, dragged, target } of cases) {
  test(`dropping a tab onto the body of another ${name} card splits the pane`, async ({ page }) => {
    await setup(page, [dragged, target])

    const draggedTab = page.locator(`.pane-tab[data-pane-tab-id="${dragged.id}"]`)
    await expect(draggedTab).toBeVisible()
    await page.locator(`.pane-tab[data-pane-tab-id="${target.id}"]`).click()
    if (target.model === '__filetree_tool__') {
      await expect(page.locator('.file-tree-item').first()).toBeVisible()
    }

    const content = page.locator('.pane-content').first()
    const box = await content.boundingBox()
    if (!box) {
      throw new Error('Expected the pane content to be visible')
    }
    const x = box.x + box.width / 2
    const y = box.y + box.height * 0.85

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    await draggedTab.dispatchEvent('dragstart', { dataTransfer, clientX: x, clientY: y, bubbles: true, cancelable: true })

    const hit = await page.evaluateHandle(([px, py]) => document.elementFromPoint(px, py)!, [x, y] as const)
    for (const type of ['dragenter', 'dragover', 'drop']) {
      await hit.evaluate(
        (element, [eventType, px, py, dt]) =>
          element.dispatchEvent(
            new DragEvent(eventType as string, {
              clientX: px as number,
              clientY: py as number,
              bubbles: true,
              cancelable: true,
              dataTransfer: dt as DataTransfer,
            }),
          ),
        [type, x, y, dataTransfer] as const,
      )
    }

    await expect(page.locator('.split-container[data-direction="vertical"]')).toHaveCount(1)
    await expect(page.locator('.pane-view')).toHaveCount(2)
    await expect(page.locator('.pane-view').nth(1).locator(`.pane-tab[data-pane-tab-id="${dragged.id}"]`)).toBeVisible()
  })
}
