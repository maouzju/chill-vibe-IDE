import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { _electron as electron } from '@playwright/test'

import {
  ensureElectronRuntimeBuild,
  getElectronTestRendererUrl,
} from './ensure-electron-runtime-build.ts'
import { createHeadlessElectronRuntimeEnv } from './electron-test-env.ts'

const waitForRendererPidChange = async (
  app: Awaited<ReturnType<typeof electron.launch>>,
  previousPid: number,
) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const pid = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0,
    ).catch(() => 0)
    if (pid > 0 && pid !== previousPid) {
      return pid
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`renderer PID stayed at ${previousPid}`)
}

const waitForRecoveredUi = async (
  app: Awaited<ReturnType<typeof electron.launch>>,
) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const ready = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.webContents.isDestroyed() || win.webContents.isCrashed()) {
        return false
      }
      return await win.webContents.executeJavaScript(`
        typeof window.electronAPI !== 'undefined' &&
        (document.getElementById('root')?.childElementCount ?? 0) > 0
      `).catch(() => false)
    }).catch(() => false)
    if (ready) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('restarted renderer did not restore the UI')
}

// Crashpad finalises a minidump asynchronously after the process dies, so the
// log line naming it arrives a beat after the renderer has already restarted.
const waitForLogMatch = async (logPath: string, pattern: RegExp) => {
  const deadline = Date.now() + 20_000
  let contents = ''
  while (Date.now() < deadline) {
    contents = await readFile(logPath, 'utf8').catch(() => '')
    if (pattern.test(contents)) {
      return contents
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return contents
}

test('persistent unresponsive recovery replaces the stuck renderer process and reloads the UI', async () => {
  await ensureElectronRuntimeBuild()

  const dataDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-unresponsive-recovery-'))
  const runtimeProfileRoot = path.join(dataDir, 'runtime-profile')
  const env = createHeadlessElectronRuntimeEnv({
    VITE_DEV_SERVER_URL: getElectronTestRendererUrl(),
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
    CHILL_VIBE_DATA_DIR: dataDir,
    CHILL_VIBE_RUNTIME_PROFILE_ROOT: runtimeProfileRoot,
    CHILL_VIBE_UNRESPONSIVE_RECOVERY_MS: '50',
  })

  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env,
  })

  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0)

    const previousPid = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0,
    )
    assert.ok(previousPid > 0)

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.emit('unresponsive')
    })

    const nextPid = await waitForRendererPidChange(app, previousPid)
    assert.notEqual(nextPid, previousPid)

    await waitForRecoveredUi(app)

    const mainLog = await readFile(path.join(dataDir, 'logs', 'main.log'), 'utf8')
    assert.match(mainLog, /terminating stuck renderer/)
    assert.match(mainLog, /Renderer process gone/)
    assert.match(mainLog, /Restarting renderer after forced unresponsive recovery/)
    assert.match(mainLog, new RegExp(`previousRendererProcessId: ${previousPid}`))
    assert.match(mainLog, new RegExp(`rendererProcessId: ${nextPid}`))

    // Every freeze investigation so far has died at "the JS call stack was
    // empty". The forced crash must leave a real minidump behind, because that
    // is the only artifact carrying the native stack of the blocked thread.
    assert.match(mainLog, /Crash dump collection enabled/)
    const recoveryLog = await waitForLogMatch(
      path.join(dataDir, 'logs', 'main.log'),
      /Native hang minidump captured/,
    )
    assert.match(recoveryLog, /Native hang minidump captured/)

    const dumps = await readdir(path.join(dataDir, 'crash-dumps', 'reports')).catch(() => [])
    assert.ok(
      dumps.some((entry) => entry.endsWith('.dmp')),
      `expected a .dmp minidump on disk, saw ${JSON.stringify(dumps)}`,
    )
  } finally {
    await app.close().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true })
  }
})
