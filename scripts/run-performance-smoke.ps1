param(
  [ValidateSet('headless', 'headed')]
  [string]$Mode = 'headless'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$playwrightScript = Join-Path $repoRoot 'scripts\run-playwright-specs.ps1'

Push-Location $repoRoot

try {
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

  & powershell -ExecutionPolicy Bypass -File $playwrightScript -Specs 'tests/add-card-freeze.spec.ts' -Mode $Mode

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
