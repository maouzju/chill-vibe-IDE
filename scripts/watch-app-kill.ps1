# Real-time capture for the "window just vanishes" crashes.
#
# Why this exists: post-mortem forensics came back completely empty. A normal
# shutdown writes 6 lines (close requested -> before-quit -> closed -> will-quit
# -> process exit -> quit). The hard deaths write NONE of them, and there is no
# minidump and no Windows event. That combination means the process is being
# killed with TerminateProcess from outside, so the only way to learn who did it
# is to be watching at the moment it happens.
#
# Status 2026-08-12: this watcher sat armed for 1h47m across a real death and
# reported nothing, which is one of the three refutations that killed the
# original "a tool hits a recycled PID" hypothesis (Windows only frees a PID
# once the last handle to it closes, so a spawned child's PID is pinned).
# It is kept because a taskkill whose target PID is, at that instant, one of
# Chill Vibe's own processes would still be decisive evidence -- and because a
# silent run is itself a result. Read logs/app-exit-code.log first: the exit
# code names the weapon (1 = taskkill, -1 = Stop-Process/.NET Kill, 0 = self).
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
#
# Symptom: 2026-08-11 23:26 this watcher fired [KILL-ANCESTOR] on pid 87960,
# which read as a smoking gun. It was not: the app was untouched (heartbeat
# unbroken), 87960 was already dead when the kill landed, and the app's real
# ancestor chain is explorer -> svchost -> services -> wininit, which never
# contained 87960.
# Root cause: taking every "Chill Vibe.exe" as an app process swept in Codex's
# PreToolUse guard, which runs the app binary as a node host
# (server/codex-safety.ts:159). The guard's parent is a short-lived shell, so
# that shell got promoted into the ancestor set, and any taskkill aimed at it
# looked like a strike on the app's lineage.
# Why not just filter by command line: an exclude-list would still admit any
# future helper spawned the same way. Anchoring on the real main process and
# walking down to its descendants is closed by construction -- a process only
# counts as ours if it is the bare-exe main or descends from it.
function Get-AppMap {
    $all = @(Get-CimInstance Win32_Process -Filter "Name='$appName.exe'" -ErrorAction SilentlyContinue)

    $map = @{}
    foreach ($p in $all) {
        $c = [string]$p.CommandLine
        if ($c -match '^\s*"[^"]*\.exe"\s*$' -or $c -match '^\s*[^"\s]*\.exe\s*$') {
            $map[[int]$p.ProcessId] = [int]$p.ParentProcessId
        }
    }

    # Electron's own children (--type=renderer/gpu-process/utility/crashpad-handler)
    # hang off main; pull them in transitively. The guard never enters, because
    # its parent is a shell that is not in the map.
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in $all) {
            $id = [int]$p.ProcessId
            if ($map.ContainsKey($id)) { continue }
            $parentId = [int]$p.ParentProcessId
            if ($map.ContainsKey($parentId)) {
                $map[$id] = $parentId
                $changed = $true
            }
        }
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
            #
            # Symptom: on 2026-08-11 this printed 11 [APP-MAIN-NEW] lines in 40
            # minutes while main.log's heartbeat ran unbroken with not a single
            # "Crash logger initialized" -- every one was a false alarm, and the
            # noise buried the signals that matter (KILL-HIT / APP-VANISHED).
            # Root cause: Codex's PreToolUse guard (server/codex-safety.ts:159)
            # launches with ELECTRON_RUN_AS_NODE + process.execPath, and in a
            # packaged build execPath IS "Chill Vibe.exe". So the guard process
            # shares the app's image name, and its parent is the shell -- which
            # is exactly the "parent not inside the app" condition above.
            # Measured: 5 such processes caught in 100 seconds, every parent
            # already exited by the time we looked.
            # Why not match on the parent instead: requiring the parent to be
            # explorer.exe would drop real restarts, because the app is also
            # launched from a terminal or a debugger during development. The
            # only stable discriminator is the command line -- a genuine main
            # process is a bare exe invocation with no second argument, whereas
            # every helper (--type=renderer, a .js path run as node) carries one.
            $isBareLaunch = $cmd -match '^\s*"[^"]*\.exe"\s*$' -or $cmd -match '^\s*[^"\s]*\.exe\s*$'
            if ($isBareLaunch -and -not $appMap.ContainsKey([int]$p.ParentProcessId)) {
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
