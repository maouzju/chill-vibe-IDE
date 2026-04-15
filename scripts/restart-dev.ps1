$ErrorActionPreference = "Stop"

$ports = @(5173)
$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($procId in $connections) {
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) {
  $pnpm = Get-Command pnpm -ErrorAction Stop
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot ".chill-vibe"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stdoutLog = Join-Path $logDir "dev.stdout.log"
$stderrLog = Join-Path $logDir "dev.stderr.log"

$proc = Start-Process -FilePath $pnpm.Source `
  -ArgumentList "dev:client" `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -Path (Join-Path $logDir "dev.pid") -Value $proc.Id

$deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 500
  $listeningPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ports -contains $_.LocalPort } |
    Select-Object -ExpandProperty LocalPort -Unique
} until (
  $listeningPorts.Count -eq $ports.Count -or (Get-Date) -ge $deadline
)

if ($listeningPorts.Count -ne $ports.Count) {
  Write-Error "Dev services did not become ready in time. Check .chill-vibe/dev.stdout.log and .chill-vibe/dev.stderr.log."
}

Write-Output "Restarted dev server with PID $($proc.Id) and ports $($listeningPorts -join ', ')"
