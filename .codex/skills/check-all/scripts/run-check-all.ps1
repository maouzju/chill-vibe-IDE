param(
  [string]$RepoRoot = '.',
  [ValidateSet('risk', 'full')]
  [string]$Mode = 'full',
  [string]$ArtifactsRoot = '',
  [switch]$SkipTheme,
  [switch]$ContinueOnError,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
  param(
    [string]$BasePath,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Value))
}

function New-Step {
  param(
    [string]$Name,
    [string[]]$Arguments,
    [string[]]$Artifacts = @()
  )

  return [pscustomobject]@{
    Name = $Name
    Arguments = [string[]]$Arguments
    Artifacts = [string[]]$Artifacts
  }
}

function Copy-ArtifactIfPresent {
  param(
    [string]$RepoRootPath,
    [string]$RelativePath,
    [string]$DestinationRoot
  )

  $sourcePath = Join-Path $RepoRootPath $RelativePath

  if (-not (Test-Path -LiteralPath $sourcePath)) {
    return $null
  }

  $leafName = Split-Path -Path $RelativePath -Leaf
  $destinationPath = Join-Path $DestinationRoot $leafName

  if (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Recurse -Force
  }

  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
  return $destinationPath
}

$resolvedRepoRoot = (Resolve-Path $RepoRoot).Path
$resolvedArtifactsBase =
  if ([string]::IsNullOrWhiteSpace($ArtifactsRoot)) {
    Join-Path $resolvedRepoRoot '.chill-vibe\check-all'
  } else {
    Resolve-AbsolutePath -BasePath $resolvedRepoRoot -Value $ArtifactsRoot
  }

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$runRoot = Join-Path $resolvedArtifactsBase $timestamp
$logsRoot = Join-Path $runRoot 'logs'
$reportsRoot = Join-Path $runRoot 'reports'

$suffix = 1

while (Test-Path -LiteralPath $runRoot) {
  $runRoot = Join-Path $resolvedArtifactsBase "$timestamp-$suffix"
  $logsRoot = Join-Path $runRoot 'logs'
  $reportsRoot = Join-Path $runRoot 'reports'
  $suffix += 1
}

if (-not $DryRun) {
  $null = New-Item -ItemType Directory -Force -Path $logsRoot
  $null = New-Item -ItemType Directory -Force -Path $reportsRoot
}

$playwrightArtifacts = @('playwright-report', 'test-results')
$electronArtifacts = @('.chill-vibe/test-electron-dev.stdout.log', '.chill-vibe/test-electron-dev.stderr.log')

$steps = [System.Collections.Generic.List[object]]::new()

if ($Mode -eq 'full') {
  $steps.Add((New-Step -Name 'full' -Arguments @('test:full') -Artifacts ($playwrightArtifacts + $electronArtifacts)))

  if (-not $SkipTheme) {
    $steps.Add((New-Step -Name 'theme' -Arguments @('test:theme') -Artifacts $playwrightArtifacts))
  }
} else {
  $steps.Add((New-Step -Name 'quality' -Arguments @('test:quality')))
  $steps.Add((New-Step -Name 'unit' -Arguments @('test')))
  $steps.Add((New-Step -Name 'playwright' -Arguments @('test:playwright') -Artifacts $playwrightArtifacts))

  if (-not $SkipTheme) {
    $steps.Add((New-Step -Name 'theme' -Arguments @('test:theme') -Artifacts $playwrightArtifacts))
  }

  $steps.Add((New-Step -Name 'electron' -Arguments @('test:electron') -Artifacts $electronArtifacts))
}

$results = [System.Collections.Generic.List[object]]::new()

Push-Location $resolvedRepoRoot

try {
  foreach ($step in $steps) {
    $logPath = Join-Path $logsRoot "$($step.Name).log"
    $stepReportRoot = Join-Path $reportsRoot $step.Name

    if (-not $DryRun) {
      $null = New-Item -ItemType Directory -Force -Path $stepReportRoot
    }

    $status = 'passed'
    $exitCode = 0

    if ($DryRun) {
      $status = 'dry-run'
    } else {
      & pnpm @($step.Arguments) 2>&1 | Tee-Object -FilePath $logPath
      $exitCode =
        if ($null -ne $LASTEXITCODE) {
          [int]$LASTEXITCODE
        } else {
          0
        }

      if ($exitCode -ne 0) {
        $status = 'failed'
      }
    }

    $copiedArtifacts = [System.Collections.Generic.List[string]]::new()

    if (-not $DryRun) {
      foreach ($artifactPath in $step.Artifacts) {
        $copiedPath = Copy-ArtifactIfPresent -RepoRootPath $resolvedRepoRoot -RelativePath $artifactPath -DestinationRoot $stepReportRoot

        if ($null -ne $copiedPath) {
          $copiedArtifacts.Add($copiedPath)
        }
      }
    }

    $results.Add([pscustomobject]@{
      name = $step.Name
      command = "pnpm $($step.Arguments -join ' ')"
      log = $logPath
      reportRoot = $stepReportRoot
      copiedArtifacts = @($copiedArtifacts)
      status = $status
      exitCode = $exitCode
    })

    if ($exitCode -ne 0 -and -not $ContinueOnError) {
      break
    }
  }
} finally {
  Pop-Location
}

$failingSteps = @($results | Where-Object { $_.exitCode -ne 0 } | ForEach-Object { $_.name })
$summary = [pscustomobject]@{
  repoRoot = $resolvedRepoRoot
  mode = $Mode
  dryRun = [bool]$DryRun
  runRoot = $runRoot
  logsRoot = $logsRoot
  reportsRoot = $reportsRoot
  summaryPath = (Join-Path $runRoot 'summary.json')
  summaryWritten = (-not $DryRun)
  failingSteps = $failingSteps
  results = @($results)
}

$summaryJson = $summary | ConvertTo-Json -Depth 8

if (-not $DryRun) {
  Set-Content -Path $summary.summaryPath -Value $summaryJson -Encoding UTF8
}

Write-Output $summaryJson

if (-not $DryRun -and $failingSteps.Count -gt 0) {
  exit 1
}
