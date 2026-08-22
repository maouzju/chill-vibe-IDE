<#
.SYNOPSIS
  Upgrades an installed Chill Vibe IDE to the latest published release.

.DESCRIPTION
  Self-contained rescue path for machines whose built-in updater is too old to fix
  itself. Builds up to v0.20.6 shipped an updater with no download timeout, no resume,
  and an in-flight cache that permanently pinned a hung request -- once it stalled,
  "Check for updates" could never do anything again. Those installs cannot pull the
  fix through the very mechanism that is broken, so this script does it from outside.

  Mirrors the hardened logic now in electron/updater-core.ts:
    - stall watchdog covering the connect phase, not just the body
    - HTTP Range resume, keeping the .part between runs
    - the payload is proven whole (bytes on disk, not a counter) before anything
      touches the existing install
    - the old install is parked, not deleted, so a failed copy rolls back

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File upgrade-install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File upgrade-install.ps1 -TargetDir 'D:\Apps\Chill Vibe IDE'
#>
[CmdletBinding()]
param(
  # Install directory to upgrade. Auto-detected when omitted.
  [string]$TargetDir,
  # Pin a specific version instead of the latest release, e.g. '0.20.7'.
  [string]$Version,
  # Explicit proxy, e.g. 'http://127.0.0.1:7890'. Falls back to the system proxy.
  [string]$Proxy,
  # Seconds without a single new byte before an attempt is abandoned.
  [int]$StallTimeoutSeconds = 45,
  [int]$MaxAttempts = 8,
  # Report what would happen, change nothing.
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoSlug = 'maouzju/chill-vibe-IDE'
$ExeName  = 'Chill Vibe.exe'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

# TLS 1.2 is not the default on stock Windows PowerShell 5.1; without this every
# GitHub request dies with a bare "underlying connection was closed".
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-RunningInstallDirs {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath })
  return @($procs | ForEach-Object { Split-Path $_.ExecutablePath } | Sort-Object -Unique)
}

function Get-ShortcutTargets {
  $roots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  ) | Where-Object { $_ -and (Test-Path $_) }

  $shell = New-Object -ComObject WScript.Shell
  $found = @()

  foreach ($root in $roots) {
    foreach ($lnk in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
      try { $target = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { continue }
      if ($target -and ($target -like "*$ExeName")) {
        if (Test-Path -LiteralPath $target) { $found += (Split-Path $target) }
      }
    }
  }

  return @($found | Sort-Object -Unique)
}

function Test-PayloadComplete {
  param([string]$Root)
  foreach ($relative in @($ExeName, 'resources', 'resources\app.asar')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $relative))) { return $false }
  }
  return $true
}

function Get-InstalledVersion {
  param([string]$Root)

  # The exe's VersionInfo reports Electron's version (36.x), never the app's -- the
  # real number only exists inside app.asar's package.json.
  $asar = Join-Path $Root 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar)) { return $null }

  try {
    $stream = [System.IO.File]::Open($asar, 'Open', 'Read', 'ReadWrite')
    try {
      $head = New-Object byte[] 16
      [void]$stream.Read($head, 0, 16)
      $jsonLen   = [BitConverter]::ToUInt32($head, 12)
      $dataStart = 8 + [BitConverter]::ToUInt32($head, 4)

      $jsonBytes = New-Object byte[] $jsonLen
      [void]$stream.Read($jsonBytes, 0, $jsonLen)
      $header = [Text.Encoding]::UTF8.GetString($jsonBytes) | ConvertFrom-Json

      $entry = $header.files.'package.json'
      if (-not $entry) { return $null }

      $pkgBytes = New-Object byte[] ([int]$entry.size)
      [void]$stream.Seek($dataStart + [int]$entry.offset, 'Begin')
      [void]$stream.Read($pkgBytes, 0, $pkgBytes.Length)

      return ([Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json).version
    } finally {
      $stream.Dispose()
    }
  } catch {
    return $null
  }
}

function New-HttpClient {
  param([string]$ProxyUrl)

  Add-Type -AssemblyName System.Net.Http

  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $true

  if ($ProxyUrl) {
    $handler.Proxy = New-Object System.Net.WebProxy($ProxyUrl, $true)
    $handler.UseProxy = $true
    Write-Ok "Using proxy: $ProxyUrl"
  } else {
    $handler.UseProxy = $true   # picks up the system proxy
  }

  $client = New-Object System.Net.Http.HttpClient($handler)
  # No overall timeout: a 160MB payload on a slow link is legitimately slow. The
  # judgement we care about is "how long since the last byte", enforced per read.
  $client.Timeout = [TimeSpan]::FromMilliseconds(-1)
  $client.DefaultRequestHeaders.Add('User-Agent', 'chill-vibe-ide-upgrade')
  return $client
}

