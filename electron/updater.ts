import fs from 'fs'
import { writeFile } from 'node:fs/promises'
import path from 'path'
import { app, BrowserWindow, net, shell } from 'electron'

import {
  GITHUB_API_URL,
  CHECK_TIMEOUT_MS,
  buildWindowsZipReplaceScript,
  encodePowerShellScriptUtf8Bom,
  downloadWithResume,
  parseReleaseResponse,
  resolveDownloadedAssetStrategy,
  type UpdateCheckResult,
  type GitHubRelease,
} from './updater-core.js'
import { launchDetachedPowerShellScriptFile } from './updater-launch.js'

export type { UpdateCheckResult } from './updater-core.js'
export {
  parseVersionTag,
  isNewerVersion,
  selectPlatformAsset,
  parseReleaseResponse,
  classifyDownloadedAsset,
  resolveDownloadedAssetStrategy,
  buildWindowsZipReplaceScript,
  encodePowerShellScriptUtf8Bom,
} from './updater-core.js'

const UPDATE_WAIT_TIMEOUT_SECONDS = 30

const launchWindowsZipUpdateJob = async (assetPath: string) => {
  if (!app.isPackaged) {
    throw new Error('Automatic zip updates are only supported in packaged builds.')
  }

  const targetDir = path.dirname(process.execPath)
  const executablePath = process.execPath
  const jobRoot = path.join(app.getPath('temp'), `chill-vibe-update-${Date.now()}`)
  const stagingDir = path.join(jobRoot, 'extract')
  const scriptPath = path.join(jobRoot, 'apply-update.ps1')
  const logPath = path.join(jobRoot, 'apply-update.log')
  const spawnErrorPath = path.join(jobRoot, 'launcher-error.log')

  await fs.promises.mkdir(jobRoot, { recursive: true })
  await writeFile(logPath, '')
  await writeFile(
    scriptPath,
    encodePowerShellScriptUtf8Bom(
      buildWindowsZipReplaceScript({
        processId: process.pid,
        assetPath,
        targetDir,
        executablePath,
        stagingDir,
        logPath,
        waitTimeoutSeconds: UPDATE_WAIT_TIMEOUT_SECONDS,
      }),
    ),
  )

  // stdio is 'ignore' inside the launcher — we rely on the PowerShell script's
  // own Write-Log calls into apply-update.log for diagnostics. Any failure to
  // even spawn PS is surfaced as an exception we log to launcher-error.log.
  try {
    await launchDetachedPowerShellScriptFile({ scriptPath })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    fs.appendFileSync(spawnErrorPath, `[launcher] Failed to spawn update PowerShell job: ${message}\n`)
    throw error
  }
}

const openDownloadedAsset = async (assetPath: string) => {
  const openError = await shell.openPath(assetPath)

  if (openError) {
    throw new Error(openError)
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()

  try {
    const response = await net.fetch(GITHUB_API_URL, {
      headers: { 'User-Agent': 'chill-vibe-ide', Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })

    if (!response.ok) {
      return { hasUpdate: false, currentVersion, error: `GitHub API responded with ${response.status}` }
    }

    const release = (await response.json()) as GitHubRelease
    return parseReleaseResponse(release, currentVersion, process.platform)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { hasUpdate: false, currentVersion, error: message }
  }
}

// One in-flight download per asset URL. Re-checking for updates while a download is
// still running used to start a second stream writing the same temp path, which could
// interleave two payloads into one corrupt archive.
//
// 症状: 更新卡住后，重开设置页、再点「检查更新」都毫无反应 —— 进度条停在同一个数字。
// 根因: 去重表存的是裸 promise，而下载当时没有超时，所以一个挂死的 promise 会被无限期
//       复用；后来的调用者拿到的是同一个永不 settle 的对象，连自己的 onProgress 都没接上。
// 被否决的替代: 「点检查更新就丢弃旧下载」—— 那会让每次点击都从 0 重下 160MB。
//       正确做法是让下载本身一定会 settle（见 downloadWithResume 的停滞检测），
//       去重表只负责把进度广播给所有订阅者。
type InFlightDownload = {
  promise: Promise<string>
  listeners: Set<(percent: number) => void>
}

const inFlightDownloads = new Map<string, InFlightDownload>()

const iterateResponseBody = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader()

  return (async function* () {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        return
      }

      if (value) {
        yield value
      }
    }
  })()
}

const runDownload = async (assetUrl: string, onProgress: (percent: number) => void) => {
  const fileName = path.basename(new URL(assetUrl).pathname)
  const destPath = path.join(app.getPath('temp'), fileName)

  return downloadWithResume({
    destPath,
    onProgress,
    fetchRange: async (rangeStart, signal) => {
      const headers: Record<string, string> = { 'User-Agent': 'chill-vibe-ide' }

      if (rangeStart > 0) {
        headers.Range = `bytes=${rangeStart}-`
      }

      const response = await net.fetch(assetUrl, { headers, signal })

      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        body: response.body ? iterateResponseBody(response.body) : null,
      }
    },
  })
}

export async function downloadUpdate(
  assetUrl: string,
  onProgress: (percent: number) => void,
): Promise<string> {
  const existing = inFlightDownloads.get(assetUrl)

  if (existing) {
    existing.listeners.add(onProgress)

    try {
      return await existing.promise
    } finally {
      existing.listeners.delete(onProgress)
    }
  }

  const listeners = new Set<(percent: number) => void>([onProgress])
  const entry: InFlightDownload = {
    listeners,
    promise: runDownload(assetUrl, (percent) => {
      for (const listener of listeners) {
        listener(percent)
      }
    }).finally(() => {
      inFlightDownloads.delete(assetUrl)
    }),
  }

  inFlightDownloads.set(assetUrl, entry)

  return entry.promise
}

// Force-shutdown helper that bypasses the `before-quit` preventDefault guard in
// main.ts — that guard is necessary for normal quit (state flush), but during an
// update the PowerShell job is actively polling our PID and must see us exit.
// We briefly notify the renderer to flush state, then call `app.exit(0)`
// (which does NOT fire `before-quit`/`will-quit`) as a hard fallback.
const FORCE_EXIT_DELAY_MS = 1500

const forceExitForUpdate = () => {
  // Best-effort: let renderers flush before we hard-exit. We intentionally do
  // not await an ACK — the PowerShell job is waiting on our PID and we cannot
  // risk blocking on a renderer that never replies.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('app:flush-state-before-quit')
      }
    }
  } catch {
    // swallow — we are shutting down anyway
  }

  setTimeout(() => {
    try {
      app.exit(0)
    } catch {
      // If exit somehow throws, fall back to process.exit so the PID releases.
      process.exit(0)
    }
  }, FORCE_EXIT_DELAY_MS)
}

export async function installUpdate(assetPath: string): Promise<void> {
  // Fail while the app is still alive and can show the error, rather than exiting
  // and letting the detached job discover the missing package with nobody watching.
  const stats = await fs.promises.stat(assetPath).catch(() => null)

  if (!stats || stats.size <= 0) {
    throw new Error(`Update package is missing or empty: ${assetPath}`)
  }

  const strategy = resolveDownloadedAssetStrategy(process.platform, assetPath)

  if (strategy === 'replace-app-folder') {
    await launchWindowsZipUpdateJob(assetPath)
    forceExitForUpdate()
    return
  }

  await openDownloadedAsset(assetPath)
  forceExitForUpdate()
}
