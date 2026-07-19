import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState } from '../shared/default-state.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

const sidecarFileName = (entryId: string) => `${Buffer.from(entryId, 'utf8').toString('base64url')}.json`

const createCatalogFixture = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-history-catalog-'))
  tempRoots.push(dataDir)
  const sidecarDir = path.join(dataDir, 'session-history')
  await mkdir(sidecarDir, { recursive: true })

  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'
  state.settings.providerProfiles.codex = {
    activeProfileId: 'runtime-test-profile',
    profiles: [{
      id: 'runtime-test-profile',
      name: 'Runtime test',
      apiKey: '',
      baseUrl: '',
    }],
  }
  state.sessionHistory = []
  state.updatedAt = new Date().toISOString()
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  for (let index = 1; index <= 180; index += 1) {
    const id = `orphan-catalog-${String(index).padStart(3, '0')}`
    const entry = {
      id,
      title: `Orphan archive ${index}`,
      sessionId: `orphan-session-${index}`,
      provider: 'codex',
      model: 'gpt-5.6-sol',
      workspacePath,
      messageCount: 1,
      messages: [{
        id: `message-${index}`,
        role: 'user',
        content: `Archived body ${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 1, 0, index % 60)).toISOString(),
      }],
      archivedAt: new Date(Date.UTC(2026, 6, 1, 0, index % 60, index)).toISOString(),
    }
    await writeFile(
      path.join(sidecarDir, sidecarFileName(id)),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    )
  }

  await writeFile(path.join(sidecarDir, 'malformed.json'), '{ invalid catalog fixture', 'utf8')
  await writeFile(path.join(sidecarDir, 'oversized.json'), 'x'.repeat(4 * 1024 * 1024 + 1), 'utf8')
  return dataDir
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('Electron safely rebuilds orphaned history in bounded slices without freezing the active composer', async () => {
  await ensureElectronRuntimeBuild()
  const workspacePath = process.cwd()
  const dataDir = await createCatalogFixture(workspacePath)
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
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const textarea = page.locator('.pane-tab-panel.is-active .composer textarea').first()
    await textarea.waitFor({ timeout: 20_000 })
    await textarea.fill('composer remains responsive')

    await page.getByRole('button', { name: 'Session history' }).first().click()
    const historyMenu = page.locator('.session-history-menu')
    await historyMenu.waitFor({ timeout: 10_000 })
    await historyMenu.locator('.session-history-item').first().waitFor({ timeout: 20_000 })
    assert.match(await historyMenu.innerText(), /Orphan archive \d+/)
    assert.equal(await textarea.inputValue(), 'composer remains responsive')

    const maintenance = await page.evaluate(async (workspace) => {
      const api = (window as unknown as {
        electronAPI?: {
          listInternalSessionHistory?: (request: { workspacePath: string; query: string }) => Promise<{
            total: number
            maintenance: { phase: string; processed: number; skipped: number; total?: number }
          }>
        }
      }).electronAPI
      if (!api?.listInternalSessionHistory) throw new Error('history maintenance bridge missing')

      let response = await api.listInternalSessionHistory({ workspacePath: workspace, query: '' })
      const deadline = Date.now() + 20_000
      while (response.maintenance.phase === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        response = await api.listInternalSessionHistory({ workspacePath: workspace, query: '' })
      }
      return response
    }, workspacePath)

    assert.equal(maintenance.total, 180)
    assert.equal(maintenance.maintenance.phase, 'degraded')
    assert.equal(maintenance.maintenance.processed, 182)
    assert.equal(maintenance.maintenance.skipped, 2)
    assert.deepEqual(pageErrors, [])
  } finally {
    await app.close()
  }
})