function Resolve-SystemProxy {
  try {
    $settings = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer) {
      $server = $settings.ProxyServer
      if ($server -notmatch '://') { $server = "http://$server" }
      return $server
    }
  } catch { }
  return $null
}

function Invoke-ResumableDownload {
  param(
    [string]$Url,
    [string]$DestPath,
    [long]$ExpectedBytes,
    [int]$MaxAttempts,
    [int]$StallTimeoutSeconds,
    [string]$ProxyUrl
  )

  $partPath = "$DestPath.part"
  $client = New-HttpClient -ProxyUrl $ProxyUrl
  $lastError = 'download never ran'

  try {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
      $alreadyOnDisk = 0L
      if (Test-Path -LiteralPath $partPath) { $alreadyOnDisk = (Get-Item -LiteralPath $partPath).Length }

      if ($ExpectedBytes -gt 0 -and $alreadyOnDisk -ge $ExpectedBytes) {
        # A leftover .part at or beyond the full size cannot be a valid prefix.
        Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue
        $alreadyOnDisk = 0L
      }

      $request = New-Object System.Net.Http.HttpRequestMessage('Get', $Url)
      if ($alreadyOnDisk -gt 0) {
        [void]$request.Headers.Range.Add(
          (New-Object System.Net.Http.Headers.RangeItemHeaderValue($alreadyOnDisk, $null)))
        Write-Host "    attempt $attempt/$MaxAttempts -- resuming at $([math]::Round($alreadyOnDisk/1MB,1)) MB"
      } else {
        Write-Host "    attempt $attempt/$MaxAttempts -- starting from zero"
      }

      $cts = New-Object System.Threading.CancellationTokenSource
      $fileStream = $null
      $httpStream = $null
      $response = $null

      try {
        # The watchdog must cover the connect/response-header phase too: on a blocked
        # route the request itself never settles, and a timer that only starts once
        # the body arrives would never fire at all.
        $cts.CancelAfter([TimeSpan]::FromSeconds($StallTimeoutSeconds))
        $sendTask = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token)
        $response = $sendTask.GetAwaiter().GetResult()

        $status = [int]$response.StatusCode

        if ($status -eq 416) {
          Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue
          $lastError = 'server rejected the resume offset'
          $attempt--   # bookkeeping, not a failed attempt
          continue
        }

        if (-not $response.IsSuccessStatusCode) {
          throw "HTTP $status"
        }

        $appending = $false
        $totalBytes = 0L

        if ($status -eq 206) {
          $cr = $response.Content.Headers.ContentRange
          if ($cr -and $cr.HasRange -and $cr.From -eq $alreadyOnDisk -and $cr.Length) {
            $appending = $alreadyOnDisk -gt 0
            $totalBytes = [long]$cr.Length
          } else {
            # A 206 we cannot line up. Treating it as a full body would splice a tail
            # onto nothing and then "verify" it against the tail's own length.
            Remove-Item -LiteralPath $partPath -Force -ErrorAction SilentlyContinue
            $lastError = 'partial response did not line up with the local resume offset'
            $attempt--
            continue
          }
        } else {
          $totalBytes = [long]$response.Content.Headers.ContentLength
        }

        $httpStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $mode = if ($appending) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
        $fileStream = New-Object System.IO.FileStream($partPath, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)

        $received = if ($appending) { $alreadyOnDisk } else { 0L }
        $buffer = New-Object byte[] (256 * 1024)
        $lastReport = -1

        while ($true) {
          $cts.CancelAfter([TimeSpan]::FromSeconds($StallTimeoutSeconds))
          $readTask = $httpStream.ReadAsync($buffer, 0, $buffer.Length, $cts.Token)
          $read = $readTask.GetAwaiter().GetResult()
          if ($read -le 0) { break }

          $fileStream.Write($buffer, 0, $read)
          $received += $read

          if ($totalBytes -gt 0) {
            $percent = [math]::Floor($received * 100 / $totalBytes)
            if ($percent -ne $lastReport -and ($percent % 5) -eq 0) {
              $lastReport = $percent
              Write-Host "      $percent%  ($([math]::Round($received/1MB,1)) / $([math]::Round($totalBytes/1MB,1)) MB)"
            }
          }
        }

        $fileStream.Dispose(); $fileStream = $null

        if ($totalBytes -gt 0 -and $received -ne $totalBytes) {
          throw "incomplete: received $received of $totalBytes bytes"
        }

        # Bytes on disk are the final judge -- an in-memory counter cannot see a
        # zombie writer from an abandoned attempt.
        $onDisk = (Get-Item -LiteralPath $partPath).Length
        if ($totalBytes -gt 0 -and $onDisk -ne $totalBytes) {
          throw "incomplete on disk: $onDisk of $totalBytes bytes"
        }

        if (Test-Path -LiteralPath $DestPath) { Remove-Item -LiteralPath $DestPath -Force }
        Move-Item -LiteralPath $partPath -Destination $DestPath -Force
        return $DestPath
      } catch {
        $lastError = $_.Exception.Message
        if ($_.Exception -is [System.OperationCanceledException] -or $lastError -match 'cancel') {
          $lastError = "stalled: no data for ${StallTimeoutSeconds}s"
        }
        Write-Warn "attempt failed: $lastError"

        if ($lastError -match '^HTTP 4' -and $lastError -notmatch '408|429') {
          throw "Download failed permanently: $lastError"
        }

        if ($attempt -lt $MaxAttempts) {
          $delay = [math]::Min(20, [math]::Pow(2, $attempt - 1))
          Start-Sleep -Seconds $delay
        }
      } finally {
        if ($fileStream) { $fileStream.Dispose() }
        if ($httpStream) { $httpStream.Dispose() }
        if ($response)   { $response.Dispose() }
        $cts.Dispose()
      }
    }

    throw "Download failed after $MaxAttempts attempts. Last error: $lastError"
  } finally {
    $client.Dispose()
  }
}

