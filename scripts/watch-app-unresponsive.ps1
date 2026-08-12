# Catch the "window froze for a few seconds" event from OUTSIDE the app.
#
# Why external: every in-app channel has already come back empty. Across 7 days
# of main.log the BrowserWindow 'unresponsive' event fired ZERO times and the
# frame-stall watchdog fired ZERO times, yet the user observes multi-second
# freezes. Electron's 'unresponsive' is the MAIN process asking the RENDERER if
# it is alive -- so it is structurally blind to the main process blocking on
# itself, which is exactly the case that leaves no log line anywhere.
#
# Windows tracks this independently: Process.Responding is false when the window
# owning the message pump has not serviced its queue. That works no matter which
# process is stuck and needs no code change or repackage.
#
# The decisive part is the snapshot taken WHILE it is stuck. CPU deltas separate
# the three explanations that all look identical from the user's chair:
#   main process CPU climbing      -> main process is running sync work (Zod parse of AppState, etc.)
#   renderer child CPU climbing    -> renderer main thread is blocked in JS
#   nobody burning CPU             -> blocked on I/O or a lock, not compute
#
# 症状：2026-08-12 10:40:53 主进程带退出码 0xCFFFFFFF 消失，被读成"闪退"。那个码是
#       Windows 结束「窗口无响应」进程时写的，也就是说闪退其实是卡死的后果。
# 根因：本脚本从 08-10 17:53 起一直在跑，也确实抓到了 10~19 秒的冻结，但它只写
#       stdout —— 启动它的那个 shell 一结束，管道就断了，08-10 18:18 之后两天的
#       冻结证据一条没留下。取证器本身成了证据链上最先断的那一环。
# 为什么不能换写法：这个 watcher 的价值全在「事故发生时它正好在跑」，而这决定了它
#       必然跑在一个没人盯着的后台进程里。所以输出必须落盘，不能依赖任何人接住
#       stdout。冻结当下还要抓一份 minidump，因为主线程卡住时应用自己写不了日志。
$ErrorActionPreference = 'SilentlyContinue'
$pollMs = 400

$logPath = Join-Path $PSScriptRoot '..\logs\app-unresponsive.log'
$logDir = Split-Path -Parent $logPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Line([string]$text) {
    Write-Output $text
    Add-Content -Path $logPath -Value $text -Encoding UTF8
}

# 冻结当下的 minidump 是唯一能回答"主线程停在哪个模块"的证据；应用自己那时正卡着，
# 写不了任何日志。落到 crash-dumps\reports 下，scripts/analyze-native-hang-dump.mjs
# 不带参数就会挑最新的那份解析。
$dumpDir = Join-Path $env:APPDATA 'chill-vibe-ide\data\crash-dumps\reports'
$lastDumpAt = [datetime]::MinValue
$dumpCooldownMinutes = 5
$maxDumps = 12

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChillVibeMiniDumper {
    [DllImport("dbghelp.dll", SetLastError = true)]
    public static extern bool MiniDumpWriteDump(
        IntPtr hProcess, uint processId, IntPtr hFile, int dumpType,
        IntPtr exceptionParam, IntPtr userStreamParam, IntPtr callbackParam);
}
'@

function Save-HangDump([int]$targetPid, [string]$label = 'main', [switch]$IgnoreCooldown) {
    if (-not $IgnoreCooldown -and ((Get-Date) - $lastDumpAt).TotalMinutes -lt $dumpCooldownMinutes) { return 'skipped (cooldown)' }
    if (-not (Test-Path $dumpDir)) { New-Item -ItemType Directory -Path $dumpDir -Force | Out-Null }
    $existing = @(Get-ChildItem -Path $dumpDir -Filter 'hang-*.dmp' -ErrorAction SilentlyContinue)
    if ($existing.Count -ge $maxDumps) { return "skipped ($maxDumps dumps already on disk)" }

    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $proc) { return 'skipped (process gone)' }

    $file = Join-Path $dumpDir ("hang-$label-$targetPid-{0}.dmp" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        $stream = [System.IO.File]::Create($file)
        try {
            # MiniDumpWithThreadInfo(0x1000) 之上就是 MiniDumpNormal：线程列表 + 栈内存 +
            # 模块列表，足够按模块归因每个线程停在哪，体积只有几 MB。不取 full dump ——
            # Electron 主进程的 full dump 是几百 MB，抓几次就把盘塞满，反而没人敢开着。
            $ok = [ChillVibeMiniDumper]::MiniDumpWriteDump(
                $proc.Handle, [uint32]$targetPid, $stream.SafeFileHandle.DangerousGetHandle(),
                0x1000, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
        } finally { $stream.Close() }
        if (-not $ok) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Remove-Item $file -Force -ErrorAction SilentlyContinue
            return "FAILED (win32 error $err)"
        }
        $script:lastDumpAt = Get-Date
        $sizeMb = [math]::Round((Get-Item $file).Length / 1MB, 1)
        return "$file (${sizeMb}MB)"
    } catch {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
        return "FAILED ($($_.Exception.Message))"
    }
}

