# 受控实验：让一个隔离实例的窗口真正卡住，再按「结束无响应的程序」把它收掉，
# 记录它留下的退出码。用来确认 0xCFFFFFFF 到底是不是 hang-kill 的签名。
#
# 症状：2026-08-12 10:40:53 用户实例带 0xCFFFFFFF 消失，日志/事件/dump 三缺。这个码
#       此前从没在本仓库出现过，是靠查资料认成 "窗口无响应被结束"的 —— 而整条闪退
#       调查史上，靠推断而非实测下的结论已经被推翻过两次。
# 根因：没人验证过「窗口卡死后被结束」实际会留下什么退出码，也没验证过别的原因不会
#       留下同一个码。这个脚本产出参照样本，把那条因果链钉死。
# 为什么不能换写法：只能用真进程实测。挂起主线程是唯一能可靠制造「窗口不响应消息泵
#       但进程完全健康」这一精确状态的手段 —— 睡眠、死循环、断点都会改变别的变量。
#
# 安全：实例由本脚本自己启动，只操作本脚本记下的那个 PID，并且启动前做全量快照，
#       绝不碰用户正在用的实例。
#
# ===== 2026-08-12 实测结论（跑过一轮，结果是否定的，别再重走）=====
# 挂起主线程 4.5 秒后 IsHungAppWindow 就返回 TRUE，窗口确实卡死；但随后 EndTask(force)
# 给出的退出码是 **0**，不是 0xCFFFFFFF。
# 所以：**EndTask（任务管理器"结束任务"）不是 0xCFFFFFFF 的来源。** 那个码是
# **WerFault.exe** 打上的 —— Windows 错误报告在判定进程 hang 后，走「生成 hang 报告 →
# TerminateProcess」这条自动路径才会留下它。这也解释了为什么用户那次现场"三缺"：
# WER 可以被触发却仍然生成不出可用报告，于是有退出码、没 dump、没 Event 1002。
# 本脚本因此只能证伪 EndTask 这条路径，**不能**用来复现 0xCFFFFFFF。要复现得让 WER 的
# 自动 hang 处理介入（依赖 HangRecovery 策略且不受本进程控制），成本远高于收益 ——
# 结论本身已经不影响修复方向：不管收尸的是谁，前提都是「主线程停止泵消息超过 5 秒」。
param(
    [string]$AppExe = '',
    [string]$DataDir = 'D:\Temp\cv-hangtest',
    [int]$WindowWaitSeconds = 60
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'lib\kill-guard.ps1')

if (-not $AppExe) {
    # 默认挑 dist 下最新的一个 win-unpacked 包。
    $candidate = Get-ChildItem -Path (Join-Path $PSScriptRoot '..\dist') -Directory -Filter 'release-*' -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending |
                 ForEach-Object { Join-Path $_.FullName 'win-unpacked\Chill Vibe.exe' } |
                 Where-Object { Test-Path $_ } |
                 Select-Object -First 1
    if (-not $candidate) { throw 'no packaged build found under dist/release-*; pass -AppExe explicitly' }
    $AppExe = $candidate
}
if (-not (Test-Path $AppExe)) { throw "App not found: $AppExe" }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HangProbe {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SuspendThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    // 任务管理器的「结束任务」对无响应窗口走的就是 EndTask。
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EndTask(IntPtr hWnd, bool fShutDown, bool fForce);
    [DllImport("user32.dll")]
    public static extern bool IsHungAppWindow(IntPtr hWnd);
}
'@

# 启动前快照：之后只允许碰快照里没有的进程。
$killGuard = New-KillGuard -ProcessNames @('Chill Vibe.exe')

if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# CHILL_VIBE_DATA_DIR 单独给打包版是不生效的 —— resolveDesktopDataDir 只在共享目录
# 覆盖被显式打开时才认它。少了第二个开关，"隔离"实例会静默连上用户的真实 profile。
$env:CHILL_VIBE_DATA_DIR = $DataDir
$env:CHILL_VIBE_ALLOW_SHARED_DATA_DIR = '1'
# 少了这一个，新实例会撞上用户实例的单实例锁：自己立刻退出，还把窗口焦点交给用户那个。
# 那样测到的就是「启动失败」的签名，而不是 hang-kill 的。
$env:CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK = '1'