# -- 1. Locate the install ----------------------------------------------------
Write-Step 'Locating the installed app'

if (-not $TargetDir) {
  # Shortcut targets rank above running processes on purpose. A dev machine often has
  # several unpacked builds running out of dist\release-*, but the shortcut points at
  # the install the user actually lives in -- which is also the one the in-app updater
  # targets (`path.dirname(process.execPath)`), i.e. the one that is stuck.
  $fromShortcuts = @(Get-ShortcutTargets | Where-Object { Test-PayloadComplete -Root $_ } | Sort-Object -Unique)
  $fromRunning   = @(Get-RunningInstallDirs | Where-Object { Test-PayloadComplete -Root $_ } | Sort-Object -Unique)

  if ($fromShortcuts.Count -eq 1) {
    $TargetDir = $fromShortcuts[0]
    Write-Ok 'Picked the install your shortcut points at.'
  } else {
    $candidates = @(@($fromShortcuts + $fromRunning) | Sort-Object -Unique)

    if ($candidates.Count -eq 0) {
      throw "Could not find an installed Chill Vibe IDE. Pass one explicitly: -TargetDir 'C:\path\to\Chill Vibe IDE'"
    }

    if ($candidates.Count -gt 1) {
      Write-Warn "Found $($candidates.Count) installs:"
      foreach ($c in $candidates) { Write-Warn "  $c  (version $(Get-InstalledVersion -Root $c))" }
      throw "More than one install found. Pick one with -TargetDir '<path>'."
    }

    $TargetDir = $candidates[0]
  }
}

if (-not (Test-PayloadComplete -Root $TargetDir)) {
  throw "Not a complete Chill Vibe install: $TargetDir"
}

$currentVersion = Get-InstalledVersion -Root $TargetDir
Write-Ok "Install:  $TargetDir"
Write-Ok "Version:  $(if ($currentVersion) { $currentVersion } else { 'unknown' })"

# -- 2. Resolve the target release --------------------------------------------
Write-Step 'Checking the latest release'

if (-not $Proxy) { $Proxy = Resolve-SystemProxy }

$apiUrl = if ($Version) {
  "https://api.github.com/repos/$RepoSlug/releases/tags/v$Version"
} else {
  "https://api.github.com/repos/$RepoSlug/releases/latest"
}

$webParams = @{ Uri = $apiUrl; UseBasicParsing = $true; Headers = @{ 'User-Agent' = 'chill-vibe-ide-upgrade' }; TimeoutSec = 30 }
if ($Proxy) { $webParams['Proxy'] = $Proxy }

$release = (Invoke-WebRequest @webParams).Content | ConvertFrom-Json
$latestVersion = $release.tag_name -replace '^v', ''
$asset = @($release.assets | Where-Object { $_.name -like '*win*.zip' }) | Select-Object -First 1

if (-not $asset) { throw "Release $($release.tag_name) has no Windows zip asset." }

Write-Ok "Latest:   $latestVersion  ($($asset.name), $([math]::Round($asset.size/1MB,1)) MB)"

if ($currentVersion -eq $latestVersion) {
  Write-Host ''
  Write-Host "Already on $latestVersion -- nothing to do." -ForegroundColor Green
  return
}

