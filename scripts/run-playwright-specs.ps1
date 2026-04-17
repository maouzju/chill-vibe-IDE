param(
  [string[]]$Specs = @(),
  [ValidateSet('headless', 'headed')]
  [string]$Mode = 'headless',
  [ValidateSet('smoke', 'theme', 'full')]
  [string]$Suite = 'smoke'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location $repoRoot

try {
  if ($Mode -ne 'headless') {
    Write-Warning "Headed mode has been retired for repo validation; running headless instead."
  }

  [string[]]$requestedSpecs = @()
  $suiteSpecs = @{
    smoke = @(
      'tests/add-card-order.spec.ts',
      'tests/chat-draft-persistence.spec.ts',
      'tests/git-sticky-picker.spec.ts',
      'tests/git-tool-switch.spec.ts',
      'tests/panel-persistence.spec.ts',
      'tests/structured-chat-collapse.spec.ts',
      'tests/workspace-folder-picker.spec.ts'
    )
    theme = @(
      'tests/theme-check.spec.ts',
      'tests/board-layout.spec.ts'
    )
  }

  if ($null -ne $Specs) {
    $requestedSpecs += $Specs
  }

  $requestedSpecs = @($requestedSpecs | Where-Object { $_ })

  $targets =
    if ($requestedSpecs.Length -gt 0) {
      $requestedSpecs
    } elseif ($Suite -eq 'full') {
      @(Get-ChildItem -Path (Join-Path $repoRoot 'tests') -Filter '*.spec.ts' -File |
        Sort-Object Name |
        ForEach-Object { "tests/$($_.Name)" })
    } else {
      @($suiteSpecs[$Suite] | ForEach-Object {
          $absolutePath = Join-Path $repoRoot $_

          if (-not (Test-Path -LiteralPath $absolutePath)) {
            throw "Playwright suite '$Suite' references a missing spec: $_"
          }

          $_
        })
    }

  if ($targets.Length -eq 0) {
    throw 'No Playwright spec files were found under tests/.'
  }

  $playwrightArgs = @('exec', 'playwright', 'test') + $targets

  & pnpm @playwrightArgs

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
