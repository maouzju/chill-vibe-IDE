param(
  [int]$IntervalSeconds = 30,
  [double]$AlertRatePerSec = 4.0
)

# 监控脚本：盯住内核令牌泄漏速率，只在明显高于背景时输出一行事件（含当时最活跃的进程）。
# 背景速率实测约 1.2/秒；16 天均值 7/秒，说明存在间歇性爆发，本脚本用于抓爆发现行。
$ErrorActionPreference = 'Continue'
$poolScript = Join-Path $PSScriptRoot 'pool-tag-top.ps1'

function Get-Toke {
  $s = & $poolScript 2>&1 | Out-String
  [int64][regex]::Match($s, 'Toke\s+[\d\.]+\s+\d+\s+(-?\d+)').Groups[1].Value
}

$prev = Get-Toke
$prevCpu = @{}
foreach ($p in Get-Process) { $prevCpu[$p.Id] = @{ N = $p.ProcessName; C = $p.CPU } }

while ($true) {
  Start-Sleep -Seconds $IntervalSeconds
  $cur = Get-Toke
  $delta = $cur - $prev
  $rate = $delta / $IntervalSeconds

  $curCpu = @{}
  foreach ($p in Get-Process) { $curCpu[$p.Id] = @{ N = $p.ProcessName; C = $p.CPU } }

  if ($rate -ge $AlertRatePerSec) {
    $busy = foreach ($id in $curCpu.Keys) {
      $c = $curCpu[$id].C
      $b = if ($prevCpu.ContainsKey($id)) { $prevCpu[$id].C } else { 0 }
      if ($null -eq $c) { continue }
      $used = $c - $b
      if ($used -gt 0.5) { [pscustomobject]@{ Name = $curCpu[$id].N; Cpu = [math]::Round($used, 1) } }
    }
    $top = ($busy | Sort-Object Cpu -Descending | Select-Object -First 6 |
      ForEach-Object { "$($_.Name):$($_.Cpu)s" }) -join ' '
    "[$(Get-Date -Format 'HH:mm:ss')] LEAK BURST rate=$([math]::Round($rate,1))/s delta=$delta live=$cur busy=[$top]"
  }

  $prev = $cur
  $prevCpu = $curCpu
}
