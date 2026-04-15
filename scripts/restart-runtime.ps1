$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $projectRoot "package.json"
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$devScript = [string]$packageJson.scripts.dev

if ($devScript -notmatch "electron:dev") {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "restart-dev.ps1")
  exit $LASTEXITCODE
}

$startElectronScript = Join-Path $projectRoot "scripts\start-electron-dev.mjs"
$escapedStartElectronScript = [regex]::Escape($startElectronScript)
$repoElectronProcesses =
  @(Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) })
$repoLauncherProcesses =
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -and
      $_.CommandLine -match $escapedStartElectronScript
    })

$processIdsToStop =
  @(
    $repoElectronProcesses | ForEach-Object { $_.Id }
    $repoLauncherProcesses | ForEach-Object { $_.ProcessId }
  ) |
  Where-Object { $_ } |
  Sort-Object -Unique

foreach ($processId in $processIdsToStop) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) {
  $pnpm = Get-Command pnpm -ErrorAction Stop
}

$logDir = Join-Path $projectRoot ".chill-vibe"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stdoutLog = Join-Path $logDir "electron-dev.stdout.log"
$stderrLog = Join-Path $logDir "electron-dev.stderr.log"

$launcher = Start-Process -FilePath $pnpm.Source `
  -ArgumentList "electron:dev" `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -Path (Join-Path $logDir "electron-dev.pid") -Value $launcher.Id

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  $repoElectronProcesses =
    @(Get-Process -Name electron -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) })
} until (
  $repoElectronProcesses.Count -gt 0 -or (Get-Date) -ge $deadline
)

if ($repoElectronProcesses.Count -eq 0) {
  Write-Error "Electron runtime did not become ready in time. Check .chill-vibe/electron-dev.stdout.log and .chill-vibe/electron-dev.stderr.log."
}

$electronIds = $repoElectronProcesses | ForEach-Object { $_.Id }
Write-Output "Restarted Electron runtime with launcher PID $($launcher.Id) and Electron PID(s) $($electronIds -join ', ')"