function Get-MainPid {
    $all = Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'"
    if (-not $all) { return 0 }
    $owned = @{}
    foreach ($p in $all) { $owned[[int]$p.ProcessId] = $true }
    foreach ($p in $all) {
        # The main process is the only one whose parent is not itself a Chill Vibe process.
        if (-not $owned.ContainsKey([int]$p.ParentProcessId)) { return [int]$p.ProcessId }
    }
    return [int]$all[0].ProcessId
}

# CPU seconds for every process in the app tree, keyed by pid.
function Get-CpuMap {
    $map = @{}
    foreach ($p in (Get-Process -Name 'Chill Vibe')) {
        $map[[int]$p.Id] = [double]$p.TotalProcessorTime.TotalSeconds
    }
    return $map
}

# 症状：2026-08-12 12:30 抓到一次 49.6 秒的冻结，现场是 renderer 75% + GPU 104% +
#       renderer 向 GPU 写 7MB，而主进程 CPU 0%、主线程停在内核 Wait。同一天早些时候
#       实测过「一次 git spawn 就能占住主线程 6.8 秒」，两者在日志里长得一模一样：
#       都是「主进程 CPU 0% + 主线程 Wait」。
# 根因：判据缺了最关键的一条 —— 冻结当下应用到底有没有在派生子进程。有 git/CLI 在跑
#       就是 spawn 阻塞（libuv 在 Windows 上同步执行 CreateProcessW）；没有却在往 GPU
#       灌数据，就是渲染管线卡住，两者的修法完全相反。
# 为什么不能换写法：子进程存在时间常常只有几百毫秒，事后查不到；必须在冻结当下采样。
function Get-SpawnedChildren([int]$rootPid) {
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    if (-not $all) { return 'n/a' }
    $appPids = @{}
    foreach ($p in $all) { if ($p.Name -eq 'Chill Vibe.exe') { $appPids[[int]$p.ProcessId] = $true } }

    $rows = @()
    foreach ($p in $all) {
        if ($p.Name -eq 'Chill Vibe.exe') { continue }
        if (-not $appPids.ContainsKey([int]$p.ParentProcessId)) { continue }
        $ageMs = try { ((Get-Date) - $p.CreationDate).TotalMilliseconds } catch { -1 }
        $rows += "$($p.Name)(pid$($p.ProcessId),age$([math]::Round($ageMs))ms)"
    }
    if ($rows.Count -eq 0) { return 'NONE -> 冻结期间没有子进程在跑，spawn 阻塞被排除' }
    return "$($rows.Count) 个 :: $($rows -join ' ')"
}

# 症状：现场记的是 "child pid=76068 read=4.2MB | child pid=78836 write=4.2MB"，两条
#       调查线索为此分成两派（渲染进程收大 IPC vs CLI 子进程往 stdout 写），谁也没法
#       从日志里判掉对方 —— 因为 pid 不带角色，事后进程早没了，无从回查。
# 根因：app 的所有子进程都叫 "Chill Vibe.exe"，角色只写在命令行的 --type= 里，而且
#       CLI 会复用同一个 exe 当 node 运行时，所以"没有 --type=" 也不等于就是主进程。
# 为什么不能换写法：必须在冻结当下取，进程一退命令行就查不到了。
function Get-RoleMap {
    $map = @{}
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue)) {
        $cmd = [string]$p.CommandLine
        $role = if ($cmd -match '--type=([a-zA-Z\-]+)') { $Matches[1] }
                elseif ($cmd -match 'codex-destructive-command-guard') { 'codex-guard' }
                elseif ($cmd -match '\.(m?js|cjs)\b') { 'node-runtime(CLI)' }
                else { 'main-or-guard' }
        $map[[int]$p.ProcessId] = $role
    }
    return $map
}

