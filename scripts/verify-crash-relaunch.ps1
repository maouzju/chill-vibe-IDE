# End-to-end proof that the app comes back after being killed the way the real
# flash-exits kill it: `taskkill /PID <pid> /T /F` against a fully-running
# instance. Anything short of watching a new process appear is not evidence.
#
# Runs against an isolated CHILL_VIBE_DATA_DIR and only ever kills the PID this
# script launched, so the user's own instance is untouched.

param(
    [string]$ReleaseDir = 'D:\Git\chill-vibe\dist\release-20260812-011812',
    [string]$DataDir = 'D:\Temp\cv-relaunch-verify'
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\kill-guard.ps1')

$appExe = Join-Path $ReleaseDir 'win-unpacked\Chill Vibe.exe'
if (-not (Test-Path $appExe)) { throw "App not found: $appExe" }

# 症状：2026-08-12 01:21，这个脚本杀掉了用户正在使用的实例（pid 5960，退出码 -1），
#       现场与"神秘闪退"无法区分，白白消耗了一整轮排查。
# 根因：下面那段找"复活实例"的循环，注释说按隔离数据目录识别，实际是排除几个已知项后
#       抓到第一个就认，于是认成了用户的实例，清理时连它一起杀了。
# 为什么不能换写法：进程名、命令行都不足以区分（守卫进程与主应用同名同二进制），PID
#       还会被回收复用。快照 + 创建时间是唯一确定性判据，见 lib/kill-guard.ps1。
# Fail loud, never soft: an earlier revision let $killGuard stay $null (Set-StrictMode
# leaking out of the dot-sourced library aborted its construction). Every later
# Stop-ProcessGuarded then failed parameter binding and the script sailed on, which
# reads exactly like "the guard protected everything" while nothing was guarded.
$killGuard = $null
try {
    $killGuard = New-KillGuard -ProcessNames @('Chill Vibe.exe')
} catch {
    Write-Output "New-KillGuard threw: $($_.Exception.Message)"
}
if (-not $killGuard -or -not $killGuard.Preexisting) {
    throw 'kill-guard failed to initialise -- refusing to run a script that kills processes'
}
Write-Output "kill-guard: $($killGuard.Preexisting.Count) pre-existing 'Chill Vibe' process(es) are protected"

if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

$env:CHILL_VIBE_DATA_DIR = $DataDir
$env:CHILL_VIBE_ALLOW_SHARED_DATA_DIR = '1'
$env:CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK = '1'

$logPath = Join-Path $DataDir 'logs\main.log'
$guardLog = Join-Path $DataDir 'logs\relaunch-guard.log'

Write-Output '=== launching instance #1 ==='
$proc = Start-Process -FilePath $appExe -PassThru
$null = $proc.Handle
$firstPid = $proc.Id
Write-Output "instance #1 pid=$firstPid"

for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $logPath) {
        if ((Get-Content $logPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue) -match 'Renderer finished load') { break }
    }
}
Write-Output "renderer loaded: $((Test-Path $logPath) -and ((Get-Content $logPath -Encoding UTF8 -Raw) -match 'Renderer finished load'))"

Start-Sleep -Seconds 4

$guard = Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" |
    Where-Object { $_.CommandLine -match 'crash-relaunch-guard-main' }
Write-Output "guard process running : $([bool]$guard) (pid=$(if ($guard) { $guard.ProcessId } else { 'none' }))"
if ($guard) {
    $guardParentAlive = $null -ne (Get-Process -Id $guard.ParentProcessId -ErrorAction SilentlyContinue)
    Write-Output "guard parent pid      : $($guard.ParentProcessId) (alive=$guardParentAlive)  <- must NOT be $firstPid"
    Write-Output "guard detached ok     : $($guard.ParentProcessId -ne $firstPid)"
}

Write-Output ''
Write-Output "=== taskkill /PID $firstPid /T /F ==="
& "$env:SystemRoot\System32\taskkill.exe" /PID $firstPid /T /F 2>&1 | ForEach-Object { "  $_" }
$proc.WaitForExit(20000) | Out-Null
Write-Output "instance #1 exit code = $(try { $proc.ExitCode } catch { 'n/a' })"

Write-Output ''
Write-Output '=== waiting for the guard to bring it back (30s) ==='
$revived = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $candidates = Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -notmatch 'codex-destructive-command-guard' } |
        Where-Object { $_.CommandLine -notmatch 'crash-relaunch-guard-main' } |
        Where-Object { $_.CommandLine -notmatch '--type=' } |
        Where-Object { $_.ProcessId -ne $firstPid }
    # A candidate only counts as "ours" if the guard would let us kill it, i.e. it
    # did not exist before this script started. Anything else is the user's.
    foreach ($c in $candidates) {
        if (-not (Test-KillAllowed -Guard $killGuard -ProcessId ([int]$c.ProcessId))) { continue }
        $revived = $c
        break
    }
    if ($revived) { break }
}

Write-Output ''
Write-Output '=== RESULT ==='
if ($revived) {
    Write-Output "RELAUNCHED: yes  new pid=$($revived.ProcessId) after $([int]($i * 0.5))s"
} else {
    Write-Output 'RELAUNCHED: no'
}
if (Test-Path $guardLog) {
    Write-Output '--- relaunch-guard.log ---'
    Get-Content $guardLog -Encoding UTF8 | ForEach-Object { "  $_" }
} else {
    Write-Output '--- relaunch-guard.log MISSING ---'
}

# Clean up everything this script started -- and provably nothing else.
Start-Sleep -Seconds 2
Write-Output ''
Write-Output '=== cleanup (guarded) ==='
Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { $null = Stop-ProcessGuarded -Guard $killGuard -ProcessId ([int]$_.ProcessId) -Reason '(spawned by this run)' }
Write-Output "cleanup killed   : $($killGuard.Killed.Count)"
Write-Output "cleanup protected: $($killGuard.Refused.Count)"
