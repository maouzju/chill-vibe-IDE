import { spawn } from 'node:child_process'
import fs from 'fs'
import { writeFile } from 'node:fs/promises'
import path from 'path'
import { app, net, shell } from 'electron'

import {
  GITHUB_API_URL,
  CHECK_TIMEOUT_MS,
  parseReleaseResponse,
  resolveDownloadedAssetStrategy,
  type UpdateCheckResult,
  type GitHubRelease,
} from './updater-core.js'

export type { UpdateCheckResult } from './updater-core.js'
export {
  parseVersionTag,
  isNewerVersion,
  selectPlatformAsset,
  parseReleaseResponse,
  classifyDownloadedAsset,
  resolveDownloadedAssetStrategy,
} from './updater-core.js'

const escapePowerShellString = (value: string) => value.replace(/'/g, "''")

const createWindowsZipReplaceScript = ({
  processId,
  assetPath,
  targetDir,
  executablePath,
  stagingDir,
}: {
  processId: number
  assetPath: string
  targetDir: string
  executablePath: string
  stagingDir: string
}) => {
  const pidLiteral = `${processId}`
  const assetLiteral = escapePowerShellString(assetPath)
  const targetLiteral = escapePowerShellString(targetDir)
  const executableLiteral = escapePowerShellString(executablePath)
  const stagingLiteral = escapePowerShellString(stagingDir)

  return `
$ErrorActionPreference = 'Stop'

$pidToWait = ${pidLiteral}
$assetPath = '${assetLiteral}'
$targetDir = '${targetLiteral}'
$executablePath = '${executableLiteral}'
$stagingDir = '${stagingLiteral}'

function Wait-ForProcessExit {
  param([int]$ProcessId)

  while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 500
  }
}

function Find-AppRoot {
  param(
    [string]$Root,
    [string]$ExeName
  )

  $match = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $ExeName |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources') } |
    Select-Object -First 1

  if ($match) {
    return $match.DirectoryName
  }

  $fallback = Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $ExeName | Select-Object -First 1
  if ($fallback) {
    return $fallback.DirectoryName
  }

  return $null
}

Wait-ForProcessExit -ProcessId $pidToWait

if (Test-Path -LiteralPath $stagingDir) {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force
}

New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
Expand-Archive -LiteralPath $assetPath -DestinationPath $stagingDir -Force

$sourceRoot = Find-AppRoot -Root $stagingDir -ExeName ([System.IO.Path]::GetFileName($executablePath))
if (-not $sourceRoot) {
  throw "Unable to find the extracted app root in $stagingDir."
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Get-ChildItem -LiteralPath $targetDir -Force | Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $targetDir -Recurse -Force
}

Start-Sleep -Milliseconds 250
Start-Process -FilePath $executablePath -WorkingDirectory $targetDir | Out-Null
`
}

const launchWindowsZipUpdateJob = async (assetPath: string) => {
  if (!app.isPackaged) {
    throw new Error('Automatic zip updates are only supported in packaged builds.')
  }

  const targetDir = path.dirname(process.execPath)
  const executablePath = process.execPath
  const jobRoot = path.join(app.getPath('temp'), `chill-vibe-update-${Date.now()}`)
  const stagingDir = path.join(jobRoot, 'extract')
  const scriptPath = path.join(jobRoot, 'apply-update.ps1')

  await fs.promises.mkdir(jobRoot, { recursive: true })
  await writeFile(
    scriptPath,
    createWindowsZipReplaceScript({
      processId: process.pid,
      assetPath,
      targetDir,
      executablePath,
      stagingDir,
    }),
    'utf8',
  )

  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  )

  child.unref()
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

export async function installUpdate(assetPath: string): Promise<void> {
  const strategy = resolveDownloadedAssetStrategy(process.platform, assetPath)

  if (strategy === 'replace-app-folder') {
    await launchWindowsZipUpdateJob(assetPath)
    setTimeout(() => app.quit(), 1000)
    return
  }

  await openDownloadedAsset(assetPath)
  setTimeout(() => app.quit(), 1000)
}
