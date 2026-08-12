# Shared safety rail for every script in this repo that kills a process.
#
# 症状：2026-08-12 01:21，用户正在使用的 Chill Vibe 实例（pid 5960）突然消失。
#       main.log 停在 01:19:21 的心跳，之后没有 before-quit / will-quit /
#       window-all-closed 任何一条，没有 minidump，没有 Windows 事件 —— 与连日来
#       被当作"神秘闪退"的现场完全一致。取证器抓到的退出码是 -1。
# 根因：verify-crash-relaunch.ps1 的清理段落。它要找"守护进程拉起的新实例"，注释
#       写的是按隔离数据目录识别，代码却在排除几个已知项之后 `$revived = $c; break`
#       —— 抓到第一个就认。当时唯一符合的就是用户自己的实例，随后被 Stop-Process
#       -Force 杀掉。取证脚本本身就是事故来源。
# 指纹（这是分辨凶手的关键，别再混为一谈）：
#       exit 1  = taskkill.exe /F        （Win32 TerminateProcess，退出码硬编码 1）
#       exit -1 = Stop-Process -Force    （.NET Process.Kill → TerminateProcess(h, -1)）
#       exit 0  = 应用自己 app.quit()
# 为什么不能换写法：Windows 上 PID 会被回收复用；进程名不唯一（Codex 守卫进程用
#       process.execPath 当 node 运行时，与主应用同名同二进制）；命令行也可能完全
#       相同。唯一确定性的身份是 (PID, 进程创建时间) 二元组，再以脚本启动时刻作时间
#       下界。这与 electron/crash-relaunch-policy.ts 里主进程侧的存活判定是同一套
#       规则 —— 只认 PID 的判定正是我们在修的那个 bug。

# No Set-StrictMode here on purpose: this file is dot-sourced, and Set-StrictMode
# applies to the CALLER's scope, not this file's. An earlier revision set it to
# Latest and every host script blew up on its own pre-existing loose references --
# in verify-crash-relaunch.ps1 that left $killGuard unset, so the guarded cleanup
# silently did nothing. A safety rail that breaks its host is worse than none.

# Snapshot everything that already exists. Anything in here belongs to the user
# and is off-limits for the rest of the script's life.
function New-KillGuard {
    param(
        [string[]]$ProcessNames = @('Chill Vibe.exe'),
        [int[]]$AlwaysProtect = @()
    )

    $preexisting = @{}
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $all) {
        if ($ProcessNames -notcontains $p.Name) { continue }
        $preexisting[[int]$p.ProcessId] = $p.CreationDate
    }

    [pscustomobject]@{
        Preexisting   = $preexisting
        AlwaysProtect = @($AlwaysProtect)
        # A whole second of slack would let a process created in the same tick as
        # the guard slip through as "ours", so the bound is the exact timestamp.
        StartedAt     = (Get-Date)
        Killed        = [System.Collections.ArrayList]::new()
        Refused       = [System.Collections.ArrayList]::new()
    }
}

# Returns $null when the kill is allowed, or a human-readable refusal reason.
function Get-KillRefusal {
    param(
        [Parameter(Mandatory = $true)]$Guard,
        [Parameter(Mandatory = $true)][int]$ProcessId
    )

    if ($ProcessId -le 4) { return "pid $ProcessId is a system process" }
    if ($Guard.AlwaysProtect -contains $ProcessId) { return "pid $ProcessId is explicitly protected" }

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $proc) { return "pid $ProcessId no longer exists" }

    $created = $proc.CreationDate

    if ($Guard.Preexisting.ContainsKey($ProcessId)) {
        # Same PID AND same creation time => literally the process we snapshotted.
        # Same PID with a different creation time => the PID was recycled, and the
        # current occupant is a stranger we never meant to touch. Both are refusals.
        if ($Guard.Preexisting[$ProcessId] -eq $created) {
            return "pid $ProcessId existed before this script started (user's own process)"
        }
        return "pid $ProcessId was recycled since the snapshot -- different process now"
    }

    if ($created -lt $Guard.StartedAt) {
        return "pid $ProcessId was created at $created, before this script started at $($Guard.StartedAt)"
    }

    return $null
}

# Some scripts legitimately need to kill processes that predate them (the token
# leak bisector stops a suspect component to measure the effect). The snapshot
# rule cannot help there, so they get the other rail: a hard deny-list. A regex
# like `-match $Suspect` against process names is how a bisect run aimed at some
# unrelated service ends up matching 'Chill Vibe' and killing the user's editor.
$script:ProtectedProcessNames = @(
    'Chill Vibe', 'electron', 'claude', 'codex', 'node',
    'explorer', 'powershell', 'pwsh', 'cmd', 'conhost',
    'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss', 'svchost'
)

function Test-ProtectedProcessName {
    param([Parameter(Mandatory = $true)][string]$Name)
    $bare = $Name -replace '\.exe$', ''
    foreach ($protected in $script:ProtectedProcessNames) {
        if ($bare -eq $protected) { return $true }
    }
    return $false
}

function Test-KillAllowed {
    param(
        [Parameter(Mandatory = $true)]$Guard,
        [Parameter(Mandatory = $true)][int]$ProcessId
    )
    return $null -eq (Get-KillRefusal -Guard $Guard -ProcessId $ProcessId)
}

# The only sanctioned way for these scripts to kill anything.
function Stop-ProcessGuarded {
    param(
        [Parameter(Mandatory = $true)]$Guard,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [string]$Reason = ''
    )

    # Write-Host, not Write-Output: in PowerShell every uncaptured value a function
    # emits becomes part of its return value, so logging with Write-Output would
    # turn the $true/$false result into an array and silently break `if (...)` at
    # the call sites -- in a guard whose whole job is to be trusted.
    $refusal = Get-KillRefusal -Guard $Guard -ProcessId $ProcessId
    if ($refusal) {
        $null = $Guard.Refused.Add($refusal)
        Write-Host "  [kill-guard] REFUSED: $refusal"
        return $false
    }

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        $null = $Guard.Killed.Add($ProcessId)
        Write-Host "  [kill-guard] killed pid $ProcessId $Reason"
        return $true
    } catch {
        Write-Host "  [kill-guard] kill pid $ProcessId failed: $($_.Exception.Message)"
        return $false
    }
}
