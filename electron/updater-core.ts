// Pure updater logic — no Electron dependencies so this module is importable from tests.

import { open, rename, rm, stat } from 'node:fs/promises'

export type UpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  assetUrl?: string
  releaseNotes?: string
  htmlUrl?: string
  error?: string
}

export type GitHubAsset = {
  name: string
  browser_download_url: string
}

export type GitHubRelease = {
  tag_name: string
  body?: string
  html_url?: string
  assets: GitHubAsset[]
}

export type DownloadedAssetKind = 'zip' | 'installer' | 'disk-image' | 'unknown'
export type DownloadedAssetStrategy = 'replace-app-folder' | 'shell-open'

export const GITHUB_REPO = 'maouzju/chill-vibe-IDE'
export const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
export const CHECK_TIMEOUT_MS = 15_000

export function parseVersionTag(tag: string): string | null {
  const stripped = tag.startsWith('v') ? tag.slice(1) : tag
  return /^\d+\.\d+\.\d+$/.test(stripped) ? stripped : null
}

export function isNewerVersion(latest: string, current: string): boolean {
  const [a1, a2, a3] = latest.split('.').map(Number)
  const [b1, b2, b3] = current.split('.').map(Number)
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  return a3 > b3
}

export function classifyDownloadedAsset(assetPath: string): DownloadedAssetKind {
  const normalized = assetPath.trim().toLowerCase()

  if (normalized.endsWith('.zip')) {
    return 'zip'
  }

  if (normalized.endsWith('.exe') || normalized.endsWith('.msi')) {
    return 'installer'
  }

  if (normalized.endsWith('.dmg') || normalized.endsWith('.pkg')) {
    return 'disk-image'
  }

  return 'unknown'
}

export function resolveDownloadedAssetStrategy(
  platform: string,
  assetPath: string,
): DownloadedAssetStrategy {
  const kind = classifyDownloadedAsset(assetPath)

  if (platform === 'win32' && kind === 'zip') {
    return 'replace-app-folder'
  }

  return 'shell-open'
}

export type DownloadResponseLike = {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: AsyncIterable<Uint8Array> | null
}

