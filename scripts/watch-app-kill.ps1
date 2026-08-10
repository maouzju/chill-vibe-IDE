# Real-time capture for the "window just vanishes" crashes.
#
# Why this exists: post-mortem forensics came back completely empty. A normal
# shutdown writes 6 lines (close requested -> before-quit -> closed -> will-quit
# -> process exit -> quit). The hard deaths write NONE of them, and there is no
# minidump and no Windows event. That combination means the process is being
# killed with TerminateProcess from outside, so the only way to learn who did it
# is to be watching at the moment it happens.
#
# Leading hypothesis: PID reuse. This box creates 2.5-5 processes/second, so
# Windows recycles PIDs fast. A tool that recorded a PID earlier and runs
# `taskkill /PID <pid> /T /F` later can hit whatever now owns that number.
# The decisive evidence is therefore a taskkill whose target PID is, at that
# instant, one of Chill Vibe's own processes -- so we diff against a live set.
#
# stdout events:
#   [KILL-HIT]       *** taskkill targeted a live Chill Vibe pid -- smoking gun
#   [KILL-ANCESTOR]  taskkill targeted a process Chill Vibe descends from
#   [APP-VANISHED]   every Chill Vibe process disappeared
#   [SUSPECT-SPAWN]  a kill-capable command was launched (target unresolved)
#   [APP-MAIN-NEW]   a NEW top-level Chill Vibe main process appeared (restart)

$ErrorActionPreference = 'Continue'
$appName = 'Chill Vibe'
$suspectPattern = 'taskkill|Stop-Process|tskill|pskill|electron-builder|build-timestamped-release'

$query = "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'"
Register-CimIndicationEvent -Query $query -SourceIdentifier AppKillWatch -ErrorAction Stop

# Live map of every Chill Vibe pid -> its parent, refreshed each tick.
function Get-AppMap {
    $map = @{}
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='$appName.exe'" -ErrorAction SilentlyContinue)) {
        $map[[int]$p.ProcessId] = [int]$p.ParentProcessId
    }
    return $map
}

# Everything Chill Vibe hangs off of. A /T kill on any of these takes the app
# down as collateral, which looks identical to a crash from the inside.
function Get-AncestorSet($map) {
    $set = @{}
    # NOTE: not $pid -- that is a PowerShell automatic read-only variable and
    # assigning to it throws VariableNotWritable, which silently left the
    # ancestor set empty on the first run of this watcher.
    foreach ($appPid in $map.Keys) {
        $cur = $map[$appPid]
        for ($i = 0; $i -lt 8 -and $cur -gt 4; $i++) {
            if ($map.ContainsKey($cur)) { $cur = $map[$cur]; continue }
            $set[$cur] = $true
            $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
            if (-not $pp) { break }
            $cur = [int]$pp.ParentProcessId
        }
    }
    return $set
}

$appMap = Get-AppMap
$ancestors = Get-AncestorSet $appMap
$mainPids = @($appMap.Keys | Where-Object { -not $appMap.ContainsKey($appMap[$_]) })
"[WATCH-START] $(Get-Date -Format 'HH:mm:ss') tracking $($appMap.Count) pids, main=$($mainPids -join ','), ancestors=$($ancestors.Keys -join ',')"

while ($true) {
    $events = @(Get-Event -SourceIdentifier AppKillWatch -ErrorAction SilentlyContinue)
    foreach ($e in $events) {
        $p = $e.SourceEventArgs.NewEvent.TargetInstance
        $cmd = [string]$p.CommandLine
        $ts = Get-Date -Format 'HH:mm:ss'

        if ($p.Name -eq "$appName.exe") {
            # Only a parentless-within-the-app process is a real restart; Electron
            # spawns same-named children constantly and those are just noise.
            if (-not $appMap.ContainsKey([int]$p.ParentProcessId)) {
                "[APP-MAIN-NEW] $ts pid=$($p.ProcessId) -- app (re)started"
            }
            continue
        }

        if (-not $cmd -or $cmd -notmatch $suspectPattern) { continue }

        $parent = try { (Get-Process -Id $p.ParentProcessId -ErrorAction Stop).ProcessName } catch { 'gone' }
        $m = [regex]::Match($cmd, '/PID\s+(\d+)', 'IgnoreCase')
        if ($m.Success) {
            $target = [int]$m.Groups[1].Value
            if ($appMap.ContainsKey($target)) {
                "[KILL-HIT] $ts *** taskkill targeted LIVE Chill Vibe pid=$target (parent=$parent) :: $cmd"
            }
            elseif ($ancestors.ContainsKey($target)) {
                "[KILL-ANCESTOR] $ts *** taskkill targeted Chill Vibe ANCESTOR pid=$target (parent=$parent) :: $cmd"
            }
            else {
                $owner = try { (Get-Process -Id $target -ErrorAction Stop).ProcessName } catch { 'already-gone' }
                "[SUSPECT-SPAWN] $ts target=$target owner=$owner parent=$parent"
            }
        }
        else {
            if ($cmd.Length -gt 170) { $cmd = $cmd.Substring(0, 170) + '...' }
            "[SUSPECT-SPAWN] $ts parent=$parent :: $cmd"
        }
    }
    if ($events.Count -gt 0) { $events | Remove-Event -ErrorAction SilentlyContinue }

    $prevCount = $appMap.Count
    $appMap = Get-AppMap
    if ($prevCount -gt 0 -and $appMap.Count -eq 0) {
        "[APP-VANISHED] $(Get-Date -Format 'HH:mm:ss') all Chill Vibe processes gone"
    }
    if ($appMap.Count -gt 0 -and ($appMap.Count -ne $prevCount)) {
        $ancestors = Get-AncestorSet $appMap
    }

    Start-Sleep -Seconds 2
}
