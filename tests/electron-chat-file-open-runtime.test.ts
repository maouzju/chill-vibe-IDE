import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState, createPane } from '../shared/default-state.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

const SAMPLE_LINES = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1}`)

// The browser-mode spec (tests/chat-file-reference-open.spec.ts) proves the click
// routing against a mocked desktop bridge. This one proves the same flow end to
// end in a real Electron runtime, where opening the file goes through the actual
// IPC + file-system path instead of a route handler.
test('Electron runtime: clicking a file path in chat opens the real file at that line', async () => {
  await ensureElectronRuntimeBuild()

  const workspacePath = await mkdtemp(path.join(tmpdir(), 'chill-vibe-fileopen-ws-'))
  tempRoots.push(workspacePath)
  await mkdir(path.join(workspacePath, 'src'), { recursive: true })
  await writeFile(path.join(workspacePath, 'src', 'sample.ts'), `${SAMPLE_LINES.join('\n')}\n`, 'utf8')

  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-fileopen-state-'))
  tempRoots.push(dataDir)

  const state = createDefaultState(workspacePath, 'zh-CN')
  state.settings.language = 'zh-CN'
  state.settings.theme = 'dark'

  const baseCard = Object.values(state.columns[0]!.cards)[0]!
  const chatCard = {
    ...baseCard,
    id: 'card-chat',
    title: 'Chat',
    status: 'idle' as const,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: '真正的耗时在 `src/sample.ts:12` 里，另见 `writeFileSync` 的调用。',
        createdAt: new Date().toISOString(),
      },
    ],
  }
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-chat',
      title: 'File Open Probe',
      workspacePath,
      width: 1000,
      layout: createPane(['card-chat'], 'card-chat', 'pane-chat'),
      cards: { 'card-chat': chatCard },
    },
  ]
  state.updatedAt = new Date().toISOString()

  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

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

    const reference = page.locator('.message-file-reference button')
    await reference.waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(
      await reference.getAttribute('data-open-file-path'),
      'src/sample.ts',
      'the inline path should resolve to a workspace-relative target',
    )
    assert.equal(await reference.getAttribute('data-open-file-line'), '12')

    // `writeFileSync` sits in the same sentence and must stay plain code.
    assert.equal(await page.locator('.message-file-reference button').count(), 1)

    await reference.click()

    await page.waitForSelector('.text-editor-card .monaco-editor .view-lines', { timeout: 30000 })
    await page.waitForTimeout(1500)

    const probe = await page.evaluate(() => {
      const card = document.querySelector('.text-editor-card')
      const status = card?.querySelector('.text-editor-statusbar-item')
      const firstVisibleLineNumber = card?.querySelector('.margin-view-overlays .line-numbers')
      return {
        cursor: status?.textContent?.trim() ?? '',
        body: card?.textContent ?? '',
        firstVisibleLine: firstVisibleLineNumber?.textContent?.trim() ?? '',
      }
    })

    console.log('[electron-file-open-probe]', JSON.stringify(probe))
    assert.equal(probe.cursor, '12:1', 'the editor should land on the clicked line')
    assert.ok(
      !probe.body.includes('ENOENT') && !probe.body.includes('没有这个文件'),
      `the real file should load, got: ${probe.body.slice(0, 200)}`,
    )
    // Monaco renders inter-token spaces as U+00A0, so match on space-free
    // fragments — `const line12` with a plain space never matches the DOM text.
    assert.ok(
      probe.body.includes('line12') && probe.body.includes('line40'),
      `the real file contents should be rendered, got: ${probe.body.slice(0, 200)}`,
    )
  } finally {
    await app.close()
  }
})
