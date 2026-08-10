param(
  [int]$DurationSeconds = 60,
  [string]$OutDir = "$env:TEMP\cv-token-probe"
)

# 取证脚本：把「这段时间漏了多少内核令牌」与「同期系统创建了哪些进程」对齐，
# 用来判断 Toke 池膨胀到底是不是进程创建带来的。需要管理员（ETW 会话）。
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'need administrator' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$etl = Join-Path $OutDir 'kernel-process.etl'
$report = Join-Path $OutDir 'report.txt'
Remove-Item $etl, $report -ErrorAction SilentlyContinue

$poolScript = Join-Path $PSScriptRoot 'pool-tag-top.ps1'
function Get-PoolCounts {
  $s = & $poolScript 2>&1 | Out-String
  [pscustomobject]@{
    Toke = [int64][regex]::Match($s, 'Toke\s+[\d\.]+\s+\d+\s+(-?\d+)').Groups[1].Value
    TokeMb = [double][regex]::Match($s, 'Toke\s+([\d\.]+)').Groups[1].Value
    SeAt = [int64][regex]::Match($s, 'SeAt\s+[\d\.]+\s+\d+\s+(-?\d+)').Groups[1].Value
  }
}

$session = 'CVTokenProbe'
& logman stop $session -ets 2>$null | Out-Null

$before = Get-PoolCounts
$startedAt = Get-Date

# keyword 0x10 = WINEVENT_KEYWORD_PROCESS，只要进程生命周期事件，避免线程/镜像把 etl 撑爆
& logman create trace $session -p 'Microsoft-Windows-Kernel-Process' 0x10 0x4 -o $etl -ets -bs 64 -nb 32 128 | Out-Null
Start-Sleep -Seconds $DurationSeconds
& logman stop $session -ets | Out-Null

$after = Get-PoolCounts
$elapsed = ((Get-Date) - $startedAt).TotalSeconds

$lines = @()
$lines += "duration: $([math]::Round($elapsed,1)) s"
$lines += "Toke live: $($before.Toke) -> $($after.Toke)  (+$($after.Toke - $before.Toke))"
$lines += "Toke MB  : $($before.TokeMb) -> $($after.TokeMb)  (+$([math]::Round($after.TokeMb - $before.TokeMb,2)) MB)"
$lines += "SeAt live: $($before.SeAt) -> $($after.SeAt)  (+$($after.SeAt - $before.SeAt))"
$lines += "leak rate: $([math]::Round(($after.Toke - $before.Toke)/$elapsed,2)) tokens/sec"
$lines += ''

$events = @()
try {
  $events = @(Get-WinEvent -Path $etl -Oldest -ErrorAction Stop)
} catch {
  $lines += "etl read failed: $($_.Exception.Message)"
}

$starts = @($events | Where-Object { $_.Id -eq 1 })
$stops = @($events | Where-Object { $_.Id -eq 2 })
$lines += "process starts: $($starts.Count)   process stops: $($stops.Count)"
$tokenDelta = $after.Toke - $before.Toke
if ($starts.Count -gt 0) {
  $lines += "tokens leaked per process start: $([math]::Round($tokenDelta / $starts.Count, 2))"
}
$lines += ''
$lines += '=== process starts by image ==='
$starts |
  ForEach-Object {
    $x = [xml]$_.ToXml()
    ($x.Event.EventData.Data | Where-Object { $_.Name -eq 'ImageName' }).'#text'
  } |
  Group-Object |
  Sort-Object Count -Descending |
  Select-Object -First 25 |
  ForEach-Object { $lines += ("  {0,5}  {1}" -f $_.Count, (Split-Path $_.Name -Leaf)) }

$lines | Set-Content -Path $report -Encoding UTF8
$lines | ForEach-Object { $_ }
"report: $report"
