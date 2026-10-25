import { expect, test, type Page } from '@playwright/test'

import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'
import { appUrl } from './playwright-app-url.ts'

// 1x1 红色 PNG
const redPixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const installChatWithImage = async (page: Page) => {
  await installMockElectronBridge(page)

  const state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark',
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: { codex: DEFAULT_CODEX_MODEL, claude: 'claude-opus-4-7' },
      modelReasoningEfforts: { codex: {}, claude: {} },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'column-chat',
        title: 'Chat Workspace',
        provider: 'codex',
        workspacePath: 'd:\\Git\\demo-workspace',
        model: DEFAULT_CODEX_MODEL,
        cards: [
          {
            id: 'chat-card',
            title: 'Chat',
            provider: 'codex',
            model: DEFAULT_CODEX_MODEL,
            status: 'idle',
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: `截图如下：\n\n![红点](${redPixel})\n\n以上。`,
                createdAt: new Date().toISOString(),
              },
            ],
            draft: '',
            size: 440,
          },
        ],
      },
    ],
  })

  await page.route('**/api/state', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }
    await route.fulfill({ json: state })
  })
  await page.route('**/api/state/snapshot', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/providers', (route) =>
    route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    }),
  )
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({ json: { state: 'idle', logs: [] } }),
  )
  await page.route('**/api/slash-commands', (route) => route.fulfill({ json: [] }))
}

test('right-clicking an image in an assistant reply copies it to the clipboard as PNG', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1280, height: 820 })
  await installChatWithImage(page)
  await page.goto(appUrl)

  const image = page.locator('.message-list img').first()
  await expect(image).toBeVisible()
  await image.click({ button: 'right' })

  const menu = page.locator('.file-path-context-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['复制图片'])
  await page.screenshot({ path: 'test-results/message-image-copy-menu.png' })

  await menu.getByRole('menuitem', { name: '复制图片' }).click()
  await expect(menu).toHaveCount(0)

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const items = await navigator.clipboard.read()
        return items[0]?.types ?? []
      }),
    )
    .toContain('image/png')
})
