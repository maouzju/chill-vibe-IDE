# Proves the kill guard against real processes, including the exact shape of the
# 2026-08-12 01:21 accident: the user's own running Chill Vibe must be refused.
#
# Synthetic fixtures would not have caught that accident -- the bug was in which
# live process got selected, not in the arithmetic. So every case here runs
# against a real PID.

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\kill-guard.ps1')

$pass = 0
$fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { $script:pass++; Write-Output "  PASS  $name" }
    else { $script:fail++; Write-Output "  FAIL  $name  $detail" }
}

Write-Output '=== kill-guard verification ==='

# The user's app must be snapshotted as untouchable.
$userApp = @(Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue)
$guard = New-KillGuard -ProcessNames @('Chill Vibe.exe')

if ($userApp.Count -gt 0) {
    $target = [int]$userApp[0].ProcessId
    $refusal = Get-KillRefusal -Guard $guard -ProcessId $target
    Check "refuses the user's running Chill Vibe (pid $target)" ($null -ne $refusal) "got: $refusal"
    Check "  refusal cites pre-existence" ($refusal -match 'existed before') "got: $refusal"
} else {
    Write-Output '  SKIP  no Chill Vibe running to protect'
}

# This very PowerShell process predates the guard.
$refusal = Get-KillRefusal -Guard $guard -ProcessId $PID
Check "refuses a process older than the guard (self, pid $PID)" ($null -ne $refusal) "got: $refusal"

# System processes are always off-limits.
Check 'refuses pid 4 (System)' ($null -ne (Get-KillRefusal -Guard $guard -ProcessId 4))

# A PID that does not exist.
Check 'refuses a nonexistent pid' ($null -ne (Get-KillRefusal -Guard $guard -ProcessId 999999))

# A process this script started AFTER the guard is fair game.
$child = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
    -ArgumentList '/c', 'ping -n 30 127.0.0.1 >NUL' -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 400
$childPid = $child.Id
$refusal = Get-KillRefusal -Guard $guard -ProcessId $childPid
Check "allows a process started after the guard (pid $childPid)" ($null -eq $refusal) "got: $refusal"

$killed = Stop-ProcessGuarded -Guard $guard -ProcessId $childPid -Reason '(test child)'
Check 'actually kills the allowed process' ([bool]$killed)
$child.WaitForExit(5000) | Out-Null
Check 'allowed process is gone' ($null -eq (Get-Process -Id $childPid -ErrorAction SilentlyContinue))

# Explicit protection wins even for a fresh process.
$child2 = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
    -ArgumentList '/c', 'ping -n 30 127.0.0.1 >NUL' -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 400
$guard2 = New-KillGuard -ProcessNames @('Chill Vibe.exe') -AlwaysProtect @($child2.Id)
Check "honours AlwaysProtect (pid $($child2.Id))" ($null -ne (Get-KillRefusal -Guard $guard2 -ProcessId $child2.Id))
try { Stop-Process -Id $child2.Id -Force -ErrorAction SilentlyContinue } catch { }

# Nothing the guard refused may ever appear in the killed list.
Check 'guard killed exactly one process' ($guard.Killed.Count -eq 1) "killed=$($guard.Killed -join ',')"

# Deny-list rail, used by scripts that must kill processes older than themselves.
Check 'protects "Chill Vibe"'      (Test-ProtectedProcessName -Name 'Chill Vibe')
Check 'protects "Chill Vibe.exe"'  (Test-ProtectedProcessName -Name 'Chill Vibe.exe')
Check 'protects electron'          (Test-ProtectedProcessName -Name 'electron')
Check 'protects claude'            (Test-ProtectedProcessName -Name 'claude.exe')
Check 'protects explorer'          (Test-ProtectedProcessName -Name 'explorer')
# Exact match only -- a substring rule would protect far too much and, worse,
# would give a false sense that unrelated names are covered.
Check 'does NOT protect an unrelated name' (-not (Test-ProtectedProcessName -Name 'SomeVendorService'))
Check 'does NOT protect a superstring'     (-not (Test-ProtectedProcessName -Name 'ChillVibeUpdater'))

Write-Output ''
Write-Output "=== $pass passed, $fail failed ==="
if ($fail -gt 0) { exit 1 }