export type ResumableDownloadParams = {
  destPath: string
  fetchRange: (rangeStart: number, signal: AbortSignal) => Promise<DownloadResponseLike>
  onProgress?: (percent: number) => void
  maxAttempts?: number
  stallTimeoutMs?: number
  retryDelayMs?: (attempt: number) => number
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_DOWNLOAD_MAX_ATTEMPTS = 6
export const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 45_000

const HTTP_PARTIAL_CONTENT = 206
const HTTP_RANGE_NOT_SATISFIABLE = 416
const CONSUMER_UNWIND_TIMEOUT_MS = 2_000

class NonRetryableDownloadError extends Error {}

const defaultRetryDelayMs = (attempt: number) => Math.min(20_000, 1_000 * 2 ** (attempt - 1))
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const statSizeOrZero = async (filePath: string) => {
  const stats = await stat(filePath).catch(() => null)
  return stats?.isFile() ? stats.size : 0
}

// `bytes 6-10/11` -> { start: 6, total: 11 }
const parseContentRange = (value: string | null) => {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((value ?? '').trim())

  if (!match) {
    return null
  }

  return {
    start: Number(match[1]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  }
}

// 症状: 「更新完全更不了」—— 进度条停在 14% 再也不动，不报错、不重试，重开设置页
//       仍是同一个死进度；用户连着多个版本都更不上去。
// 根因 (2026-08-22): 下载走 net.fetch 且没有任何超时。GitHub 的资产实际托管在
//       objects.githubusercontent.com，弱网下 TCP 会静默断掉而不发 FIN —— 此时
//       reader.read() 永远不 resolve，整条 promise 挂死，UI 的 downloading 状态没有
//       任何出口。160MB 的包在这种链路上几乎必然中途断，一次全量重下也救不回来。
// 被否决的替代:
//   - 「只加一个总超时」: 大包在慢网下本来就要几分钟，总超时不是把慢网误杀就是形同虚设；
//     真正的判据是「多久没有新字节进来」。
//   - 「失败就整包重下」: 每次都从 0 开始，弱网下永远追不完 —— 必须用 Range 续传，
//     并把 .part 留到下一次运行继续啃。
export async function downloadWithResume({
  destPath,
  fetchRange,
  onProgress,
  maxAttempts = DEFAULT_DOWNLOAD_MAX_ATTEMPTS,
  stallTimeoutMs = DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  retryDelayMs = defaultRetryDelayMs,
  sleep = defaultSleep,
}: ResumableDownloadParams): Promise<string> {
  const partPath = `${destPath}.part`
  let lastError: unknown = new Error('Update download did not run.')

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const alreadyOnDisk = await statSizeOrZero(partPath)
    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let rejectStalled: ((error: Error) => void) | undefined
    const stalled = new Promise<never>((_resolve, reject) => {
      rejectStalled = reject
    })
    let consumePromise: Promise<void> | null = null

    const armStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
      }

      stallTimer = setTimeout(() => {
        // Reject before aborting so the stall diagnosis wins the race against the
        // generic "aborted" error the abort itself raises inside the body stream.
        rejectStalled?.(
          new Error(`Update download stalled: no data received for ${stallTimeoutMs}ms.`),
        )
        try {
          controller.abort()
        } catch {
          // The socket is already gone; nothing left to cancel.
        }
      }, stallTimeoutMs)
      stallTimer.unref?.()
    }

    try {
      // The watchdog has to cover the connect/response-header phase too, not just the
      // body: on a blocked route the fetch() itself never settles, and a timer that
      // only starts once the body arrives would never fire at all.
      armStallTimer()

      const response = await Promise.race([fetchRange(alreadyOnDisk, controller.signal), stalled])

      if (response.status === HTTP_RANGE_NOT_SATISFIABLE) {
        // Our leftover .part no longer lines up with the asset on the server.
        await rm(partPath, { force: true })
        lastError = new Error('Resume offset rejected by the server; restarting from zero.')
        continue
      }

      if (!response.ok) {
        // 4xx/5xx here means the release asset itself is wrong or gone — retrying
        // the exact same URL cannot fix it, and burning six attempts only delays
        // the error the user needs to see.
        throw new NonRetryableDownloadError(`Download failed: HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('Download failed: no response body')
      }

      const contentRange =
        response.status === HTTP_PARTIAL_CONTENT
          ? parseContentRange(response.headers.get('content-range'))
          : null
      // Only append when the server actually honoured our offset. A proxy that
      // ignores Range replies 200 with the whole file, and appending that would
      // splice two copies together into a corrupt archive.
      const appending =
        contentRange !== null && alreadyOnDisk > 0 && contentRange.start === alreadyOnDisk
      const totalBytes = appending
        ? contentRange.total
        : Number(response.headers.get('content-length') ?? 0)

      let received = appending ? alreadyOnDisk : 0

      // Every chunk is awaited straight into the file handle instead of going through
      // a write stream. A stream buffers, and pipeline() *destroys* that buffer on
      // error — which silently threw away everything downloaded so far and left a
      // 0-byte .part, so the next attempt always restarted from offset 0.
      const consume = async () => {
        const handle = await open(partPath, appending ? 'a' : 'w')

        try {
          armStallTimer()

          for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            armStallTimer()
            await handle.write(chunk)
            received += chunk.byteLength

            if (totalBytes > 0) {
              onProgress?.(Math.min(100, Math.round((received / totalBytes) * 100)))
            }
          }
        } finally {
          await handle.close()
        }
      }

      consumePromise = consume()
      await Promise.race([consumePromise, stalled])

      if (totalBytes > 0 && received !== totalBytes) {
        throw new Error(
          `Update download is incomplete: received ${received} of ${totalBytes} bytes.`,
        )
      }

      // Publish under the real name only after the payload is proven whole.
      await rm(destPath, { force: true })
      await rename(partPath, destPath)

      return destPath
    } catch (error) {
      if (error instanceof NonRetryableDownloadError) {
        throw error
      }

      lastError = error

      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt))
      }
    } finally {
      if (stallTimer) {
        clearTimeout(stallTimer)
      }

      // On a stall we won the race against a reader that is still running. Give it a
      // moment to unwind and close its file handle so the next attempt sees the real
      // byte count on disk — but never block the retry loop on a reader that ignores
      // the abort, which is the exact failure mode we are here to escape.
      if (consumePromise) {
        await Promise.race([
          consumePromise.catch(() => {}),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, CONSUMER_UNWIND_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
      }
    }
  }

  // The .part file is deliberately left behind: the next check-for-update resumes
  // from it instead of re-downloading 160MB over the same flaky link.
  throw lastError
}

export type WindowsZipReplaceScriptParams = {
  processId: number
  assetPath: string
  targetDir: string
  executablePath: string
  stagingDir: string
  logPath: string
  waitTimeoutSeconds: number
}

const escapePowerShellSingleQuoted = (value: string) => value.replace(/'/g, "''")
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf])

export function encodePowerShellScriptUtf8Bom(script: string): Buffer {
  return Buffer.concat([utf8Bom, Buffer.from(script, 'utf8')])
}

// 症状: ①更新失败后安装目录只剩一半文件、应用彻底打不开，日志里没有任何回滚记录；
//       ②一次更新失败后，之后每一次更新都在动到安装目录之前就报错，用户只看到一句关于
//       备份目录的报错，不知道要删什么；③回滚自身失败时日志只有 "Rollback failed"。
// 根因 (2026-08-16 实测, tests/updater.test.ts 三条端到端 PowerShell 用例):
//   ① `$backupCreated = $true` 曾写在 Move-Item 管道之后。管道跑在
//      $ErrorActionPreference='Stop' 下，中途一个被占用的文件就终止整条管道 —— 实测
//      backupCreated=False / targetRemaining=1 / backupHolds=3，catch 里的回滚分支被整个跳过。
//   ② 成功路径用 -ErrorAction SilentlyContinue 删备份目录，被占用时会永久留下
//      <install>.chill-vibe-backup；下一次更新开头无保护的 Remove-Item 把后续更新全部锁死。
//   ③ 回滚失败时应用已经退出，日志是唯一信号，没有路径就没法指导用户手工恢复。
// 被否决的替代:
//   - 「把 Move-Item 加 -ErrorAction SilentlyContinue 让它别中断」: 那会让部分文件留在
//     安装目录里被新版本覆盖，损坏比中止更隐蔽。
//   - 「陈旧备份目录删不掉就直接 throw」: 这正是 ② 的当前行为 —— 用户永远卡在旧版本。
//     换用带时间戳的新备份目录名，把「清不掉的垃圾」降级成一条日志。
// 注意: 若阻塞交换的句柄在回滚时仍未释放，回滚的清空步骤同样会失败 —— 那条路径只保证
//       日志里留下备份目录绝对路径（见 ③），不保证自动恢复。
export function buildWindowsZipReplaceScript(params: WindowsZipReplaceScriptParams): string {
  const pidLiteral = `${params.processId}`
  const waitTimeoutLiteral = `${params.waitTimeoutSeconds}`
  const assetLiteral = escapePowerShellSingleQuoted(params.assetPath)
  const targetLiteral = escapePowerShellSingleQuoted(params.targetDir)
  const executableLiteral = escapePowerShellSingleQuoted(params.executablePath)
  const stagingLiteral = escapePowerShellSingleQuoted(params.stagingDir)
  const logLiteral = escapePowerShellSingleQuoted(params.logPath)

  return `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$pidToWait = ${pidLiteral}
$waitTimeoutSeconds = ${waitTimeoutLiteral}
$assetPath = '${assetLiteral}'
$targetDir = '${targetLiteral}'
$executablePath = '${executableLiteral}'
$stagingDir = '${stagingLiteral}'
$logPath = '${logLiteral}'

function Write-Log {
  param([string]$Message)
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
  "[$stamp] $Message" | Out-File -FilePath $logPath -Append -Encoding utf8
}

function Get-MatchingAppProcessIds {
  param([int]$ProcessId, [string]$ExecutablePath)

  $normalizedExecutablePath = [System.IO.Path]::GetFullPath($ExecutablePath)
  $processIds = New-Object 'System.Collections.Generic.HashSet[int]'

  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    [void]$processIds.Add($ProcessId)
  }

  foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if (-not $proc.ExecutablePath) {
      continue
    }

    try {
      $candidatePath = [System.IO.Path]::GetFullPath($proc.ExecutablePath)
    } catch {
      continue
    }

    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($candidatePath, $normalizedExecutablePath)) {
      [void]$processIds.Add([int]$proc.ProcessId)
    }
  }

  return @($processIds)
}

function Wait-ForProcessExit {
  param([int]$ProcessId, [string]$ExecutablePath, [int]$TimeoutSeconds)

  $elapsedMilliseconds = 0
  while ($true) {
    $matchingProcessIds = @(Get-MatchingAppProcessIds -ProcessId $ProcessId -ExecutablePath $ExecutablePath)
    if ($matchingProcessIds.Count -eq 0) {
      break
    }

    if ($elapsedMilliseconds -ge ($TimeoutSeconds * 1000)) {
      Write-Log "App processes still running after $TimeoutSeconds seconds: $($matchingProcessIds -join ', '). Force-killing."
      foreach ($remainingId in $matchingProcessIds) {
        try {
          Stop-Process -Id $remainingId -Force -ErrorAction Stop
        } catch {
          Write-Log "Stop-Process $remainingId failed: $($_.Exception.Message)"
        }
      }
      Start-Sleep -Milliseconds 500
      break
    }

    Start-Sleep -Milliseconds 500
    $elapsedMilliseconds += 500
  }
}

function Test-AppPayloadComplete {
  param([string]$Root, [string]$ExeName)

  $required = @(
    (Join-Path $Root $ExeName),
    (Join-Path $Root 'resources'),
    (Join-Path $Root 'resources\\app.asar')
  )

  foreach ($requiredPath in $required) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      return $false
    }
  }

  return $true
}