Write-Output "=== launching isolated instance ==="
Write-Output "  exe:      $AppExe"
Write-Output "  data dir: $DataDir"
$started = Start-Process -FilePath $AppExe -PassThru
$null = $started.Handle   # 趁它还活着拿住句柄，否则进程一退 ExitCode 就取不到
$targetPid = $started.Id
Write-Output "  pid:      $targetPid"

# 必须等应用真正跑起来再挂起：挂一个还在启动的线程，测到的是启动失败的签名。
$isolatedLog = Join-Path $DataDir 'logs\main.log'
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $isolatedLog) {
        $text = Get-Content $isolatedLog -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
        if ($text -match 'Renderer finished load') { $ready = $true; break }
    }
}
Write-Output "  renderer ready: $ready"
if (-not $ready) { Write-Output '  !! app never reached a running state; the signature below would be meaningless' }

# 等窗口出现。没有窗口就没有消息泵，也就无从制造 hang。
$deadline = (Get-Date).AddSeconds($WindowWaitSeconds)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $p) { throw "instance exited before showing a window (pid $targetPid)" }
    if ($p.MainWindowHandle -ne 0) { $hwnd = $p.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "no window after ${WindowWaitSeconds}s" }
Write-Output "  hwnd:     $hwnd"

# 消息泵住在最早创建的那个线程上。
$proc = Get-Process -Id $targetPid
$mainThread = $proc.Threads | Sort-Object StartTime | Select-Object -First 1
Write-Output "=== suspending main thread tid=$($mainThread.Id) (freezes the message pump) ==="

# THREAD_SUSPEND_RESUME = 0x0002
$hThread = [HangProbe]::OpenThread(0x0002, $false, [uint32]$mainThread.Id)
if ($hThread -eq [IntPtr]::Zero) { throw "OpenThread failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$null = [HangProbe]::SuspendThread($hThread)

# 让 Windows 注意到窗口不再取消息（hung 判定阈值 5s）。
$hungAt = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $proc.Refresh()
    $hung = [HangProbe]::IsHungAppWindow($hwnd)
    if ($hung -and -not $hungAt) {
        $hungAt = ((Get-Date) - $proc.StartTime)
        Write-Output "  IsHungAppWindow = TRUE after $([math]::Round($i * 0.5, 1))s of suspension"
        break
    }
}
if (-not $hungAt) { Write-Output '  WARNING: window never reported as hung' }

Write-Output "=== EndTask(force) -- this is what Task Manager does to a hung window ==="
$null = [HangProbe]::EndTask($hwnd, $false, $true)

# 退出码要趁句柄还在时取。Start-Process -PassThru 返回的对象已经持有句柄。
$exited = $started.WaitForExit(20000)
if (-not $exited) {
    Write-Output '  still alive 20s after EndTask'
} else {
    $code = $started.ExitCode
    $hex = '0x{0:X8}' -f ([System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]$code), 0))
    Write-Output ''
    Write-Output "*** EXIT CODE: $code  hex=$hex ***"
    if ($hex -eq '0xCFFFFFFF') {
        Write-Output '*** MATCH: 与 2026-08-12 10:40:53 用户实例的退出码一致 -> hang-kill 签名确认 ***'
    } else {
        Write-Output "*** NO MATCH: 用户那次是 0xCFFFFFFF，本次是 $hex -> 需要重新解释那个码 ***"
    }
}

$null = [HangProbe]::CloseHandle($hThread)

Write-Output ''
Write-Output '=== teardown (only processes this run created) ==='
Get-CimInstance Win32_Process -Filter "Name='Chill Vibe.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { $null = Stop-ProcessGuarded -Guard $killGuard -ProcessId ([int]$_.ProcessId) -Reason '(spawned by this run)' }
Remove-Item Env:\CHILL_VIBE_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item Env:\CHILL_VIBE_ALLOW_SHARED_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item Env:\CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK -ErrorAction SilentlyContinue
