import { expect, test, type Page } from '@playwright/test'

import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = 'http://127.0.0.1:5173'

const fileContent = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n')

const installChatWithFileReference = async (
  page: Page,
  theme: 'dark' | 'light' = 'dark',
  options: { fileMissing?: boolean } = {},
) => {
  await installMockElectronBridge(page)

  let state = createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'en',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: DEFAULT_CODEX_MODEL,
        claude: 'claude-opus-4-7',
      },
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
                id: 'tool-1',
                role: 'assistant',
                content: '',
                createdAt: new Date().toISOString(),
                meta: {
                  kind: 'tool',
                  structuredData: JSON.stringify({
                    itemId: 'tool-item-1',
                    toolName: 'Read',
                    summary: 'Read src/sample.ts',
                    toolInput: { file_path: 'src/sample.ts', offset: '20', limit: '10' },
                  }),
                },
              },
              {
                id: 'assistant-1',
                role: 'assistant',
                content: '真正的耗时在 `src/sample.ts:12` 里，另见 `writeFileSync` 的调用。',
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

  await page.route('**/api/files/read', async (route) => {
    if (options.fileMissing) {
      await route.fulfill({
        status: 400,
        json: { message: "ENOENT: no such file or directory, open 'd:\\Git\\demo-workspace\\src\\sample.ts'" },
      })
      return
    }

    await route.fulfill({
      json: { content: fileContent, language: 'typescript', revision: 'rev-1', size: fileContent.length },
    })
  })

  await page.route('**/api/files/write', async (route) => {
    await route.fulfill({ json: { revision: 'rev-2' } })
  })

  await page.route('**/api/git/file-line-diff', async (route) => {
    await route.fulfill({
      json: { isRepository: false, tracked: false, added: [], modified: [], removed: [] },
    })
  })

  await page.route('**/api/git/head-file', async (route) => {
    await route.fulfill({ json: { isRepository: false, headContent: null } })
  })

  await page.route('**/api/files/nearest-tsconfig', async (route) => {
    await route.fulfill({ json: { compilerOptions: null } })
  })
}

test('clicking a file path in an assistant reply opens the built-in editor at that line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installChatWithFileReference(page)
  await page.goto(appUrl)

  const reference = page.locator('.message-file-reference button')
  await expect(reference).toHaveCount(1)
  await expect(reference).toHaveAttribute('data-open-file-path', 'src/sample.ts')
  await expect(reference).toHaveAttribute('data-open-file-line', '12')

  await reference.click()

  const editorCard = page.locator('.text-editor-card').first()
  await expect(editorCard).toBeVisible()
  await expect(editorCard.locator('.text-editor-statusbar-item').first()).toHaveText('12:1')
})

// Tool activities are folded into a collapsed StructuredToolGroupCard, so the
// real path is: expand the group -> expand the tool card -> click the file.
test('the file path a tool card reports is openable at the line the agent read', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installChatWithFileReference(page)
  await page.goto(appUrl)

  const group = page.locator('.message-list .structured-command-group').first()
  await group.locator('.structured-group-summary-row').click()

  const toolCard = group.locator('.structured-tool-card').first()
  await toolCard.locator('.structured-command-inline-row').click()

  const toolFileButton = toolCard.locator('.structured-tool-detail-value button')
  await expect(toolFileButton).toHaveAttribute('data-open-file-path', 'src/sample.ts')
  await expect(toolFileButton).toHaveAttribute('data-open-file-line', '20')

  await toolFileButton.click()

  const editorCard = page.locator('.text-editor-card').first()
  await expect(editorCard).toBeVisible()
  await expect(editorCard.locator('.text-editor-statusbar-item').first()).toHaveText('20:1')
})

test('alt-click keeps the reveal-in-explorer escape hatch instead of opening the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installChatWithFileReference(page)
  await page.goto(appUrl)

  await page.locator('.message-file-reference button').click({ modifiers: ['Alt'] })

  // The reveal call goes through the desktop bridge, which the mock does not
  // implement — the point of the assertion is that the editor tab is NOT opened.
  await expect(page.locator('.text-editor-card')).toHaveCount(0)
})

test('a path the model invented says so instead of dumping a raw ENOENT', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installChatWithFileReference(page, 'dark', { fileMissing: true })
  await page.goto(appUrl)

  await page.locator('.message-file-reference button').click()

  const editorCard = page.locator('.text-editor-card').first()
  await expect(editorCard).toContainText('This file does not exist in the workspace.')
  await expect(editorCard).not.toContainText('ENOENT')
})

test('inline code that is not a path stays unclickable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installChatWithFileReference(page)
  await page.goto(appUrl)

  await expect(page.locator('.message-file-reference button')).toHaveCount(1)
  await expect(page.locator('.message-content code', { hasText: 'writeFileSync' })).toHaveCount(1)
  await expect(
    page.locator('.message-file-reference button', { hasText: 'writeFileSync' }),
  ).toHaveCount(0)
})

// Tool cards inside a collapsed group render outside .message-content, so a
// .message-content-scoped button style silently leaves them with the browser's
// default grey chrome. Snapshot them separately — the click tests pass either way.
for (const theme of ['dark', 'light'] as const) {
  test(`a tool card file button matches the surrounding detail text in ${theme} theme`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 820 })
    await installChatWithFileReference(page, theme)
    await page.goto(appUrl)

    const group = page.locator('.message-list .structured-command-group').first()
    await group.locator('.structured-group-summary-row').click()

    const toolCard = group.locator('.structured-tool-card').first()
    await toolCard.locator('.structured-command-inline-row').click()

    const details = toolCard.locator('.structured-tool-details')
    await expect(details).toBeVisible()
    await expect(details).toHaveScreenshot(`tool-card-file-rest-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 200,
    })

    await details.locator('button').hover()
    await expect(details).toHaveScreenshot(`tool-card-file-hover-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 200,
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`clickable file references stay quiet at rest and light up on hover in ${theme} theme`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 820 })
    await installChatWithFileReference(page, theme)
    await page.goto(appUrl)

    const bubble = page
      .locator('.message-list .message-content')
      .filter({ hasText: '真正的耗时' })
      .first()
    await expect(bubble).toBeVisible()
    await expect(bubble).toHaveScreenshot(`chat-file-reference-rest-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 200,
    })

    await page.locator('.message-file-reference button').hover()
    await expect(bubble).toHaveScreenshot(`chat-file-reference-hover-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 200,
    })
  })
}