# The first FROZEN capture (17:09, 1339ms) showed the main process at 0% CPU
# while the window was dead -- it is not computing, it is BLOCKED. CPU deltas
# cannot distinguish the remaining causes, but the OS thread wait reason can:
#   Executive / PageIn      -> blocked on synchronous disk I/O
#   LpcReceive / LpcReply   -> blocked waiting on ANOTHER process to answer a sync call
#   UserRequest             -> blocked on a wait handle in our own code (lock/sync primitive)
#   FreePage / VirtualMemory-> blocked on the memory manager
# The main thread is the one that owns the message pump, i.e. the oldest thread.
function Get-ThreadWaitSummary([int]$targetPid) {
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $proc) { return 'no-process' }

    $counts = @{}
    $mainThread = $null
    foreach ($t in $proc.Threads) {
        # WaitReason throws unless the thread is actually in the Wait state.
        $state = [string]$t.ThreadState
        $reason = if ($state -eq 'Wait') {
            try { [string]$t.WaitReason } catch { 'unknown' }
        } else { '-' }
        $key = "$state/$reason"
        if ($counts.ContainsKey($key)) { $counts[$key]++ } else { $counts[$key] = 1 }

        try {
            if ($null -eq $mainThread -or $t.StartTime -lt $mainThread.StartTime) { $mainThread = $t }
        } catch { }
    }

    $top = ($counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 4 |
            ForEach-Object { "$($_.Key)x$($_.Value)" }) -join ' '

    $mainDesc = 'main-thread=?'
    if ($mainThread) {
        $ms = [string]$mainThread.ThreadState
        $mr = if ($ms -eq 'Wait') { try { [string]$mainThread.WaitReason } catch { 'unknown' } } else { '-' }
        $mainDesc = "MAIN-THREAD tid=$($mainThread.Id) $ms/$mr"
    }
    return "$mainDesc :: threads($($proc.Threads.Count)) $top"
}

# Capture 17:15 showed GPU 32% + renderer 30% burning while the main process sat
# at 0% -- so the freeze lives in the render/composite pipeline, not in main. The
# next fork is which THREAD of the renderer burns it, because the fix differs:
#   hottest thread == oldest thread -> CrRendererMain, i.e. a long synchronous JS task
#   hottest thread != oldest thread -> compositor/raster, i.e. graphics work per frame
# Thread names are not exposed on Windows, but the renderer main thread is always
# the first one created, so StartTime ordering identifies it reliably.
function Get-TopThreads([int]$targetPid, [int]$sampleMs) {
    $p1 = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $p1) { return 'gone' }

    $before = @{}
    $oldestId = $null
    $oldestAt = $null
    foreach ($t in $p1.Threads) {
        try {
            $before[[int]$t.Id] = [double]$t.TotalProcessorTime.TotalSeconds
            if ($null -eq $oldestAt -or $t.StartTime -lt $oldestAt) { $oldestAt = $t.StartTime; $oldestId = [int]$t.Id }
        } catch { }
    }

    Start-Sleep -Milliseconds $sampleMs
    $p2 = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $p2) { return 'gone' }

    $window = $sampleMs / 1000.0
    $rows = @()
    foreach ($t in $p2.Threads) {
        try {
            $id = [int]$t.Id
            if (-not $before.ContainsKey($id)) { continue }
            $burn = [double]$t.TotalProcessorTime.TotalSeconds - $before[$id]
            if ($burn -le 0) { continue }
            $rows += [pscustomobject]@{ Id = $id; Pct = [math]::Round(($burn / $window) * 100, 0) }
        } catch { }
    }

    if ($rows.Count -eq 0) { return "no-thread-burn (oldest tid=$oldestId)" }
    $top = ($rows | Sort-Object Pct -Descending | Select-Object -First 3 | ForEach-Object {
        $tag = if ($_.Id -eq $oldestId) { '<<MAIN-THREAD(JS)' } else { '' }
        "tid=$($_.Id) $($_.Pct)%$tag"
    }) -join ' '
    return $top
}

# Disk I/O per process. The freezes show 0% CPU on main, which rules out compute
# but is exactly what blocking I/O looks like. The packaged data dir holds 9179
# session-history sidecars (1 GB) and state-store.ts:205 rewrites every "full"
# entry through an unbounded Promise.all on each save, so a save storm is the
# leading suspect for the wait.
function Get-IoMap {
    $map = @{}
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue)) {
        $map[[int]$p.ProcessId] = @{
            R = [double]$p.ReadTransferCount
            W = [double]$p.WriteTransferCount
            O = [double]($p.ReadOperationCount + $p.WriteOperationCount)
        }
    }
    return $map
}

Write-Line "UNRESPONSIVE-WATCH-START $(Get-Date -Format 'MM-dd HH:mm:ss') poll=${pollMs}ms log=$logPath"

