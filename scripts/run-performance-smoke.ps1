param(
  [ValidateSet('headless', 'headed')]
  [string]$Mode = 'headless'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$playwrightScript = Join-Path $repoRoot 'scripts/run-playwright-specs.ps1'

# Windows PowerShell only exists on Windows; Linux/macOS runners ship pwsh.
$powerShellCommand = if (Get-Command 'powershell' -ErrorAction SilentlyContinue) { 'powershell' } else { 'pwsh' }

Push-Location $repoRoot

try {
  if ($Mode -ne 'headless') {
    Write-Warning "Headed mode has been retired for repo validation; running headless instead."
  }

  $nodeArgs = @(
    '--import',
    'tsx',
    '--test',
    'tests/chat-card-compaction.test.ts',
    'tests/layout-memoization.test.ts'
  )

  & node @nodeArgs

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $powerShellCommand -ExecutionPolicy Bypass -File $playwrightScript -Specs 'tests/add-card-freeze.spec.ts'

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