function Get-MissingPayloadPaths {
  param([string]$Root, [string]$ExeName)

  $required = @($ExeName, 'resources', 'resources\\app.asar')
  $missing = @()

  foreach ($relativePath in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relativePath))) {
      $missing += $relativePath
    }
  }

  return @($missing)
}

function Find-AppRoot {
  param(
    [string]$Root,
    [string]$ExeName
  )

  # 症状: 更新后应用打不开 / 版本没变，日志却写着 'Update job done.'。
  # 根因: 旧的 fallback 分支接受任何含有 exe 的目录当作 app 根。当解压未完成或
  #       归档损坏时，一个只有 exe、没有 resources\\app.asar 的残缺目录就会被采纳，
  #       随后清空用户安装目录并启动一个打不开的应用（2026-08-16 实测可复现）。
  # 被否决的替代: 只在复制后检查 —— 那时安装目录已经被清空，损坏已经发生。
  foreach ($candidate in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $ExeName)) {
    if (Test-AppPayloadComplete -Root $candidate.DirectoryName -ExeName $ExeName) {
      return $candidate.DirectoryName
    }
  }

  return $null
}

$exeName = [System.IO.Path]::GetFileName($executablePath)
$backupDir = "$targetDir.chill-vibe-backup"
$backupCreated = $false