$mainPid = 0
$stuckSince = $null
$cpuAtStuck = $null
$reported = $false

while ($true) {
    Start-Sleep -Milliseconds $pollMs

    if ($mainPid -eq 0 -or -not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue)) {
        $newPid = Get-MainPid
        if ($newPid -ne 0 -and $newPid -ne $mainPid) {
            $mainPid = $newPid
            Write-Line "[ATTACH] $(Get-Date -Format 'MM-dd HH:mm:ss') main pid=$mainPid"
        }
        if ($mainPid -eq 0) { continue }
    }

    $proc = Get-Process -Id $mainPid -ErrorAction SilentlyContinue
    if (-not $proc) { $mainPid = 0; continue }
    if ($proc.MainWindowHandle -eq 0) { continue }

    if (-not $proc.Responding) {
        if ($null -eq $stuckSince) {
            $stuckSince = Get-Date
            $cpuAtStuck = Get-CpuMap
            $ioAtStuck = Get-IoMap
            $reported = $false
        }

        $heldMs = ((Get-Date) - $stuckSince).TotalMilliseconds
        # Report once per freeze, after ~0.8s, so a single dropped frame stays quiet.
        if (-not $reported -and $heldMs -ge 800) {
            $reported = $true
            $waits = Get-ThreadWaitSummary $mainPid
            $roles = Get-RoleMap
            $cpuNow = Get-CpuMap
            $window = [math]::Max(0.001, $heldMs / 1000.0)
            $lines = @()
            foreach ($k in ($cpuNow.Keys | Sort-Object)) {
                $before = if ($cpuAtStuck.ContainsKey($k)) { $cpuAtStuck[$k] } else { $cpuNow[$k] }
                $burn = $cpuNow[$k] - $before
                # Percent of one core consumed during the freeze window.
                $pct = [math]::Round(($burn / $window) * 100, 0)
                $role = if ($k -eq $mainPid) { 'MAIN' } elseif ($roles.ContainsKey($k)) { $roles[$k] } else { 'child' }
                $lines += "$role pid=$k cpu=${pct}%"
            }
            Write-Line "[FROZEN] $(Get-Date -Format 'MM-dd HH:mm:ss') held>=$([math]::Round($heldMs))ms :: $($lines -join ' | ')"
            Write-Line "[WAIT]   $waits"
            # 分流开关：冻结当下有没有 CLI 在流式输出。有 -> 嫌疑落在流式中继那条大 IPC；
            # 没有 -> 只剩「切 tab/改设置也会触发」的全量 state 存档往返。
            $roleTally = ($roles.Values | Group-Object | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '
            Write-Line "[ROLES]  $roleTally"
            # 分辨「spawn 阻塞」和「渲染管线卡住」的唯一硬判据。
            Write-Line "[SPAWN]  $(Get-SpawnedChildren $mainPid)"
            # 趁它还卡着抓栈。等它解冻再抓就只剩一个空闲的消息泵，什么也说明不了。
            # 主进程的栈只能告诉你"它在等"，等的是谁得看渲染进程 —— 12:30 那次冻结
            # renderer 烧 75% CPU 并向 GPU 写 7MB，光看主进程 dump 完全看不出来。
            $mainDump = Save-HangDump $mainPid 'main'
            Write-Line "[DUMP]   main:     $mainDump"
            if ($mainDump -notlike 'skipped*') {
                $rendererPid = ($roles.GetEnumerator() | Where-Object { $_.Value -eq 'renderer' } | Select-Object -First 1).Key
                if ($rendererPid) {
                    Write-Line "[DUMP]   renderer: $(Save-HangDump ([int]$rendererPid) 'renderer' -IgnoreCooldown)"
                }
            }
            # Attribute the burn to a specific renderer thread while it is still stuck.
            $hot = ($cpuNow.GetEnumerator() | Where-Object { $_.Key -ne $mainPid } |
                    Sort-Object { $_.Value - $(if ($cpuAtStuck.ContainsKey($_.Key)) { $cpuAtStuck[$_.Key] } else { $_.Value }) } -Descending |
                    Select-Object -First 1).Key
            if ($hot) { Write-Line "[THREADS] hottest pid=$hot :: $(Get-TopThreads $hot 300)" }

            # 17:33:45 froze 3s with EVERY process at ~0% CPU. Nothing was computing,
            # so the only remaining explanation is blocking I/O. Measure it directly.
            $ioNow = Get-IoMap
            $ioLines = @()
            foreach ($k in ($ioNow.Keys | Sort-Object)) {
                if (-not $ioAtStuck.ContainsKey($k)) { continue }
                $rMb = ($ioNow[$k].R - $ioAtStuck[$k].R) / 1MB
                $wMb = ($ioNow[$k].W - $ioAtStuck[$k].W) / 1MB
                $ops = $ioNow[$k].O - $ioAtStuck[$k].O
                if ($rMb -lt 0.05 -and $wMb -lt 0.05 -and $ops -lt 50) { continue }
                $role = if ($k -eq $mainPid) { 'MAIN' } elseif ($roles.ContainsKey($k)) { $roles[$k] } else { 'child' }
                $ioLines += "$role pid=$k read=$([math]::Round($rMb,1))MB write=$([math]::Round($wMb,1))MB ops=$([math]::Round($ops))"
            }
            if ($ioLines.Count -gt 0) { Write-Line "[IO]     $($ioLines -join ' | ')" } else { Write-Line "[IO]     no app disk activity during freeze" }

            # System-wide disk pressure: if the app is idle but the queue is deep,
            # something ELSE on the machine is starving it.
            $q = (Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -eq '_Total' })
            if ($q) { Write-Line "[DISK]   queue=$($q.CurrentDiskQueueLength) busy=$($q.PercentDiskTime)% readsPerSec=$($q.DiskReadsPerSec) writesPerSec=$($q.DiskWritesPerSec)" }

            # Every in-app explanation has now been ruled out by measurement: no CPU
            # anywhere, no disk queue, no app I/O. The one question never asked is
            # whether OTHER applications freeze at the same instant. If they do, this
            # is a machine-wide stall (kernel/DWM/driver) and no code change in this
            # repo can fix it. That distinction decides the entire investigation.
            $windowed = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $mainPid }
            $dead = @($windowed | Where-Object { -not $_.Responding })
            $names = ($dead | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ','
            if ($dead.Count -gt 0) {
                Write-Line "[SYSTEM] *** $($dead.Count)/$($windowed.Count) OTHER apps frozen too -> MACHINE-WIDE STALL :: $names"
            } else {
                Write-Line "[SYSTEM] other apps fine ($($windowed.Count) checked) -> freeze is specific to Chill Vibe"
            }
            $dwm = Get-Process -Name dwm -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($dwm) { Write-Line "[DWM]    cpuSeconds=$([math]::Round($dwm.CPU,1)) threads=$($dwm.Threads.Count)" }

            # Every freeze shows renderer->GPU bytes moving while the GPU process burns
            # 0% CPU: it accepted the frames but is not draining them. GameViewerServer
            # holds both hardware video-encode engines at ~25% each and installs a virtual
            # display adapter, which puts a screen-capture encoder inside the present path.
            # If encode utilization spikes exactly when the window dies, that is the cause
            # -- and it needs no process to be killed to prove.
            $gpuCounters = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
            if ($gpuCounters) {
                $enc = $gpuCounters.CounterSamples |
                       Where-Object { $_.InstanceName -match 'videoencode|videodecode|_3D' -and $_.CookedValue -gt 1 } |
                       Sort-Object CookedValue -Descending | Select-Object -First 4
                if ($enc) {
                    # 只记 pid 没用：12:30 那次录到 3d(pid124912)=91%，等回头查时进程早退了，
                    # 无从判断到底是自己的渲染管线还是别的程序在抢 GPU。当场解析进程名。
                    $encTxt = ($enc | ForEach-Object {
                        $eng = ($_.InstanceName -split '_engtype_')[-1]
                        $ownerPid = if ($_.InstanceName -match 'pid_(\d+)') { $matches[1] } else { '?' }
                        $ownerName = if ($ownerPid -ne '?') {
                            try { (Get-Process -Id ([int]$ownerPid) -ErrorAction Stop).ProcessName } catch { 'gone' }
                        } else { '?' }
                        "$eng($ownerName/pid$ownerPid)=$([math]::Round($_.CookedValue,0))%"
                    }) -join ' '
                    Write-Line "[GPUENG] $encTxt"
                } else { Write-Line "[GPUENG] no engine above 1%" }
            }
        }
        continue
    }

    if ($null -ne $stuckSince) {
        $totalMs = [math]::Round(((Get-Date) - $stuckSince).TotalMilliseconds)
        if ($totalMs -ge 1200) {
            Write-Line "[THAWED] $(Get-Date -Format 'MM-dd HH:mm:ss') froze for ${totalMs}ms"
        }
        $stuckSince = $null
        $cpuAtStuck = $null
        $reported = $false
    }
}
