import fs from 'fs'
import { writeFile } from 'node:fs/promises'
import path from 'path'
import { app, BrowserWindow, net, shell } from 'electron'

import {
  GITHUB_API_URL,
  CHECK_TIMEOUT_MS,
  buildWindowsZipReplaceScript,
  encodePowerShellScriptUtf8Bom,
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
  const spawnStdoutPath = path.join(jobRoot, 'powershell-stdout.log')
  const spawnStderrPath = path.join(jobRoot, 'powershell-stderr.log')

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

  // Redirect stdio to files instead of ignoring, so PowerShell spawn errors
  // are diagnosable after the parent process exits.
  const stdoutFd = fs.openSync(spawnStdoutPath, 'a')
  const stderrFd = fs.openSync(spawnStderrPath, 'a')

  try {
    await launchDetachedPowerShellScriptFile({
      scriptPath,
      stdoutFd,
      stderrFd,
    })
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    fs.appendFileSync(spawnStderrPath, `[launcher] Failed to spawn update PowerShell job: ${message}\n`)
    throw error
  } finally {
    fs.closeSync(stdoutFd)
    fs.closeSync(stderrFd)
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

export async function downloadUpdate(
  assetUrl: string,
  onProgress: (percent: number) => void,
): Promise<string> {
  const fileName = path.basename(new URL(assetUrl).pathname)
  const destPath = path.join(app.getPath('temp'), fileName)

  const response = await net.fetch(assetUrl, {
    headers: { 'User-Agent': 'chill-vibe-ide' },
  })

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('Download failed: no response body')
  }

  const writeStream = fs.createWriteStream(destPath)
  let received = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      writeStream.write(Buffer.from(value))
      received += value.byteLength

      if (contentLength > 0) {
        onProgress(Math.round((received / contentLength) * 100))
      }
    }
  } finally {
    writeStream.end()
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })
  }

  return destPath
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
  const strategy = resolveDownloadedAssetStrategy(process.platform, assetPath)

  if (strategy === 'replace-app-folder') {
    await launchWindowsZipUpdateJob(assetPath)
    forceExitForUpdate()
    return
  }

  await openDownloadedAsset(assetPath)
  forceExitForUpdate()
}
