import { expect, test, type Page } from '@playwright/test'

import { DEFAULT_CODEX_MODEL, STICKYNOTE_TOOL_MODEL, TEXTEDITOR_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const appUrl = 'http://127.0.0.1:5173'

type FileReadFixture = {
  content: string
  language: string
  revision?: string
  size?: number
  binary?: boolean
  tooLarge?: boolean
  large?: boolean
}

type FileWriteFixture = {
  revision?: string
  conflict?: boolean
}

const installEditorApis = async (
  page: Page,
  theme: ThemeName,
  fixtures: {
    read: () => FileReadFixture
    write?: () => FileWriteFixture
  },
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
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: { activeProfileId: '', profiles: [] },
        claude: { activeProfileId: '', profiles: [] },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'column-editor',
        title: 'Editor Workspace',
        provider: 'codex',
        workspacePath: 'd:\\Git\\demo-workspace',
        model: DEFAULT_CODEX_MODEL,
        cards: [
          {
            id: 'editor-card',
            title: 'Editor',
            provider: 'codex',
            model: TEXTEDITOR_TOOL_MODEL,
            status: 'idle',
            messages: [],
            draft: '',
            size: 440,
            stickyNote: 'src/sample.ts',
          },
          {
            id: 'note-card',
            title: 'Note',
            provider: 'codex',
            model: STICKYNOTE_TOOL_MODEL,
            status: 'idle',
            messages: [],
            draft: '',
            size: 440,
            stickyNote: 'scratch',
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
    await route.fulfill({ json: fixtures.read() })
  })

  await page.route('**/api/files/write', async (route) => {
    const result = fixtures.write?.() ?? { revision: 'rev-next' }
    if (result.conflict) {
      await route.fulfill({ status: 409, json: { conflict: true, message: 'conflict' } })
      return
    }
    await route.fulfill({ json: result })
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

for (const theme of ['dark', 'light'] as const) {
  test(`binary files show the guard notice instead of mojibake in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 })
    await installEditorApis(page, theme, {
      read: () => ({ content: '', language: 'plaintext', binary: true, size: 2048 }),
    })

    await page.goto(appUrl)

    const editorCard = page.locator('.text-editor-card').first()
    await expect(editorCard.locator('.text-editor-empty-title')).toHaveText('Binary file')
    await expect(editorCard.locator('.text-editor-empty-description')).toHaveText(
      'This file cannot be edited here.',
    )

    await expect(editorCard).toHaveScreenshot(`text-editor-binary-guard-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

test('oversized files are refused with the too-large notice', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installEditorApis(page, 'dark', {
    read: () => ({ content: '', language: 'plaintext', tooLarge: true, size: 50 * 1024 * 1024 }),
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  await expect(editorCard.locator('.text-editor-empty-title')).toHaveText('File too large')
})

for (const theme of ['dark', 'light'] as const) {
  test(`conflicting external edits raise the conflict banner in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 })

    let diskContent = 'const original = 1\n'
    let diskRevision = 'rev-1'

    await installEditorApis(page, theme, {
      read: () => ({
        content: diskContent,
        language: 'typescript',
        revision: diskRevision,
        size: diskContent.length,
      }),
      // Every save is rejected as a conflict, simulating an agent writing the
      // same file between the editor's read and its autosave.
      write: () => ({ conflict: true }),
    })

    await page.goto(appUrl)

    const editorCard = page.locator('.text-editor-card').first()
    const monacoSurface = editorCard.locator('.monaco-editor').first()
    await expect(monacoSurface).toBeVisible()

    // Flip the disk fixture before typing so the post-conflict re-read sees
    // genuinely divergent external content.
    diskContent = 'const external = 2\n'
    diskRevision = 'rev-2'

    await monacoSurface.locator('.view-lines').click()
    await page.keyboard.type('local edit ')

    const conflictBanner = editorCard.locator('.text-editor-conflict')
    await expect(conflictBanner).toBeVisible({ timeout: 10_000 })
    await expect(conflictBanner.locator('.text-editor-conflict-message')).toHaveText(
      'File changed on disk while you had unsaved edits.',
    )

    await expect(conflictBanner).toHaveScreenshot(`text-editor-conflict-banner-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })

    // Adopting the disk version replaces the buffer and clears the banner.
    await conflictBanner.getByRole('button', { name: 'Load disk version' }).click()
    await expect(conflictBanner).toBeHidden()
    await expect(monacoSurface).toContainText('const external = 2')
  })
}

test('editor settings changes apply to mounted editors immediately', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installEditorApis(page, 'dark', {
    read: () => ({
      content: 'const sample = 1\n',
      language: 'typescript',
      revision: 'rev-1',
      size: 18,
    }),
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  const monacoSurface = editorCard.locator('.monaco-editor').first()
  await expect(monacoSurface).toBeVisible()

  const initialFontSize = await monacoSurface
    .locator('.view-lines')
    .evaluate((node) => window.getComputedStyle(node).fontSize)

  await page.evaluate(() => {
    window.dispatchEvent(new Event('chill-vibe:noop'))
  })

  // Drive the runtime settings bridge directly — the settings dialog is
  // exercised elsewhere; this test pins the editor-side application path.
  await page.evaluate(async () => {
    const module = await import('/src/components/text-editor-settings.ts')
    module.publishTextEditorSettings({ fontSize: 20, wordWrap: true, minimap: false, tabSize: 4 })
  })

  await expect
    .poll(async () =>
      monacoSurface.locator('.view-lines').evaluate((node) => window.getComputedStyle(node).fontSize),
    )
    .toBe('20px')

  expect(initialFontSize).not.toBe('20px')
})

test('failed saves surface a retry control instead of pretending success', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installEditorApis(page, 'dark', {
    read: () => ({
      content: 'const base = 1\n',
      language: 'typescript',
      revision: 'rev-1',
      size: 15,
    }),
  })

  await page.route('**/api/files/write', async (route) => {
    await route.fulfill({ status: 500, json: { message: 'disk failure' } })
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  const monacoSurface = editorCard.locator('.monaco-editor').first()
  await expect(monacoSurface).toBeVisible()

  await monacoSurface.locator('.view-lines').click()
  await page.keyboard.type('x')

  const retry = editorCard.locator('.text-editor-save-retry')
  await expect(retry).toBeVisible({ timeout: 10_000 })
  await expect(retry).toContainText('Save failed')

  // Once the disk recovers, retry clears the failure state.
  await page.unroute('**/api/files/write')
  await page.route('**/api/files/write', async (route) => {
    await route.fulfill({ json: { revision: 'rev-2' } })
  })

  await retry.click()
  await expect(retry).toBeHidden({ timeout: 10_000 })
})

test('the conflict banner opens a side-by-side diff of disk vs local edits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })

  let diskContent = 'const original = 1\n'
  let diskRevision = 'rev-1'

  await installEditorApis(page, 'dark', {
    read: () => ({
      content: diskContent,
      language: 'typescript',
      revision: diskRevision,
      size: diskContent.length,
    }),
    write: () => ({ conflict: true }),
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  const monacoSurface = editorCard.locator('.text-editor-surface .monaco-editor').first()
  await expect(monacoSurface).toBeVisible()

  diskContent = 'const external = 2\n'
  diskRevision = 'rev-2'

  await monacoSurface.locator('.view-lines').click()
  await page.keyboard.type('local ')

  const conflictBanner = editorCard.locator('.text-editor-conflict')
  await expect(conflictBanner).toBeVisible({ timeout: 10_000 })

  await conflictBanner.getByRole('button', { name: 'View diff' }).click()

  const diffSurface = editorCard.locator('.text-editor-diff-surface')
  await expect(diffSurface).toBeVisible()
  await expect(diffSurface.locator('.monaco-diff-editor').first()).toBeVisible()
  await expect(editorCard.locator('.text-editor-surface.is-hidden')).toHaveCount(1)

  await editorCard.getByRole('button', { name: 'Exit diff' }).click()
  await expect(diffSurface).toBeHidden()
  await expect(editorCard.locator('.text-editor-surface.is-hidden')).toHaveCount(0)
})

test('tracked files render git gutter markers for changed lines', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installEditorApis(page, 'dark', {
    read: () => ({
      content: 'line1\nline2 changed\nline3\nline4\nline5\n',
      language: 'plaintext',
      revision: 'rev-1',
      size: 36,
    }),
  })

  await page.route('**/api/git/file-line-diff', async (route) => {
    await route.fulfill({
      json: {
        isRepository: true,
        tracked: true,
        added: [{ start: 5, end: 5 }],
        modified: [{ start: 2, end: 2 }],
        removed: [3],
      },
    })
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  await expect(editorCard.locator('.monaco-editor').first()).toBeVisible()

  // Decorations land after the 1s debounce + fetch round trip.
  await expect(editorCard.locator('.text-editor-gutter-modified')).toHaveCount(1, {
    timeout: 10_000,
  })
  await expect(editorCard.locator('.text-editor-gutter-added')).toHaveCount(1)
  await expect(editorCard.locator('.text-editor-gutter-removed')).toHaveCount(1)

  // A tracked file also unlocks the HEAD comparison entry point.
  await expect(editorCard.getByRole('button', { name: 'Compare with HEAD' })).toBeVisible()
})

test('tab switches keep unsaved edits, undo history, and cursor state', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await installEditorApis(page, 'dark', {
    read: () => ({
      content: 'const base = 1\n',
      language: 'typescript',
      revision: 'rev-1',
      size: 15,
    }),
    // Reject saves quietly so the buffer stays dirty across the tab switch —
    // the cached-model path must carry unsaved edits, not the disk.
    write: () => ({ conflict: true }),
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  const monacoSurface = editorCard.locator('.monaco-editor').first()
  await expect(monacoSurface).toBeVisible()

  await monacoSurface.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('const extra = 2')
  await expect(monacoSurface).toContainText('const extra = 2')

  // Switch to the sibling tab — inactive pane tabs unmount the editor body.
  await page.locator('.pane-tab', { hasText: 'Note' }).click()
  await expect(monacoSurface).toBeHidden()

  await page.locator('.pane-tab', { hasText: 'Editor' }).click()
  const remounted = page.locator('.text-editor-card .monaco-editor').first()
  await expect(remounted).toBeVisible()

  // Unsaved edits survive the unmount through the model cache.
  await expect(remounted).toContainText('const extra = 2')

  // The undo stack survives too: one undo removes the typed line.
  await remounted.locator('.view-lines').click()
  await page.keyboard.press('Control+z')
  await expect
    .poll(async () => remounted.locator('.view-lines').innerText())
    .not.toContain('const extra = 2')
})

test('status bar tracks cursor position and toggles line endings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })

  let lastWrittenContent: string | null = null

  await installEditorApis(page, 'dark', {
    read: () => ({
      content: 'line one\nline two\n',
      language: 'plaintext',
      revision: 'rev-1',
      size: 18,
    }),
  })

  await page.route('**/api/files/write', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { content?: string }
    lastWrittenContent = body.content ?? null
    await route.fulfill({ json: { revision: 'rev-2' } })
  })

  await page.goto(appUrl)

  const editorCard = page.locator('.text-editor-card').first()
  await expect(editorCard.locator('.monaco-editor').first()).toBeVisible()

  const statusbar = editorCard.locator('.text-editor-statusbar')
  await expect(statusbar).toBeVisible()
  await expect(statusbar.locator('.text-editor-statusbar-button')).toHaveText('LF')

  await statusbar.locator('.text-editor-statusbar-button').click()
  await expect(statusbar.locator('.text-editor-statusbar-button')).toHaveText('CRLF')

  // The EOL rewrite marks the buffer dirty and flows through autosave.
  await expect.poll(() => lastWrittenContent, { timeout: 10_000 }).toContain('\r\n')
})
