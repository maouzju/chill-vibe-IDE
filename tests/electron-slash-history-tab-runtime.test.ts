import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState, createPane } from '../shared/default-state.ts'
import type { ChatMessage } from '../shared/schema.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

const createHistoryMessage = (cardId: string, index: number): ChatMessage => ({
  id: `${cardId}-message-${index + 1}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `${cardId} message ${index + 1}: ${'detail '.repeat(64)}`,
  createdAt: new Date(Date.UTC(2026, 3, 12, 1, Math.floor(index / 60), index % 60)).toISOString(),
  meta: index % 2 === 0 ? undefined : { provider: 'codex' },
})

const createTempStateDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-slash-history-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'

  const baseCard = Object.values(state.columns[0]!.cards)[0]!
  const cards = [
    {
      ...baseCard,
      id: 'card-history-1',
      title: 'Very Long History 1',
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: '',
      messages: Array.from({ length: 260 }, (_, index) => createHistoryMessage('card-history-1', index)),
      status: 'idle' as const,
    },
    {
      ...baseCard,
      id: 'card-history-2',
      title: 'Very Long History 2',
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: '',
      messages: Array.from({ length: 340 }, (_, index) => createHistoryMessage('card-history-2', index)),
      status: 'idle' as const,
    },
    {
      ...baseCard,
      id: 'card-fresh',
      title: 'Fresh Chat',
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: '',
      messages: [],
      status: 'idle' as const,
    },
  ]

  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-slash-history',
      title: 'Slash History Runtime',
      provider: 'codex',
      workspacePath,
      model: 'gpt-5.4',
      width: 420,
      layout: createPane(cards.map((card) => card.id), 'card-fresh', 'pane-history'),
      cards: Object.fromEntries(cards.map((card) => [card.id, card])),
    },
  ]
  state.updatedAt = new Date().toISOString()

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  return dataDir
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('Electron runtime keeps slash menu stable after switching long history tabs', async () => {
  await ensureElectronRuntimeBuild()

  const workspacePath = process.cwd()
  const dataDir = await createTempStateDir(workspacePath)
  const pageErrors: string[] = []

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: createHeadlessElectronRuntimeEnv({
      VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
      CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
      CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
      CHILL_VIBE_DATA_DIR: dataDir,
      CHILL_VIBE_DEFAULT_WORKSPACE: workspacePath,
    }),
  })

  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => {
      pageErrors.push(error.message)
    })

    const activeTab = page.locator('.pane-tab.is-active .pane-tab-label')
    const activePanel = page.locator('.pane-tab-panel.is-active')
    const paneContent = page.locator('.pane-content').first()
    const slashMenu = page.locator('.slash-command-menu').first()

    await activeTab.waitFor({ timeout: 20000 })
    await assert.doesNotReject(async () => {
      await activeTab.waitFor({ timeout: 20000 })
    })

    const assertSlashMenuInsidePane = async (title: string) => {
      const textarea = activePanel.locator('.composer textarea').first()
      await textarea.waitFor({ timeout: 20000 })
      await textarea.fill('/')
      await slashMenu.waitFor({ state: 'visible', timeout: 20000 })

      const [menuBox, paneContentBox] = await Promise.all([
        slashMenu.boundingBox(),
        paneContent.boundingBox(),
      ])
      assert.ok(menuBox, `Expected slash menu geometry for ${title}`)
      assert.ok(paneContentBox, `Expected pane geometry for ${title}`)
      assert.ok(menuBox.x >= paneContentBox.x - 1, 'Slash menu should stay inside the pane horizontally')
      assert.ok(menuBox.y >= paneContentBox.y - 1, 'Slash menu should stay inside the pane vertically')
      assert.ok(
        menuBox.x + menuBox.width <= paneContentBox.x + paneContentBox.width + 1,
        'Slash menu should not overflow past the pane width',
      )
      assert.ok(
        menuBox.y + menuBox.height <= paneContentBox.y + paneContentBox.height + 1,
        'Slash menu should not overflow past the pane height',
      )

      const usesBodyLayer = await page.evaluate(() => {
        const menu = document.querySelector('.slash-command-menu')
        return menu?.parentElement === document.body
      })
      assert.equal(usesBodyLayer, true)

      await textarea.press('Escape')
      await slashMenu.waitFor({ state: 'hidden', timeout: 20000 })
    }

    for (const title of ['Very Long History 1', 'Very Long History 2', 'Fresh Chat']) {
      await page.getByRole('button', { name: title, exact: true }).click()
      await activeTab.filter({ hasText: title }).waitFor({ timeout: 15000 })
      await page.waitForTimeout(120)
      await assertSlashMenuInsidePane(title)
    }

    assert.deepEqual(pageErrors, [])
  } finally {
    await app.close()
  }
})
