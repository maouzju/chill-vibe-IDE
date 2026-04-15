param(
  [string[]]$Tests = @(
    'tests/electron-bridge-runtime.test.ts',
    'tests/electron-git-tool-runtime.test.ts'
  )
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Tests = @(
  $Tests |
    ForEach-Object { $_ -split ',' } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_.Length -gt 0 }
)

function Test-PortReady {
  param(
    [int]$Port
  )

  $client = [System.Net.Sockets.TcpClient]::new()

  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)

    if (-not $async.AsyncWaitHandle.WaitOne(500)) {
      return $false
    }

    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

Push-Location $repoRoot

$startedDevServer = $false
$devServerProcess = $null
$pnpm = $null

try {
  $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $pnpm) {
    $pnpm = Get-Command pnpm -ErrorAction Stop
  }

  & $pnpm.Source 'electron:compile'

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  if (-not (Test-PortReady -Port 5173)) {

    $logDir = Join-Path $repoRoot '.chill-vibe'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    $stdoutLog = Join-Path $logDir 'test-electron-dev.stdout.log'
    $stderrLog = Join-Path $logDir 'test-electron-dev.stderr.log'

    $devServerProcess = Start-Process -FilePath $pnpm.Source `
      -ArgumentList @('exec', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
      -WorkingDirectory $repoRoot `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru

    $startedDevServer = $true
    $deadline = (Get-Date).AddSeconds(30)

    do {
      Start-Sleep -Milliseconds 500
    } until ((Test-PortReady -Port 5173) -or (Get-Date) -ge $deadline)

    if (-not (Test-PortReady -Port 5173)) {
      throw 'Renderer dev server did not become ready in time for Electron runtime tests.'
    }
  }

  $nodeArgs = @('--import', 'tsx', '--test') + $Tests
  & node @nodeArgs

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  if ($startedDevServer -and $null -ne $devServerProcess) {
    Stop-Process -Id $devServerProcess.Id -Force -ErrorAction SilentlyContinue
  }

  Pop-Location
}
