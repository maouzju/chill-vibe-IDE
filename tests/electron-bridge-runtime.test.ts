import assert from 'node:assert/strict'
import test from 'node:test'

import { _electron as electron } from '@playwright/test'

test('Electron runtime injects the desktop bridge into the renderer window', async () => {
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      VITE_DEV_SERVER_URL: 'http://localhost:5173',
      CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  delete env.ELECTRON_RUN_AS_NODE

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
