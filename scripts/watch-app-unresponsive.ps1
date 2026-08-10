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
$ErrorActionPreference = 'SilentlyContinue'
$pollMs = 400

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

"UNRESPONSIVE-WATCH-START $(Get-Date -Format 'HH:mm:ss') poll=${pollMs}ms"

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
            "[ATTACH] $(Get-Date -Format 'HH:mm:ss') main pid=$mainPid"
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
            $cpuNow = Get-CpuMap
            $window = [math]::Max(0.001, $heldMs / 1000.0)
            $lines = @()
            foreach ($k in ($cpuNow.Keys | Sort-Object)) {
                $before = if ($cpuAtStuck.ContainsKey($k)) { $cpuAtStuck[$k] } else { $cpuNow[$k] }
                $burn = $cpuNow[$k] - $before
                # Percent of one core consumed during the freeze window.
                $pct = [math]::Round(($burn / $window) * 100, 0)
                $role = if ($k -eq $mainPid) { 'MAIN' } else { 'child' }
                $lines += "$role pid=$k cpu=${pct}%"
            }
            "[FROZEN] $(Get-Date -Format 'HH:mm:ss') held>=$([math]::Round($heldMs))ms :: $($lines -join ' | ')"
            "[WAIT]   $waits"
            # Attribute the burn to a specific renderer thread while it is still stuck.
            $hot = ($cpuNow.GetEnumerator() | Where-Object { $_.Key -ne $mainPid } |
                    Sort-Object { $_.Value - $(if ($cpuAtStuck.ContainsKey($_.Key)) { $cpuAtStuck[$_.Key] } else { $_.Value }) } -Descending |
                    Select-Object -First 1).Key
            if ($hot) { "[THREADS] hottest pid=$hot :: $(Get-TopThreads $hot 300)" }

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
                $role = if ($k -eq $mainPid) { 'MAIN' } else { 'child' }
                $ioLines += "$role pid=$k read=$([math]::Round($rMb,1))MB write=$([math]::Round($wMb,1))MB ops=$([math]::Round($ops))"
            }
            if ($ioLines.Count -gt 0) { "[IO]     $($ioLines -join ' | ')" } else { "[IO]     no app disk activity during freeze" }

            # System-wide disk pressure: if the app is idle but the queue is deep,
            # something ELSE on the machine is starving it.
            $q = (Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -eq '_Total' })
            if ($q) { "[DISK]   queue=$($q.CurrentDiskQueueLength) busy=$($q.PercentDiskTime)% readsPerSec=$($q.DiskReadsPerSec) writesPerSec=$($q.DiskWritesPerSec)" }

            # Every in-app explanation has now been ruled out by measurement: no CPU
            # anywhere, no disk queue, no app I/O. The one question never asked is
            # whether OTHER applications freeze at the same instant. If they do, this
            # is a machine-wide stall (kernel/DWM/driver) and no code change in this
            # repo can fix it. That distinction decides the entire investigation.
            $windowed = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $mainPid }
            $dead = @($windowed | Where-Object { -not $_.Responding })
            $names = ($dead | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ','
            if ($dead.Count -gt 0) {
                "[SYSTEM] *** $($dead.Count)/$($windowed.Count) OTHER apps frozen too -> MACHINE-WIDE STALL :: $names"
            } else {
                "[SYSTEM] other apps fine ($($windowed.Count) checked) -> freeze is specific to Chill Vibe"
            }
            $dwm = Get-Process -Name dwm -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($dwm) { "[DWM]    cpuSeconds=$([math]::Round($dwm.CPU,1)) threads=$($dwm.Threads.Count)" }

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
                    $encTxt = ($enc | ForEach-Object {
                        $eng = ($_.InstanceName -split '_engtype_')[-1]
                        $ownerPid = if ($_.InstanceName -match 'pid_(\d+)') { $matches[1] } else { '?' }
                        "$eng(pid$ownerPid)=$([math]::Round($_.CookedValue,0))%"
                    }) -join ' '
                    "[GPUENG] $encTxt"
                } else { "[GPUENG] no engine above 1%" }
            }
        }
        continue
    }

    if ($null -ne $stuckSince) {
        $totalMs = [math]::Round(((Get-Date) - $stuckSince).TotalMilliseconds)
        if ($totalMs -ge 1200) {
            "[THAWED] $(Get-Date -Format 'HH:mm:ss') froze for ${totalMs}ms"
        }
        $stuckSince = $null
        $cpuAtStuck = $null
        $reported = $false
    }
}
