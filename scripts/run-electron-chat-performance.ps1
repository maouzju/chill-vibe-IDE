param(
  [int]$DurationSeconds = 300,
  [switch]$Soak
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $pnpm) {
  $pnpm = Get-Command pnpm -ErrorAction Stop
}

if ($Soak) {
  $DurationSeconds = 1800
}

if ($DurationSeconds -lt 10) {
  throw 'DurationSeconds must be at least 10 seconds.'
}

$previousDuration = $env:CHILL_VIBE_CHAT_STRESS_DURATION_MS

Push-Location $repoRoot
try {
  $env:CHILL_VIBE_CHAT_STRESS_DURATION_MS = [string]($DurationSeconds * 1000)

  & $pnpm.Source 'build'
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & node '--import' 'tsx' '--test' 'tests/electron-chat-stream-performance.test.ts'
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  if ($null -eq $previousDuration) {
    Remove-Item Env:CHILL_VIBE_CHAT_STRESS_DURATION_MS -ErrorAction SilentlyContinue
  } else {
    $env:CHILL_VIBE_CHAT_STRESS_DURATION_MS = $previousDuration
  }

  Pop-Location
}
