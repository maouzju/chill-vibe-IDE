# 一次性取证脚本（不进测试清单）：用用户手上的打包版验证"自动化看板退出重进就清空"。
#
# 做法：先用 repro-automation-board-persistence.ts 在一个**隔离**数据目录里生成一份
# 含看板卡 + 一个待命项的 state.json，然后用打包版加载它、活一会儿、正常退出，
# 再看盘上的看板卡还在不在。
#
# 安全：只操作自己 Start-Process 出来的那个 PID，绝不碰用户正在用的实例
# （pitfall：verify-crash-relaunch.ps1 曾误杀用户实例）。

param([string]$Exe)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repo '.tmp-board-packaged'
# 打包版装在一个中文路径下，而 Windows PowerShell 5.1 会用 ANSI 代码页解码这个
# UTF-8 脚本文件，硬编码路径必然乱码。改成从已在跑的实例读它自己的可执行路径。
$exe = $Exe
if (-not $exe) {
  $running = Get-Process | Where-Object { $_.ProcessName -like '*hill*Vibe*' -and $_.Path } | Select-Object -First 1
  if ($running) { $exe = $running.Path }
}

if (-not $exe -or -not (Test-Path $exe)) { throw "packaged exe not found (is Chill Vibe running?)" }
Write-Host "      packaged exe: $exe" -ForegroundColor Gray

if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir }
New-Item -ItemType Directory -Force $dataDir | Out-Null

Write-Host '[1/5] seeding a state.json that contains a board card + one standby item' -ForegroundColor Cyan
$env:CHILL_VIBE_DATA_DIR = $dataDir
& node --import tsx (Join-Path $repo 'scripts/repro-automation-board-persistence.ts') | Out-Null

$stateFile = Join-Path $dataDir 'state.json'
$before = (Get-Content $stateFile -Raw -Encoding UTF8)
$beforeHits = ([regex]::Matches($before, '__automationboard_tool__')).Count
Write-Host "      seeded: board token occurrences = $beforeHits" -ForegroundColor Gray

Write-Host '[2/5] launching the packaged app against that isolated data dir' -ForegroundColor Cyan
$env:CHILL_VIBE_ALLOW_SHARED_DATA_DIR = '1'
$env:CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK = '1'
$env:CHILL_VIBE_DISABLE_CRASH_RECOVERY = '1'

$proc = Start-Process -FilePath $exe -PassThru
Write-Host "      pid = $($proc.Id)" -ForegroundColor Gray

Write-Host '[3/5] letting it run for 35s so hydration + at least one save happen' -ForegroundColor Cyan
Start-Sleep -Seconds 35

Write-Host '[4/5] closing only that instance' -ForegroundColor Cyan
$live = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($live -and $live.Path -eq $exe) {
  $live.CloseMainWindow() | Out-Null
  Start-Sleep -Seconds 6
  $still = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  if ($still) { Stop-Process -Id $proc.Id -Force }
}
Start-Sleep -Seconds 3

Write-Host '[5/5] reading the state back' -ForegroundColor Cyan
$after = (Get-Content $stateFile -Raw -Encoding UTF8)
$afterHits = ([regex]::Matches($after, '__automationboard_tool__')).Count
Write-Host "      after restart: board token occurrences = $afterHits"
if ($afterHits -ge 1) {
  Write-Host 'RESULT: board card SURVIVED the packaged round trip' -ForegroundColor Green
} else {
  Write-Host 'RESULT: board card WAS WIPED by the packaged app' -ForegroundColor Red
}
& node (Join-Path $repo 'scripts/inspect-board-state.mjs') $stateFile
