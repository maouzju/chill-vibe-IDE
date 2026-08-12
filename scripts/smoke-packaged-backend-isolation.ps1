# 打包产物冒烟：确认后端真的活在 utilityProcess 里，而不只是 utility-host.js 躺在 asar 中。
#
# 症状（要防的）— 打包版启动后后端进程起不来，界面空白或所有数据操作静默失败；
#   本地开发一切正常，因为开发模式走的是另一条加载路径。
# 根因 — tsc 只编译显式入口 + 其 import 图，utility host 是被 fork 的第二入口，
#   漏配就不会产出；而"文件在 asar 里"只证明编译产出了，不证明 fork 起得来、RPC 通得了。
# 为什么不能直接开用户那份 — 单实例锁会把新包的启动请求转交给用户正在用的旧实例，
#   冒烟就变成什么都没验；故用独立数据目录 + CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK。

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Get-ChildItem -Path (Join-Path $projectRoot 'dist') -Directory -Filter 'release-*' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $releaseDir) {
    throw '没有找到 dist/release-* 产物，先跑 pnpm electron:build。'
}

$exePath = Join-Path $releaseDir.FullName 'win-unpacked\Chill Vibe.exe'
if (-not (Test-Path $exePath)) {
    throw "产物里没有可执行文件：$exePath"
}

$smokeDataDir = Join-Path ([System.IO.Path]::GetTempPath()) ('chill-vibe-smoke-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $smokeDataDir -Force | Out-Null
# 日志落点由 configureDesktopEnvironment 决定，不同版本挪过位置；写死路径会让冒烟
# 在"应用其实好好的"时候误报失败，所以递归找而不是假设。
function Find-MainLog {
    param([string]$Root)
    if (-not (Test-Path $Root)) { return $null }
    $hit = Get-ChildItem -Path $Root -Filter 'main.log' -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

$logPath = $null

Write-Host "产物   : $($releaseDir.Name)"
Write-Host "数据目录: $smokeDataDir"

# CHILL_VIBE_DATA_DIR 单独设是**无效的** —— resolveDesktopDataDir 只在
# allowConfiguredOverride 为真时才认它，否则静默回落到 userData/data，也就是用户的真实
# 数据目录。2026-08-12 就是漏了这一条，冒烟实例连上了用户正在用的 state.json。
$env:CHILL_VIBE_ALLOW_SHARED_DATA_DIR = '1'
$env:CHILL_VIBE_DATA_DIR = $smokeDataDir
$env:CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK = '1'
# 冒烟结束要 taskkill /F，而崩溃守卫会把强杀判成崩溃并立刻拉起一个新实例 —— 那个实例
# 不带上面这些环境变量，于是又跑回用户的数据目录上，且不受本脚本管辖。必须先关掉。
$env:CHILL_VIBE_DISABLE_CRASH_RECOVERY = '1'

$process = Start-Process -FilePath $exePath -PassThru
Write-Host "已启动 pid=$($process.Id)，等待后端就绪..."

# 只等这一个 pid 自己写出来的日志；超时判失败，不靠"看起来没报错"。
$deadline = (Get-Date).AddSeconds(90)
$startedAt = Get-Date
$ready = $false
$sawBackendFailure = $false
$isolationBroken = $false
# 隔离没生效时，被冒烟的实例会安静地跑在用户真实数据上并与用户实例抢写 state.json。
# 这比冒烟失败严重得多，所以一旦发现就立刻停，而不是等 90 秒超时。
$isolationProofSeconds = 25

while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
        Write-Host "进程提前退出，退出码 $($process.ExitCode)" -ForegroundColor Red
        break
    }

    $elapsed = ((Get-Date) - $startedAt).TotalSeconds
    $wroteSomething = @(Get-ChildItem -Path $smokeDataDir -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0
    if ($elapsed -gt $isolationProofSeconds -and -not $wroteSomething) {
        $isolationBroken = $true
        break
    }

    if (-not $logPath) {
        $logPath = Find-MainLog -Root $smokeDataDir
    }

    if ($logPath -and (Test-Path $logPath)) {
        $log = Get-Content -Path $logPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
        if ($log) {
            if ($log -match 'Backend process exited|backend host failed|Failed to start the backend') {
                $sawBackendFailure = $true
                break
            }
        }
    }

    # 就绪判据只认**一条只有目标链路走通才可能出现的证据**：一个 node.mojom.NodeService
    # 子进程。
    #
    # 症状（要防的）— 冒烟脚本本身变成下一个"开发模式跑得通"：它打印"通过"，而
    #   utility-host.js 根本没打进包。
    # 根因 — 原判据是 `Resource heartbeat`（另外三个字符串全仓根本不存在）。这行由
    #   `initCrashLogger()` 同步写出，数据全来自 os/process/app.getAppMetrics()，
    #   一个字节都不经过后端；而 main.ts 里 `initCrashLogger()` 排在
    #   `await backendHost.ensureBackend()` **之前**。fork 彻底失败它照样出现，
    #   于是脚本必然先命中它再 break —— 失败判据永远赛不过它。
    # 为什么不换成日志行 — 主进程目前没有任何"后端就绪"日志；与其为冒烟往产品里加一行
    #   log，不如直接看进程表：`utilityProcess.fork` 起的就是这个 sub-type
    #   （main.ts:224 serviceName='chill-vibe-backend'），它存在 = fork 成功 + 入口
    #   文件在 asar 里解析到了。这条证据无法被"日志时序"伪造。
    if (-not $process.HasExited) {
        $utilityChildren = @(
            Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -match 'node\.mojom\.NodeService' }
        )
        if ($utilityChildren.Count -gt 0) {
            $ready = $true
            break
        }
    }

    Start-Sleep -Milliseconds 500
}

