import { expect, test, type Page } from '@playwright/test'

import { FILETREE_TOOL_MODEL, GIT_TOOL_MODEL, STICKYNOTE_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const createToolCardState = (theme: ThemeName, model: string, title: string) =>
  createPlaywrightState({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.5',
        claude: 'claude-opus-4-7',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: {
          activeProfileId: '',
          profiles: [],
        },
        claude: {
          activeProfileId: '',
          profiles: [],
        },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Tool Workspace',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.5',
        cards: [
          {
            id: 'card-tool',
            title,
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model,
            reasoningEffort: 'medium',
            draft: '',
            stickyNote: model === STICKYNOTE_TOOL_MODEL ? 'keep the picker low' : '',
            messages: [],
          },
        ],
      },
    ],
  })

const installMockApis = async (
  page: Page,
  theme: ThemeName,
  model: string,
  title: string,
) => {
  await installMockElectronBridge(page)

  let state = createToolCardState(theme, model, title)

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
    await route.fulfill({
      json: {
        state: 'idle',
        logs: [],
      },
    })
  })

  await page.route('**/api/git/status**', async (route) => {
    const workspacePath =
      new URL(route.request().url()).searchParams.get('workspacePath') ?? 'd:\\Git\\chill-vibe'

    await route.fulfill({
      json: {
        workspacePath,
        isRepository: true,
        repoRoot: workspacePath,
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasConflicts: false,
        clean: true,
        summary: {
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
        },
        changes: [],
        description: '',
      },
    })
  })

  await page.route('**/api/slash-commands', async (route) => {
    await route.fulfill({ json: [] })
  })

  await page.route('**/api/files/list', async (route) => {
    await route.fulfill({
      json: {
        entries: [
          {
            name: 'src',
            isDirectory: true,
          },
          {
            name: 'README.md',
            isDirectory: false,
          },
        ],
      },
    })
  })

  await page.route('**/api/files/rename', async (route) => {
    await route.fulfill({ status: 204 })
  })
}

for (const theme of ['dark', 'light'] as const) {
  for (const [model, title, selector] of [
    [GIT_TOOL_MODEL, 'Git', '.git-tool-card'],
    [STICKYNOTE_TOOL_MODEL, 'Sticky Note', '.sticky-note-card'],
    [FILETREE_TOOL_MODEL, 'Files', '.file-tree-card'],
  ] as const) {
    test(`tool cards no longer render redundant model pickers for ${title} in ${theme} theme`, async ({
      page,
    }) => {
      await installMockApis(page, theme, model, title)
      await page.goto('http://localhost:5173')

      const paneView = page.locator('.pane-view').first()
      const modelSelects = paneView.locator('.model-select-shell')
      const headerSelect = paneView.locator('.card-header .model-select-shell')
      const toolSurface = paneView.locator(selector).first()

      await expect(toolSurface).toBeVisible()
      await expect(headerSelect).toHaveCount(0)
      await expect(modelSelects).toHaveCount(0)
    })
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`file tree rename uses the in-app name dialog instead of unsupported native prompt in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme, FILETREE_TOOL_MODEL, 'Files')
    await page.goto('http://localhost:5173')

    const fileTreeCard = page.locator('.file-tree-card').first()
    await expect(fileTreeCard).toBeVisible()

    await fileTreeCard.getByRole('button', { name: /README\.md/ }).click({ button: 'right' })
    await page.getByRole('button', { name: '重命名…' }).click()

    const dialog = page.locator('.file-tree-name-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.file-tree-name-input')).toHaveValue('README.md')
    await expect(dialog).toContainText('只输入名称')

    const renameRequest = page.waitForRequest((request) =>
      request.url().endsWith('/api/files/rename') && request.method() === 'POST',
    )
    await dialog.locator('.file-tree-name-input').fill('README-renamed.md')
    await dialog.getByRole('button', { name: '重命名' }).click()

    const request = await renameRequest
    expect(request.postDataJSON()).toMatchObject({
      workspacePath: 'd:\\Git\\chill-vibe',
      relativePath: 'README.md',
      nextName: 'README-renamed.md',
    })
    await expect(dialog).toHaveCount(0)
  })
}
