param(
  [Parameter(Mandatory = $true)][string]$Suspect,
  [int]$MeasureSeconds = 90
)

# 取证脚本：停掉一个可疑组件，对比停止前后的内核令牌泄漏速率，用二分法定位泄漏源。
# 背景速率实测约 1.2/秒。停掉后若速率塌到接近 0，即为元凶；否则恢复并换下一个嫌疑。
$ErrorActionPreference = 'Continue'
$poolScript = Join-Path $PSScriptRoot 'pool-tag-top.ps1'
$logPath = Join-Path $env:TEMP 'cv-token-bisect.txt'

function Get-Toke {
  $s = & $poolScript 2>&1 | Out-String
  [int64][regex]::Match($s, 'Toke\s+[\d\.]+\s+\d+\s+(-?\d+)').Groups[1].Value
}

function Measure-Rate {
  param([string]$Label, [int]$Seconds)
  $a = Get-Toke
  Start-Sleep -Seconds $Seconds
  $b = Get-Toke
  $rate = ($b - $a) / $Seconds
  "$Label : $a -> $b  delta=$($b-$a)  rate=$([math]::Round($rate,2))/s"
  return $rate
}

$out = @()
$out += "suspect: $Suspect"
$before = Measure-Rate -Label 'BEFORE (suspect running)' -Seconds $MeasureSeconds
$out += "BEFORE rate: $([math]::Round($before,2))/s"

$stopped = @()
$svc = Get-Service | Where-Object { $_.Name -match $Suspect -and $_.Status -eq 'Running' }
foreach ($s in $svc) {
  try { Stop-Service -Name $s.Name -Force -ErrorAction Stop; $stopped += "service:$($s.Name)"; $out += "stopped service $($s.Name)" }
  catch { $out += "stop service $($s.Name) failed: $($_.Exception.Message)" }
}
$procs = Get-Process | Where-Object { $_.ProcessName -match $Suspect }
foreach ($p in $procs) {
  $path = $p.Path
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $stopped += "proc:$($p.ProcessName)|$path"; $out += "killed $($p.ProcessName) (pid $($p.Id)) path=$path" }
  catch { $out += "kill $($p.ProcessName) failed: $($_.Exception.Message)" }
}

Start-Sleep -Seconds 5
$after = Measure-Rate -Label 'AFTER (suspect stopped)' -Seconds $MeasureSeconds
$out += "AFTER rate: $([math]::Round($after,2))/s"
$out += ''
$drop = if ($before -ne 0) { (1 - ($after / $before)) * 100 } else { 0 }
$out += "rate drop: $([math]::Round($drop,1))%"
$out += "verdict: $(if ($after -lt 0.3 -and $before -gt 0.8) { 'SUSPECT CONFIRMED' } elseif ($drop -gt 60) { 'LIKELY' } else { 'NOT THE SOURCE' })"
$out += ''
$out += 'stopped items (for manual restore):'
$stopped | ForEach-Object { $out += "  $_" }

$out | Set-Content -Path $logPath -Encoding UTF8
$out | ForEach-Object { $_ }
"log: $logPath"
