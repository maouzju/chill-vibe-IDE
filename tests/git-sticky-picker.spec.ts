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
          {
            name: 'report.final.md',
            isDirectory: false,
          },
          {
            name: '.gitignore',
            isDirectory: false,
          },
          {
            name: 'Makefile',
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

  // 2026-10-14 用户报「重命名文件有 bug」：fill() 一次性写值测不出逐键回归，
  // 这里必须逐字敲，才能抓到「每敲一个字整框被重新全选、下一个字覆盖全部」。
  test(`file tree rename keeps every typed character and preselects only the base name in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme, FILETREE_TOOL_MODEL, 'Files')
    await page.goto('http://localhost:5173')

    const fileTreeCard = page.locator('.file-tree-card').first()
    await expect(fileTreeCard).toBeVisible()

    await fileTreeCard.getByRole('button', { name: /README\.md/ }).click({ button: 'right' })
    await page.getByRole('button', { name: '重命名…' }).click()

    const dialog = page.locator('.file-tree-name-dialog')
    const input = dialog.locator('.file-tree-name-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('README.md')

    // VS Code 习惯：文件只预选扩展名前的主名，直接敲字就保留 .md。
    await expect
      .poll(() => input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
      .toEqual([0, 'README'.length])

    await input.pressSequentially('notes-v2')
    await expect(input).toHaveValue('notes-v2.md')

    // 再全选重敲一个多字符名字，确认提交出去的是完整字符串而不是最后一个字。
    await input.press('ControlOrMeta+a')
    await input.pressSequentially('CHANGELOG.txt')
    await expect(input).toHaveValue('CHANGELOG.txt')

    const renameRequest = page.waitForRequest((request) =>
      request.url().endsWith('/api/files/rename') && request.method() === 'POST',
    )
    await input.press('Enter')

    const request = await renameRequest
    expect(request.postDataJSON()).toMatchObject({
      workspacePath: 'd:\\Git\\chill-vibe',
      relativePath: 'README.md',
      nextName: 'CHANGELOG.txt',
    })
    await expect(dialog).toHaveCount(0)
  })

  test(`file tree rename preselects the base name per entry kind and keeps typed characters in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme, FILETREE_TOOL_MODEL, 'Files')
    await page.goto('http://localhost:5173')

    const fileTreeCard = page.locator('.file-tree-card').first()
    await expect(fileTreeCard).toBeVisible()

    const dialog = page.locator('.file-tree-name-dialog')
    const input = dialog.locator('.file-tree-name-input')

    // [条目名, 预选结束位置, 逐字敲入后期望的值]
    for (const [name, selectionEnd, expectedAfterTyping] of [
      ['src', 'src'.length, 'lib'],
      ['report.final.md', 'report.final'.length, 'lib.md'],
      ['.gitignore', '.gitignore'.length, 'lib'],
      ['Makefile', 'Makefile'.length, 'lib'],
    ] as const) {
      await fileTreeCard.getByRole('button', { name, exact: true }).click({ button: 'right' })
      await page.getByRole('button', { name: '重命名…' }).click()

      await expect(input).toBeFocused()
      await expect(input).toHaveValue(name)
      await expect
        .poll(() => input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
        .toEqual([0, selectionEnd])

      await input.pressSequentially('lib')
      await expect(input).toHaveValue(expectedAfterTyping)

      await input.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
  })

  test(`file tree rename keeps focus and the typed name after a failed rename in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme, FILETREE_TOOL_MODEL, 'Files')
    await page.route('**/api/files/rename', async (route) => {
      await route.fulfill({ status: 409, json: { message: 'A file with that name already exists.' } })
    })
    await page.goto('http://localhost:5173')

    const fileTreeCard = page.locator('.file-tree-card').first()
    await expect(fileTreeCard).toBeVisible()

    await fileTreeCard.getByRole('button', { name: /README\.md/ }).click({ button: 'right' })
    await page.getByRole('button', { name: '重命名…' }).click()

    const dialog = page.locator('.file-tree-name-dialog')
    const input = dialog.locator('.file-tree-name-input')
    await expect(input).toBeFocused()

    await input.pressSequentially('taken')
    await expect(input).toHaveValue('taken.md')
    await input.press('Enter')

    await expect(dialog.getByRole('alert')).toHaveText('A file with that name already exists.')
    await expect(input).toBeEnabled()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('taken.md')

    // 失败后接着改名不能被重新全选吃掉。
    await input.press('End')
    await input.press('Backspace')
    await input.press('Backspace')
    await input.pressSequentially('txt')
    await expect(input).toHaveValue('taken.txt')
  })

  test(`file tree name dialog ignores Escape while an IME composition is active in ${theme} theme`, async ({
    page,
  }) => {
    await installMockApis(page, theme, FILETREE_TOOL_MODEL, 'Files')
    await page.goto('http://localhost:5173')

    const fileTreeCard = page.locator('.file-tree-card').first()
    await expect(fileTreeCard).toBeVisible()

    await fileTreeCard.getByRole('button', { name: /README\.md/ }).click({ button: 'right' })
    await page.getByRole('button', { name: '重命名…' }).click()

    const dialog = page.locator('.file-tree-name-dialog')
    const input = dialog.locator('.file-tree-name-input')
    await expect(input).toBeFocused()

    // 中文输入法里按 Esc 是取消候选词，浏览器会带 isComposing=true / keyCode 229；
    // 这一下不能把整个对话框关掉。
    await input.evaluate((element: HTMLInputElement) => {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }))
    })
    await page.waitForTimeout(100)
    await expect(dialog).toBeVisible()

    await input.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}
