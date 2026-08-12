import { expect, test, type Page } from '@playwright/test'

import { createPane } from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const boardCardId = 'board-1'
const workspacePath = 'd:\\Git\\chill-vibe'

const attachment = {
  id: 'att-1',
  fileName: 'shot.png',
  mimeType: 'image/png',
  sizeBytes: 3,
}

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
            automationBoard: { items: [] },
          },
        ],
      },
    ],
  })

const installMockApis = async (page: Page, saves: unknown[]) => {
  await installMockElectronBridge(page)

  let state = createState()

  await page.route('**/api/state', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    if (request.method() === 'PUT') {
      const body = JSON.parse(request.postData() ?? '{}')
      saves.push(body)
      state = createPlaywrightState(body)
      await route.fulfill({ json: state })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    saves.push(body)
    state = createPlaywrightState(body)
    await route.fulfill({ status: 204 })
  })

  await page.route('**/api/attachments', async (route) => {
    await route.fulfill({ json: attachment })
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

// 需求经常本身就是一张截图。粘贴要能直接落在「加入待命」上，而不是逼用户
// 先把卡建出来再进卡里粘一遍。
test('pasting an image into the standby composer rides along with the new item', async ({
  page,
}) => {
  const saves: unknown[] = []
  await installMockApis(page, saves)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const composer = page.locator('.automation-board-lane-compose textarea')
  await expect(composer).toBeVisible()

  await composer.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  })

  await expect(page.locator('.automation-board-compose-attachments img')).toHaveCount(1)

  await composer.fill('看这张图，把这块改掉')
  await page.getByRole('button', { name: '加入待命' }).click()

  await expect(page.locator('.automation-board-item')).toHaveCount(1)
  // 图片跟着新建的待命项落进它自己的草稿附件里，等被拖进执行中道时才发出去。
  await expect
    .poll(() =>
      saves.some((save) => {
        const columns = (save as { columns?: { cards?: Record<string, unknown> }[] }).columns ?? []
        return columns.some((column) =>
          Object.values(column.cards ?? {}).some((card) => {
            const attachments = (card as { draftAttachments?: { id: string }[] }).draftAttachments
            return attachments?.some((entry) => entry.id === attachment.id) === true
          }),
        )
      }),
    )
    .toBe(true)
})
