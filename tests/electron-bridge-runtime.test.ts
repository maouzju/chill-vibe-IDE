import assert from 'node:assert/strict'
import test from 'node:test'

import { _electron as electron } from '@playwright/test'
import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

test('Electron runtime injects the desktop bridge into the renderer window', async () => {
  await ensureElectronRuntimeBuild()

  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })

  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return typeof window.electronAPI !== 'undefined' && (root?.childElementCount ?? 0) > 0
    }, undefined, {
      timeout: 30000,
    })

    const runtime = await page.evaluate(() => ({
      hasElectronApi: typeof window.electronAPI !== 'undefined',
      keys: typeof window.electronAPI !== 'undefined' ? Object.keys(window.electronAPI) : [],
      appShellPresent: Boolean(document.querySelector('.app-shell')),
      rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
    }))

    assert.equal(runtime.hasElectronApi, true)
    assert.ok(runtime.rootChildCount > 0)
    assert.ok(runtime.keys.includes('fetchState'))
    assert.ok(runtime.keys.includes('getAttachmentUrl'))
  } finally {
    await app.close()
  }
})

test('Electron runtime can close after renderer startup without main-process shutdown errors', async () => {
  await ensureElectronRuntimeBuild()

  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })

  const mainErrors: string[] = []
  app.process().stderr?.on('data', (chunk: Buffer) => {
    mainErrors.push(chunk.toString())
  })

  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => {
      const root = document.getElementById('root')
      return typeof window.electronAPI !== 'undefined' && (root?.childElementCount ?? 0) > 0
    }, undefined, {
      timeout: 30000,
    })
  } finally {
    await app.close()
  }

  assert.equal(
    mainErrors.some((message) => message.includes('Object has been destroyed')),
    false,
    mainErrors.join(''),
  )
})
