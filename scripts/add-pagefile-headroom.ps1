# Adds a second pagefile on D: to raise the system Commit Limit without a reboot.
#
# Why: kernel token leak (Toke pool tag) has eaten ~27.6 GB of paged pool that
# cannot be reclaimed while the machine stays up. Raising the commit limit buys
# headroom so allocations keep succeeding until a reboot is convenient.
#
# Safety: E: keeps its existing 60 GB explicitly pinned before D: is added, so
# turning off automatic management can never shrink what is already there.
# Growing / adding a pagefile takes effect immediately; only shrinking or
# removing one needs a reboot.

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $PSScriptRoot 'pagefile-change.log'

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Get-CommitLimitGB {
    (Get-Counter '\Memory\Commit Limit').CounterSamples[0].CookedValue / 1GB
}

try {
    $before = Get-CommitLimitGB
    Write-Log ("BEFORE  CommitLimit = {0:N2} GB" -f $before)

    $cs = Get-WmiObject Win32_ComputerSystem
    if ($cs.AutomaticManagedPagefile) {
        $cs.AutomaticManagedPagefile = $false
        [void]$cs.Put()
        Write-Log "Disabled automatic pagefile management"
    } else {
        Write-Log "Automatic pagefile management already off"
    }

    # Pin E: at its current 60 GB so it survives the switch to manual mode.
    Set-WmiInstance -Class Win32_PageFileSetting `
        -Arguments @{ Name = 'E:\pagefile.sys'; InitialSize = 61440; MaximumSize = 61440 } `
        -PutType UpdateOrCreate | Out-Null
    Write-Log "Pinned E:\pagefile.sys at 60 GB (60 GB min / 60 GB max)"

    # Add 40 GB on D: (79 GB free, leaves ~39 GB slack).
    Set-WmiInstance -Class Win32_PageFileSetting `
        -Arguments @{ Name = 'D:\pagefile.sys'; InitialSize = 40960; MaximumSize = 40960 } `
        -PutType UpdateOrCreate | Out-Null
    Write-Log "Added D:\pagefile.sys at 40 GB"

    Write-Log "Waiting 15s for the kernel to materialise the new pagefile..."
    Start-Sleep -Seconds 15

    $after = Get-CommitLimitGB
    $delta = $after - $before
    Write-Log ("AFTER   CommitLimit = {0:N2} GB  (delta {1:+0.00;-0.00} GB)" -f $after, $delta)

    if ($delta -gt 1) {
        Write-Log "RESULT: SUCCESS - extra headroom is live, no reboot needed."
    } else {
        Write-Log "RESULT: PENDING - limit unchanged; the new pagefile likely needs a reboot to take effect."
        Write-Log "        Nothing was shrunk, so the machine is no worse off than before."
    }

    Write-Log "Current pagefile settings:"
    Get-WmiObject Win32_PageFileSetting |
        ForEach-Object { Write-Log ("  {0}  init={1} MB  max={2} MB" -f $_.Name, $_.InitialSize, $_.MaximumSize) }
}
catch {
    Write-Log ("ERROR: " + $_.Exception.Message)
    exit 1
}
