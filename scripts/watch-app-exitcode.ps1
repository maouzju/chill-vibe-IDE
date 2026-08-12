# Capture the EXIT CODE of every Chill Vibe process the instant it dies.
#
# Why: every other forensic channel came back empty -- no minidump, no Windows
# event, and none of the 6 shutdown log lines. The exit code is the one piece of
# evidence Windows still gives us, and it is decisive:
#   0          -> clean app.quit() (then the bug is that shutdown isn't logged)
#   1          -> killed by taskkill/TerminateProcess
#   0xC0000005 -> access violation, a native crash (renderer/GPU/Electron)
#   0xC0000017 -> STATUS_NO_MEMORY
#   0xC00000FD -> stack overflow
#   0xE0000008 -> V8 fatal / OOM abort
#
# The critical trick: touch $proc.Handle while the process is ALIVE. Without a
# retained handle the kernel frees the process object on exit and .ExitCode
# throws instead of returning the value we came for.
#
# 2026-08-12: the previous revision only watched the main process and wrote to
# stdout, so two instances that had been running since 08-10 captured the
# evidence into a console nobody could read. Everything now appends to a log
# file, and every process is tracked -- which one dies FIRST separates "the app
# was killed" from "a child crashed and took the app down with it".

$ErrorActionPreference = 'Continue'
$appName = 'Chill Vibe'
$logPath = Join-Path $PSScriptRoot '..\logs\app-exit-code.log'
$logDir = Split-Path -Parent $logPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Line([string]$text) {
    $line = "$(Get-Date -Format 'MM-dd HH:mm:ss.fff') $text"
    Write-Output $line
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Get-Role($commandLine) {
    if ([string]::IsNullOrEmpty($commandLine)) { return 'unknown' }
    # The Codex safety hook reuses the app binary as a node runtime; it is not
    # part of the app and its deaths are routine.
    if ($commandLine -match 'codex-destructive-command-guard') { return 'codex-guard' }
    if ($commandLine -match '--type=([a-zA-Z\-]+)') { return $Matches[1] }
    return 'main'
}

Write-Line "[EXITWATCH-START] tracking all '$appName' processes -> $logPath"

# pid -> @{ Proc; Role }
$tracked = @{}

while ($true) {
    # --- discover ---
    $live = Get-CimInstance Win32_Process -Filter "Name='$appName.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $live) {
        $processId = [int]$p.ProcessId
        if ($tracked.ContainsKey($processId)) { continue }
        $role = Get-Role $p.CommandLine
        if ($role -eq 'codex-guard') { continue }
        try {
            $proc = Get-Process -Id $processId -ErrorAction Stop
            # Retain the kernel handle NOW, while it is still alive. This also
            # pins the PID, so it cannot be recycled underneath us.
            $null = $proc.Handle
        } catch {
            continue
        }
        $tracked[$processId] = @{ Proc = $proc; Role = $role }
        Write-Line "[ATTACHED] pid=$processId role=$role"
    }

    # --- reap ---
    foreach ($processId in @($tracked.Keys)) {
        $entry = $tracked[$processId]
        $proc = $entry.Proc
        $exited = $false
        try { $exited = $proc.HasExited } catch { $exited = $true }
        if (-not $exited) { continue }

        $code = $null
        try { $code = $proc.ExitCode } catch { $code = $null }
        $survivors = @($tracked.Keys | Where-Object { $_ -ne $processId } | ForEach-Object {
            $other = $tracked[$_]
            $alive = $false
            try { $alive = -not $other.Proc.HasExited } catch { $alive = $false }
            if ($alive) { "$($other.Role):$_" }
        })
        $survivorText = if ($survivors.Count -gt 0) { $survivors -join ',' } else { 'NONE' }

        if ($null -eq $code) {
            Write-Line "[EXIT] pid=$processId role=$($entry.Role) code=UNAVAILABLE (handle lost) stillAlive=$survivorText"
        } else {
            # `[uint32](-1 -band 0xFFFFFFFF)` yielded 0x00000000 in PowerShell 5.1,
            # so the 01:21 kill was logged as "clean exit (app.quit)" -- the exact
            # opposite of the truth, and it nearly cost another round of chasing an
            # imaginary in-app shutdown path. Reinterpret the bits instead.
            $hex = '0x{0:X8}' -f ([System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]$code), 0))
            $meaning = switch ($hex) {
                '0x00000000' { 'clean exit (app.quit)' }
                '0x00000001' { '*** taskkill.exe /F (exit code is hardcoded 1) ***' }
                # .NET Process.Kill() calls TerminateProcess(handle, -1), so this is
                # the signature of PowerShell Stop-Process -Force and of anything
                # else built on .NET -- NOT of taskkill.
                '0xFFFFFFFF' { '*** Stop-Process -Force / .NET Process.Kill() ***' }
                '0xC0000005' { '*** ACCESS VIOLATION - native crash ***' }
                '0xC0000017' { '*** STATUS_NO_MEMORY ***' }
                '0xC000009A' { '*** INSUFFICIENT RESOURCES ***' }
                '0xC00000FD' { '*** STACK OVERFLOW ***' }
                '0xC000012D' { '*** COMMIT LIMIT EXCEEDED ***' }
                '0xC0000409' { '*** STACK BUFFER OVERRUN / __fastfail ***' }
                '0xE0000008' { '*** V8 fatal / OOM abort ***' }
                default      { 'unmapped - look up this NTSTATUS' }
            }
            Write-Line "[EXIT] pid=$processId role=$($entry.Role) code=$code hex=$hex :: $meaning stillAlive=$survivorText"
        }
        $tracked.Remove($processId)
    }

    Start-Sleep -Milliseconds 500
}