# 只报"后端那一个"子进程。总子进程数是没有信息量的：Electron 本来就自带
# gpu / network / audio / crashpad 一堆，那个数字任何情况下都 > 0。
$backendChildren = @()
if (-not $process.HasExited) {
    $backendChildren = @(
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $($process.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match 'node\.mojom\.NodeService' }
    )
}

Write-Host ''
Write-Host "后端就绪   : $ready"
Write-Host "后端启动失败: $sawBackendFailure"
Write-Host "后端子进程 : $($backendChildren.Count) 个 node.mojom.NodeService$(if ($backendChildren.Count) { ' (pid ' + ($backendChildren.ProcessId -join ',') + ')' })"

Write-Host "日志文件   : $(if ($logPath) { $logPath } else { '(没找到 main.log)' })"

if (-not $ready) {
    Write-Host ''
    Write-Host '--- 数据目录实际内容（用于定位日志落点）---'
    Get-ChildItem -Path $smokeDataDir -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First 25 |
        ForEach-Object { Write-Host ('  ' + $_.FullName.Substring($smokeDataDir.Length)) }
}

if ($logPath -and (Test-Path $logPath)) {
    $backendLines = Select-String -Path $logPath -Pattern 'ackend' -Encoding UTF8 -ErrorAction SilentlyContinue |
        Select-Object -Last 8
    if ($backendLines) {
        Write-Host ''
        Write-Host '--- 日志里与后端相关的行 ---'
        $backendLines | ForEach-Object { Write-Host $_.Line }
    }
}

# 收尾：只杀自己启动的那棵树。用 pid + 启动时刻双判据，杜绝 pid 复用误伤用户实例
# （2026-08-12 的教训：取证脚本按名字杀，把用户正在用的实例干掉了）。
if (-not $process.HasExited) {
    $live = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($live -and $live.StartTime -eq $process.StartTime) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        Write-Host ''
        Write-Host "已清理 pid=$($process.Id)"
    }
}

if ($isolationBroken) {
    Write-Host ''
    Write-Host '数据目录隔离失败：冒烟实例没有写进临时目录，它很可能连上了用户的真实数据目录。' -ForegroundColor Red
    Write-Host '已终止该实例。请先确认 CHILL_VIBE_ALLOW_SHARED_DATA_DIR 生效，再重跑。' -ForegroundColor Red
    exit 2
}

if ($sawBackendFailure -or -not $ready) {
    # 失败时保留现场：删掉就只剩一个"失败"二字，下次还得从头复现一遍。
    Write-Host ''
    Write-Host "冒烟失败，现场保留在 $smokeDataDir" -ForegroundColor Red
    exit 1
}

Remove-Item -Path $smokeDataDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '冒烟通过：打包版后端在独立进程里正常起来了' -ForegroundColor Green
exit 0
