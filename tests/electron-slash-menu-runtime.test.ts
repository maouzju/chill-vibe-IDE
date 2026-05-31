import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState, createPane, createSplit } from '../shared/default-state.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

const createTempStateDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-slash-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'

  const baseCard = Object.values(state.columns[0]!.cards)[0]!
  const cards = [
    {
      ...baseCard,
      id: 'card-top',
      title: 'Reference Pane',
      provider: 'codex' as const,
      model: 'gpt-5.4',
      reasoningEffort: 'medium' as const,
      draft: 'Keep this pane mounted above the slash menu.',
      messages: [],
      status: 'idle' as const,
    },
    {
      ...baseCard,
      id: 'card-bottom',
      title: 'Slash Picker Owner',
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
      id: 'col-slash',
      title: 'Slash Runtime',
      provider: 'codex',
      workspacePath,
      model: 'gpt-5.4',
      width: 380,
      layout: createSplit(
        'vertical',
        [
          createPane(['card-top'], 'card-top', 'pane-top'),
          createPane(['card-bottom'], 'card-bottom', 'pane-bottom'),
        ],
        [0.72, 0.28],
        'split-root',
      ),
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

test('Electron runtime keeps the slash menu inside its pane without renderer errors', async () => {
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

    await page.waitForSelector('.pane-view', { timeout: 20000 })

    const paneViews = page.locator('.pane-view')
    const topPane = paneViews.nth(0)
    const bottomPane = paneViews.nth(1)
    const bottomPaneContent = bottomPane.locator('.pane-content')
    const textarea = bottomPane.locator('.composer textarea').first()
    const slashMenu = page.locator('.slash-command-menu').first()

    await textarea.waitFor({ timeout: 20000 })
    await textarea.fill('/')
    await slashMenu.waitFor({ state: 'visible', timeout: 20000 })

    const [menuBox, paneContentBox] = await Promise.all([
      slashMenu.boundingBox(),
      bottomPaneContent.boundingBox(),
    ])
    assert.ok(menuBox, 'Expected slash menu geometry to be measurable in Electron runtime')
    assert.ok(paneContentBox, 'Expected pane geometry to be measurable in Electron runtime')
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

    await topPane.click({ position: { x: 24, y: 24 } })
    await slashMenu.waitFor({ state: 'hidden', timeout: 20000 })

    assert.deepEqual(pageErrors, [])
  } finally {
    await app.close()
  }
})
