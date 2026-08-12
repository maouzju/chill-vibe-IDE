# Controlled experiment: kill an ISOLATED app instance and record the forensic
# signature it leaves, so real crashes can be matched against a known cause.
#
# Why: the 2026-08-11 flash-exits left no shutdown log, no Windows event and no
# minidump, and that "three-way absence" was READ as proof of an external kill.
# It was never verified that an external kill actually produces that signature,
# nor that other causes do not. This script produces the reference sample.
#
# Safety: the instance runs against its own CHILL_VIBE_DATA_DIR and is killed by
# the PID this script itself launched. The user's running app is never touched.

param(
    # 默认留空、由下面自动挑 dist 下最新产物。原来写死的是某个 worktree 里的一次性
    # 构建，而 `.claude/worktrees/` 在 .gitignore 里 —— 那个默认值对任何人（包括本机
    # 以后）都必然不存在。姊妹脚本 forensics-hang-kill-signature.ps1 用的就是这个形状。
    [string]$AppExe = '',
    [string]$DataDir = 'D:\Temp\cv-killtest',
    [ValidateSet('taskkill-tree', 'clean-quit')]
    [string]$Mode = 'taskkill-tree'
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\kill-guard.ps1')

if (-not $AppExe) {
    $candidate = Get-ChildItem -Path (Join-Path $PSScriptRoot '..\dist') -Directory -Filter 'release-*' -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending |
                 ForEach-Object { Join-Path $_.FullName 'win-unpacked\Chill Vibe.exe' } |
                 Where-Object { Test-Path $_ } |
                 Select-Object -First 1
    if (-not $candidate) { throw 'no packaged build found under dist/release-*; pass -AppExe explicitly' }
    $AppExe = $candidate
}

if (-not (Test-Path $AppExe)) { throw "App not found: $AppExe" }

# Snapshot before launching anything: the teardown below may only touch what this
# run created. Filtering by "is a child of our instance" is not enough on Windows,
# where a recycled PID can make an unrelated process look like our child.
$killGuard = New-KillGuard -ProcessNames @('Chill Vibe.exe')
if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

$logPath = Join-Path $DataDir 'logs\main.log'
$startedAt = Get-Date

Write-Output "=== [$Mode] launching isolated instance ==="
# CHILL_VIBE_DATA_DIR alone is ignored by a packaged build -- resolveDesktopDataDir
# only honours it when the shared-data-dir override is explicitly enabled. Without
# this second flag the "isolated" instance silently attaches to the user's real
# profile, which is exactly what happened on the first run of this script.
$env:CHILL_VIBE_DATA_DIR = $DataDir
$env:CHILL_VIBE_ALLOW_SHARED_DATA_DIR = '1'
$env:CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK = '1'
$proc = Start-Process -FilePath $AppExe -PassThru
$null = $proc.Handle   # retain before it can die
$mainPid = $proc.Id
Write-Output "main pid=$mainPid"

# Wait for the renderer to finish loading, so we kill a fully-running app.
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $logPath) {
        $text = Get-Content $logPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
        if ($text -match 'Renderer finished load') { $ready = $true; break }
    }
}
Write-Output "renderer ready=$ready after $([int]((Get-Date) - $startedAt).TotalSeconds)s"
if (-not $ready) { Write-Output '!! app never reached a running state; signature below is for a STARTUP failure' }

Start-Sleep -Seconds 3
$children = Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" |
    Where-Object { $_.CommandLine -notmatch 'codex-destructive-command-guard' } |
    Where-Object { $_.ProcessId -eq $mainPid -or $_.ParentProcessId -eq $mainPid }
Write-Output "process tree size=$($children.Count)"

$killAt = Get-Date
switch ($Mode) {
    'taskkill-tree' {
        Write-Output "--- taskkill /PID $mainPid /T /F ---"
        & "$env:SystemRoot\System32\taskkill.exe" /PID $mainPid /T /F 2>&1 | ForEach-Object { "  taskkill: $_" }
    }
    'clean-quit' {
        Write-Output '--- CloseMainWindow (what the user pressing X does) ---'
        $null = $proc.CloseMainWindow()
    }
}

$proc.WaitForExit(30000) | Out-Null
$code = try { $proc.ExitCode } catch { $null }
$hex = if ($null -ne $code) { '0x{0:X8}' -f ([uint32]($code -band 0xFFFFFFFF)) } else { 'UNAVAILABLE' }
Write-Output "EXIT CODE = $code ($hex)"

Start-Sleep -Seconds 3

# --- signature ---
$log = if (Test-Path $logPath) { Get-Content $logPath -Encoding UTF8 -Raw } else { '' }
$hasBeforeQuit = $log -match 'before-quit'
$hasWillQuit = $log -match 'will-quit'
$hasWindowAllClosed = $log -match 'window-all-closed'

$dumpDirs = @(
    (Join-Path $DataDir 'crash-dumps'),
    (Join-Path $DataDir 'logs\crash-dumps')
)
$dumps = @()
foreach ($d in $dumpDirs) {
    if (Test-Path $d) { $dumps += Get-ChildItem $d -Recurse -Filter '*.dmp' -ErrorAction SilentlyContinue }
}

$appEvents = Get-WinEvent -FilterHashtable @{LogName = 'Application'; StartTime = $killAt.AddSeconds(-5) } -ErrorAction SilentlyContinue |
    Where-Object { $_.LevelDisplayName -in @('Error', 'Critical') }

$survivors = Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch 'codex-destructive-command-guard' } |
    Where-Object { $_.ProcessId -in ($children.ProcessId) }

Write-Output ''
Write-Output '=== FORENSIC SIGNATURE ==='
Write-Output "exitCode          : $code ($hex)"
Write-Output "before-quit log   : $hasBeforeQuit"
Write-Output "will-quit log     : $hasWillQuit"
Write-Output "window-all-closed : $hasWindowAllClosed"
Write-Output "minidumps written : $($dumps.Count)"
Write-Output "Application errors: $($appEvents.Count)"
Write-Output "orphaned children : $($survivors.Count)"
Write-Output ''
Write-Output '--- last 8 log lines ---'
if ($log) { ($log -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 8) | ForEach-Object { "  $_" } }

# Leave nothing running -- of ours.
foreach ($s in $survivors) {
    $null = Stop-ProcessGuarded -Guard $killGuard -ProcessId ([int]$s.ProcessId) -Reason '(orphaned child)'
}
