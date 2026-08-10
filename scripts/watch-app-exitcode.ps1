# Capture the EXIT CODE of the Chill Vibe main process the instant it dies.
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

$ErrorActionPreference = 'Continue'
$appName = 'Chill Vibe'

function Get-MainProcess {
    $all = Get-CimInstance Win32_Process -Filter "Name='$appName.exe'" -ErrorAction SilentlyContinue
    if (-not $all) { return $null }
    $pids = @{}
    foreach ($p in $all) { $pids[[int]$p.ProcessId] = $true }
    # The main process is the only one whose parent is NOT another Chill Vibe.
    foreach ($p in $all) {
        if (-not $pids.ContainsKey([int]$p.ParentProcessId)) {
            return [int]$p.ProcessId
        }
    }
    return $null
}

"[EXITWATCH-START] $(Get-Date -Format 'HH:mm:ss') waiting for main process"

$lastPid = 0
while ($true) {
    $mainPid = Get-MainProcess
    if (-not $mainPid) { Start-Sleep -Seconds 2; continue }

    if ($mainPid -eq $lastPid) { Start-Sleep -Seconds 2; continue }
    $lastPid = $mainPid

    try {
        $proc = Get-Process -Id $mainPid -ErrorAction Stop
        # Retain the kernel handle NOW, while it is still alive.
        $null = $proc.Handle
    } catch {
        Start-Sleep -Seconds 2
        continue
    }

    "[ATTACHED] $(Get-Date -Format 'HH:mm:ss') main pid=$mainPid"

    $proc.WaitForExit()

    $code = try { $proc.ExitCode } catch { $null }
    $ts = Get-Date -Format 'HH:mm:ss'
    if ($null -eq $code) {
        "[EXIT] $ts pid=$mainPid code=UNAVAILABLE (handle lost)"
    } else {
        $hex = '0x{0:X8}' -f ([uint32]($code -band 0xFFFFFFFF))
        $meaning = switch ($hex) {
            '0x00000000' { 'clean exit (app.quit)' }
            '0x00000001' { 'TerminateProcess / taskkill' }
            '0xC0000005' { '*** ACCESS VIOLATION - native crash ***' }
            '0xC0000017' { '*** STATUS_NO_MEMORY ***' }
            '0xC00000FD' { '*** STACK OVERFLOW ***' }
            '0xC000012D' { '*** COMMIT LIMIT EXCEEDED ***' }
            '0xE0000008' { '*** V8 fatal / OOM abort ***' }
            default      { 'unmapped - look up this NTSTATUS' }
        }
        "[EXIT] $ts pid=$mainPid code=$code hex=$hex :: $meaning"
    }
    $lastPid = 0
}
