import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { _electron as electron } from '@playwright/test'

import { createDefaultState } from '../shared/default-state.ts'
import type { ChatMessage } from '../shared/schema.ts'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const tempRoots: string[] = []

const bigLegacyEntryId = 'big-legacy-history-entry'
const totalArchivedMessages = 3000

// ~20MB legacy sidecar: a transcript archived by an older build with giant
// uncompacted command outputs. Opening it used to freeze/crash the renderer.
const createLegacySidecarEntry = (workspacePath: string) => {
  const giantOutput = 'x'.repeat(1_000_000)
  const messages: ChatMessage[] = Array.from({ length: totalArchivedMessages }, (_, index) => ({
    id: `legacy-message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Legacy archived message ${index + 1}: ${'detail '.repeat(16)}`,
    createdAt: new Date(Date.UTC(2026, 4, 1, 0, Math.floor(index / 60), index % 60)).toISOString(),
    ...(index % 150 === 0
      ? {
          meta: {
            provider: 'codex' as const,
            kind: 'command' as const,
            structuredData: JSON.stringify({
              kind: 'command',
              status: 'completed',
              command: `node legacy-step-${index}.js`,
              output: giantOutput,
              exitCode: 0,
            }),
          },
        }
      : {}),
  }))

  return {
    id: bigLegacyEntryId,
    title: 'Big legacy archived session',
    sessionId: 'big-legacy-session-1',
    provider: 'codex' as const,
    model: 'gpt-5.5',
    workspacePath,
    messageCount: totalArchivedMessages,
    messages,
    archivedAt: new Date('2026-05-01T08:00:00.000Z').toISOString(),
  }
}

const createTempStateDir = async (workspacePath: string) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-electron-history-restore-'))
  tempRoots.push(dataDir)

  const fullEntry = createLegacySidecarEntry(workspacePath)

  const state = createDefaultState(workspacePath, 'en')
  state.settings.language = 'en'
  state.settings.theme = 'dark'
  state.sessionHistory = [
    {
      ...fullEntry,
      messagesPreview: true,
      messages: fullEntry.messages.slice(0, 4).map((message) => ({ ...message, meta: undefined })),
    },
  ]
  state.updatedAt = new Date().toISOString()

  await mkdir(path.join(dataDir, 'session-history'), { recursive: true })
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(dataDir, 'session-history', `${bigLegacyEntryId}.json`),
    `${JSON.stringify(fullEntry)}\n`,
    'utf8',
  )

  return dataDir
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

test('Electron runtime loads a giant legacy archived session as a bounded payload without crashing the renderer', async () => {
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

    await page.locator('.pane-tab.is-active').first().waitFor({ timeout: 20000 })

    const loadResult = await page.evaluate(async (entryId) => {
      const api = (window as unknown as {
        electronAPI?: {
          loadSessionHistoryEntry?: (request: { entryId: string }) => Promise<{
            entry: { messages: unknown[]; messageCount?: number }
          }>
        }
      }).electronAPI
      if (!api?.loadSessionHistoryEntry) {
        throw new Error('electronAPI.loadSessionHistoryEntry is not exposed')
      }

      const startedAt = performance.now()
      const response = await api.loadSessionHistoryEntry({ entryId })
      const elapsedMs = performance.now() - startedAt

      return {
        elapsedMs,
        messageCount: response.entry.messageCount ?? null,
        returnedMessages: response.entry.messages.length,
        payloadBytes: JSON.stringify(response).length,
      }
    }, bigLegacyEntryId)

    assert.equal(
      loadResult.returnedMessages,
      500,
      'the restore payload must arrive capped like live cards instead of shipping the full 3000-message archive',
    )
    assert.equal(loadResult.messageCount, totalArchivedMessages)
    assert.ok(
      loadResult.payloadBytes < 2_000_000,
      `restore payload should stay bounded, got ${loadResult.payloadBytes} bytes`,
    )
    assert.ok(
      loadResult.elapsedMs < 15_000,
      `restore load should not stall the renderer, took ${Math.round(loadResult.elapsedMs)}ms`,
    )

    // The renderer must still be interactive after the load.
    const textarea = page.locator('.pane-tab-panel.is-active .composer textarea').first()
    await textarea.waitFor({ timeout: 20000 })
    await textarea.fill('still responsive')
    assert.equal(await textarea.inputValue(), 'still responsive')

    assert.deepEqual(pageErrors, [])
  } finally {
    await app.close()
  }
})
