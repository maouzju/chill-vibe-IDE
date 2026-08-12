param(
  [Parameter(Mandatory = $true)][string]$Suspect,
  [int]$MeasureSeconds = 90
)

# 取证脚本：停掉一个可疑组件，对比停止前后的内核令牌泄漏速率，用二分法定位泄漏源。
# 背景速率实测约 1.2/秒。停掉后若速率塌到接近 0，即为元凶；否则恢复并换下一个嫌疑。
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\kill-guard.ps1')
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
# 症状：2026-08-12 凌晨查清，用户的 Chill Vibe 被脚本用 Stop-Process 杀掉后，现场
#       （无关闭日志、无事件、无 dump）与"神秘闪退"完全一致，退出码 -1 是 .NET
#       Process.Kill 的签名，而 taskkill 是 1。
# 根因：这里用 `-match $Suspect` 对进程名做正则子串匹配。08-10 排查内核令牌泄漏时
#       这个脚本跑过多轮，任何偏宽的 suspect 都会顺带匹配到用户正在用的应用。
# 为什么不能换写法：本脚本必须停掉"早于自己存在"的组件，所以 kill-guard 的快照判据
#       不适用；能兜住的只有硬性拒杀名单 + 精确名匹配。
$procs = Get-Process | Where-Object { $_.ProcessName -match $Suspect }
foreach ($p in $procs) {
  if (Test-ProtectedProcessName -Name $p.ProcessName) {
    $out += "REFUSED to kill protected process $($p.ProcessName) (pid $($p.Id)) -- widen `$Suspect deliberately if this was intended"
    continue
  }
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