if ($WhatIfOnly) {
  Write-Host ''
  Write-Host "Would upgrade $TargetDir : $currentVersion -> $latestVersion" -ForegroundColor Yellow
  return
}

# -- 3. Download --------------------------------------------------------------
Write-Step "Downloading $($asset.name)"

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) 'chill-vibe-upgrade'
New-Item -ItemType Directory -Path $workDir -Force | Out-Null
$zipPath = Join-Path $workDir $asset.name

if ((Test-Path -LiteralPath $zipPath) -and (Get-Item -LiteralPath $zipPath).Length -eq $asset.size) {
  Write-Ok 'Already downloaded and the size matches; skipping.'
} else {
  Invoke-ResumableDownload -Url $asset.browser_download_url -DestPath $zipPath `
    -ExpectedBytes $asset.size -MaxAttempts $MaxAttempts `
    -StallTimeoutSeconds $StallTimeoutSeconds -ProxyUrl $Proxy | Out-Null
  Write-Ok "Downloaded $([math]::Round((Get-Item -LiteralPath $zipPath).Length/1MB,1)) MB"
}

# -- 4. Extract and prove the payload before touching the install -------------
Write-Step 'Extracting and verifying'

$stageDir = Join-Path $workDir 'stage'
if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $stageDir)

$sourceRoot = $null
foreach ($exe in @(Get-ChildItem -LiteralPath $stageDir -Recurse -File -Filter $ExeName)) {
  if (Test-PayloadComplete -Root $exe.DirectoryName) { $sourceRoot = $exe.DirectoryName; break }
}

if (-not $sourceRoot) {
  throw "Extracted payload is incomplete -- keeping the current install untouched."
}

$sourceFileCount = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File).Count
Write-Ok "Payload verified: $sourceFileCount files, version $(Get-InstalledVersion -Root $sourceRoot)"

# -- 5. Stop the running app --------------------------------------------------
Write-Step 'Making sure the app is not running'

$running = @(Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($TargetDir, [System.StringComparison]::OrdinalIgnoreCase) })

if ($running.Count -gt 0) {
  Write-Warn "Closing $($running.Count) running process(es) from this install..."
  foreach ($proc in $running) {
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Seconds 3
  $stillRunning = @(Get-CimInstance Win32_Process -Filter "Name = '$ExeName'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($TargetDir, [System.StringComparison]::OrdinalIgnoreCase) })
  if ($stillRunning.Count -gt 0) {
    throw "Could not close every process from $TargetDir. Close the app manually and rerun."
  }
}
Write-Ok 'Not running.'

# -- 6. Swap, with rollback ---------------------------------------------------
Write-Step 'Installing'

$backupDir = "$TargetDir.backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

# Move the directory's *contents*, never the directory itself: an Explorer window
# holds a handle on the folder even when every file inside it is free.
$backupCreated = $true

try {
  Get-ChildItem -LiteralPath $TargetDir -Force | Move-Item -Destination $backupDir -Force

  Get-ChildItem -LiteralPath $sourceRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
  }

  if (-not (Test-PayloadComplete -Root $TargetDir)) { throw 'Copied install is incomplete.' }

  $targetFileCount = @(Get-ChildItem -LiteralPath $TargetDir -Recurse -File).Count
  if ($targetFileCount -lt $sourceFileCount) {
    throw "Copied install is incomplete: $targetFileCount of $sourceFileCount files."
  }

  $installedVersion = Get-InstalledVersion -Root $TargetDir
  if ($installedVersion -ne $latestVersion) {
    throw "Installed version reads $installedVersion, expected $latestVersion."
  }

  Write-Ok "Installed $installedVersion ($targetFileCount files)."
  Write-Host ''
  Write-Host "Done: $currentVersion -> $installedVersion" -ForegroundColor Green
  Write-Host "Previous install kept at: $backupDir" -ForegroundColor Gray
  Write-Host 'Delete that folder once the new version looks good.' -ForegroundColor Gray
} catch {
  Write-Warn "Install failed: $($_.Exception.Message)"

  if ($backupCreated -and (Test-Path -LiteralPath $backupDir)) {
    try {
      Write-Warn 'Rolling back...'
      Get-ChildItem -LiteralPath $TargetDir -Force | Remove-Item -Recurse -Force
      Get-ChildItem -LiteralPath $backupDir -Force | Move-Item -Destination $TargetDir -Force
      Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Warn 'Rollback finished; the previous version is back in place.'
    } catch {
      Write-Warn "Rollback failed: $($_.Exception.Message)"
      Write-Warn "Manual recovery: move everything from $backupDir back into $TargetDir"
    }
  }

  throw
}