try {
  Write-Log "Update job started. pid=$pidToWait target=$targetDir asset=$assetPath"

  if (-not (Test-Path -LiteralPath $assetPath)) {
    throw "Downloaded update package is missing: $assetPath"
  }

  $assetBytes = (Get-Item -LiteralPath $assetPath).Length
  if ($assetBytes -le 0) {
    throw "Downloaded update package is empty: $assetPath"
  }
  Write-Log "Asset verified: $assetBytes bytes."

  Wait-ForProcessExit -ProcessId $pidToWait -ExecutablePath $executablePath -TimeoutSeconds $waitTimeoutSeconds
  Write-Log 'App processes exited (or were force-killed); proceeding.'

  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
  }

  New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
  Write-Log "Begin expand archive -> $stagingDir"
  Expand-Archive -LiteralPath $assetPath -DestinationPath $stagingDir -Force
  Write-Log 'Expand archive finished.'

  # Integrity gate: nothing below this line may run against a half-extracted payload,
  # because the next phase is destructive to the user's installed app.
  $sourceRoot = Find-AppRoot -Root $stagingDir -ExeName $exeName
  if (-not $sourceRoot) {
    $strandedExe = @(Get-ChildItem -LiteralPath $stagingDir -Recurse -File -Filter $exeName | Select-Object -First 1)
    if ($strandedExe.Count -gt 0) {
      $missing = (Get-MissingPayloadPaths -Root $strandedExe[0].DirectoryName -ExeName $exeName) -join ', '
      throw "Extracted payload is incomplete (missing: $missing). Keeping the current install untouched."
    }
    throw "Extracted payload is incomplete: no '$exeName' found under $stagingDir. Keeping the current install untouched."
  }

  $sourceFileCount = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File).Count
  Write-Log "Resolved source root: $sourceRoot ($sourceFileCount files)"

  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

  # Move the old install aside instead of deleting it, so a failed copy can roll back
  # rather than leaving the user with no app at all.
  if (Test-Path -LiteralPath $backupDir) {
    try {
      Remove-Item -LiteralPath $backupDir -Recurse -Force
    } catch {
      $staleBackupDir = $backupDir
      $backupDir = "$targetDir.chill-vibe-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
      Write-Log "Stale backup folder could not be deleted: $staleBackupDir ($($_.Exception.Message))."
      Write-Log "Using $backupDir for this run. Delete $staleBackupDir manually once nothing is using it."
    }
  }
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  # $backupCreated must be armed BEFORE the move, not after: the pipeline below runs under
  # $ErrorActionPreference = 'Stop', so one locked file aborts it with part of the install
  # already parked in $backupDir. Arming afterwards left the flag $false in exactly that
  # case and skipped the rollback below, stranding a half-empty install directory.
  $backupCreated = $true
  Write-Log "Begin swap: moving current install aside -> $backupDir"
  Get-ChildItem -LiteralPath $targetDir -Force | Move-Item -Destination $backupDir -Force
  Write-Log 'Previous install parked. Copying new files...'

  Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $targetDir -Recurse -Force
  }
  Write-Log 'Copy finished.'

  $missingAfterCopy = (Get-MissingPayloadPaths -Root $targetDir -ExeName $exeName) -join ', '
  if ($missingAfterCopy) {
    throw "Copied install is incomplete (missing: $missingAfterCopy)."
  }

  $targetFileCount = @(Get-ChildItem -LiteralPath $targetDir -Recurse -File).Count
  if ($targetFileCount -lt $sourceFileCount) {
    throw "Copied install is incomplete: $targetFileCount of $sourceFileCount files landed in $targetDir."
  }
  Write-Log "Copy verified: $targetFileCount files."

  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  $backupCreated = $false

  Start-Sleep -Milliseconds 250
  Write-Log "Launch new app: $executablePath"
  Start-Process -FilePath $executablePath -WorkingDirectory $targetDir | Out-Null
  Write-Log 'Launch issued. Update job done.'
} catch {
  Write-Log "Update job failed: $($_.Exception.Message)"
  Write-Log $_.ScriptStackTrace

  if ($backupCreated -and (Test-Path -LiteralPath $backupDir)) {
    try {
      Write-Log 'Rolling back to the previous install...'
      if (Test-Path -LiteralPath $targetDir) {
        Get-ChildItem -LiteralPath $targetDir -Force | Remove-Item -Recurse -Force
      } else {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
      }
      Get-ChildItem -LiteralPath $backupDir -Force | Move-Item -Destination $targetDir -Force
      Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Log 'Rollback finished; relaunching the previous install.'
      Start-Process -FilePath $executablePath -WorkingDirectory $targetDir | Out-Null
    } catch {
      Write-Log "Rollback failed: $($_.Exception.Message)"
      Write-Log "Manual recovery: restore files from $backupDir into $targetDir, then relaunch $executablePath"
    }
  }

  throw
}
`
}

const getPlatformDisplayName = (platform: string) => {
  if (platform === 'win32') {
    return 'Windows'
  }

  if (platform === 'darwin') {
    return 'macOS'
  }

  if (platform === 'linux') {
    return 'Linux'
  }

  return platform
}

const buildMissingAssetError = (assets: GitHubAsset[], platform: string) => {
  if (assets.length === 0) {
    return 'Latest release does not have any downloadable assets yet.'
  }

  return `No downloadable ${getPlatformDisplayName(platform)} asset found in the latest release.`
}

const findAssetByExtension = (assets: GitHubAsset[], extensions: string[]) => {
  const normalizedExtensions = extensions.map((value) => value.toLowerCase())

  return (
    assets.find((asset) => {
      const name = asset.name.trim().toLowerCase()
      return normalizedExtensions.some((extension) => name.endsWith(extension))
    }) ?? null
  )
}

export function selectPlatformAsset(
  assets: GitHubAsset[],
  platform: string,
): GitHubAsset | null {
  if (platform === 'win32') {
    return findAssetByExtension(assets, ['.zip', '.exe'])
  }
  if (platform === 'darwin') {
    return findAssetByExtension(assets, ['.dmg'])
  }
  return null
}

export function parseReleaseResponse(
  release: GitHubRelease,
  currentVersion: string,
  platform: string,
): UpdateCheckResult {
  const latestVersion = parseVersionTag(release.tag_name)

  if (!latestVersion) {
    return { hasUpdate: false, currentVersion, error: `Invalid release tag: ${release.tag_name}` }
  }

  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { hasUpdate: false, currentVersion, latestVersion }
  }

  const asset = selectPlatformAsset(release.assets, platform)

  if (!asset) {
    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      htmlUrl: release.html_url,
      releaseNotes: release.body,
      error: buildMissingAssetError(release.assets, platform),
    }
  }

  return {
    hasUpdate: true,
    currentVersion,
    latestVersion,
    assetUrl: asset.browser_download_url,
    htmlUrl: release.html_url,
    releaseNotes: release.body,
  }
}
