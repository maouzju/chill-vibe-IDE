param(
    [ValidateSet('install-missing', 'update-cli')]
    [string]$Mode = 'install-missing',

    [ValidateSet('all', 'claude', 'codex')]
    [string]$Cli = 'all',

    [string]$Version = 'latest'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8

function Write-Step {
    param([string]$Message)

    $timestamp = Get-Date -Format 'HH:mm:ss'
    Write-Output "[$timestamp] $Message"
}

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $extraPath = $env:CHILL_VIBE_EXTRA_PATH
    if ([string]::IsNullOrWhiteSpace($extraPath)) {
        $env:Path = "$machinePath;$userPath"
    }
    else {
        $env:Path = "$extraPath;$machinePath;$userPath"
    }
}

function Get-CommandSafe {
    param([string]$Name)

    return Get-Command $Name -ErrorAction SilentlyContinue
}

function Resolve-NpmExecutablePath {
    # Symptom: on a clean Windows box the one-click setup died with
    # 'Unknown command: "pm"' and npm exit code 1 (reported 2026-08-25, v0.20.7).
    # Root cause: PowerShell resolves a bare `npm` to npm.ps1 BEFORE npm.cmd, and
    # the npm.ps1 shim bundled with Node 20/22 rebuilds its argument list by
    # re-parsing the caller's source line instead of forwarding $args. Called as
    # `& npm install -g <pkg>` it loses the leading character of the first
    # argument, so npm receives the command `pm` (npm/cli#8528). `npm i -g npm`
    # does NOT regenerate that shim, so telling users to update npm never fixes it.
    # Why not just drop the `&`: bare `npm install ...` still resolves to the same
    # npm.ps1 and stays hostage to the shim; only a full path to a real executable
    # shim is version-proof. Extension order matters too - `Get-Command npm -All`
    # also returns the extensionless git-bash `npm` sh script, which PowerShell
    # cannot execute.
    $candidates = @(Get-Command 'npm' -All -ErrorAction SilentlyContinue)

    foreach ($extension in @('.cmd', '.exe', '.bat')) {
        foreach ($candidate in $candidates) {
            $source = $candidate.Source
            if ($source -and $source.ToLowerInvariant().EndsWith($extension)) {
                return $source
            }
        }
    }

    return $null
}

function Get-CommandVersion {
    param(
        [string]$CommandName,
        [string[]]$Arguments = @('--version')
    )

    try {
        return (& $CommandName @Arguments 2>&1 | Select-Object -First 1).ToString().Trim()
    }
    catch {
        return 'installed'
    }
}

function Install-WingetPackage {
    param(
        [string]$Id,
        [string]$DisplayName,
        [string]$CommandName
    )

    Refresh-Path
    $existing = Get-CommandSafe $CommandName
    if ($existing) {
        Write-Step "$DisplayName already available: $(Get-CommandVersion -CommandName $CommandName)"
        return
    }

    $winget = Get-CommandSafe 'winget'
    if (-not $winget) {
        throw "winget is required to install $DisplayName automatically."
    }

    Write-Step "Installing $DisplayName with winget..."
    $arguments = @(
        'install',
        '--id', $Id,
        '--exact',
        '--source', 'winget',
        '--scope', 'user',
        '--silent',
        '--disable-interactivity',
        '--accept-package-agreements',
        '--accept-source-agreements'
    )

    $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "$DisplayName installation failed with exit code $($process.ExitCode)."
    }

    Refresh-Path
    if (-not (Get-CommandSafe $CommandName)) {
        throw "$DisplayName installation finished, but '$CommandName' is still not on PATH."
    }

    Write-Step "$DisplayName installed: $(Get-CommandVersion -CommandName $CommandName)"
}

function Configure-GitBashPath {
    $candidates = @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            [System.Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', $candidate, 'User')
            $env:CLAUDE_CODE_GIT_BASH_PATH = $candidate
            Write-Step "Configured CLAUDE_CODE_GIT_BASH_PATH = $candidate"
            return
        }
    }

    Write-Step 'Git Bash was not found after Git installation. Skipping CLAUDE_CODE_GIT_BASH_PATH.'
}

function Invoke-NpmInstallOnce {
    # Results come back through [ref] instead of `return` on purpose: Write-Step
    # uses Write-Output, so anything this function prints would be merged into its
    # return value and the caller would receive the whole npm log instead of an
    # exit code.
    param(
        [string]$NpmPath,
        [string]$PackageSpec,
        [ref]$OutputLines,
        [ref]$ExitCode
    )

    # npm writes harmless warnings (e.g. "npm warn cleanup") to stderr. With 2>&1
    # those lines surface as NativeCommandError records, which the script-wide
    # 'Stop' preference would treat as terminating and abort even a successful
    # install. Relax the preference around the npm call and decide success from the
    # real process exit code instead.
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $lines = New-Object 'System.Collections.Generic.List[string]'
    try {
        & $NpmPath install -g $PackageSpec 2>&1 | ForEach-Object {
            $line = $_.ToString().Trim()
            if ($line) {
                $lines.Add($line)
                Write-Step "  $line"
            }
        }
        $ExitCode.Value = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    $OutputLines.Value = $lines.ToArray()
}

function Get-StaleNpmShimPath {
    # Symptom: one-click setup died with `EEXIST: file already exists ... codex.ps1`
    # and npm exit code 1, on a box where the Claude install right above it had just
    # succeeded (reported 2026-08-25, v0.20.8).
    # Root cause: npm deletes the old global package before writing the new one. That
    # delete can fail on Windows (the report shows EPERM on a locked
    # `codex-win32-x64\vendor`, enough for an antivirus scan or a running codex.exe),
    # and npm then refuses to overwrite its own leftover shim. The install is wedged
    # permanently: every later run hits the same leftover and fails identically, so
    # the user can never recover without deleting the file by hand.
    # Why parse npm's reported path instead of just deleting <command>.ps1: only the
    # file npm actually tripped over should go. Why the two guards below anyway: the
    # path comes from child-process output, so it is untrusted input — a deletion is
    # allowed only inside npm's own global bin directory AND only for a filename that
    # is exactly this CLI's shim. Anything else is ignored rather than deleted.
    # This is a pure function (no Write-Step) so its return value stays clean.
    param(
        [string]$NpmPath,
        [string]$CommandName,
        [string[]]$NpmOutput
    )

    if (-not $NpmOutput) { return @() }
    if (-not ($NpmOutput -match 'EEXIST')) { return @() }

    $npmBinDir = [System.IO.Path]::GetFullPath((Split-Path -Path $NpmPath -Parent)).TrimEnd('\')
    $allowedNames = @($CommandName, "$CommandName.ps1", "$CommandName.cmd", "$CommandName.bat")
    $results = New-Object 'System.Collections.Generic.List[string]'

    foreach ($line in $NpmOutput) {
        $candidate = $null
        if ($line -match '^npm error path\s+(.+)$') { $candidate = $Matches[1].Trim() }
        elseif ($line -match 'File exists:\s*(.+)$') { $candidate = $Matches[1].Trim() }
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }

        try { $full = [System.IO.Path]::GetFullPath($candidate) } catch { continue }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }

        $parent = [System.IO.Path]::GetFullPath((Split-Path -Path $full -Parent)).TrimEnd('\')
        if ($parent -ine $npmBinDir) { continue }
        if ($allowedNames -notcontains (Split-Path -Path $full -Leaf)) { continue }

        if (-not $results.Contains($full)) { $results.Add($full) }
    }

    return $results.ToArray()
}

function Install-NpmGlobal {
    param(
        [string]$PackageName,
        [string]$CommandName,
        [string]$DisplayName,
        [string]$PackageVersion = 'latest',
        [switch]$Force
    )

    Refresh-Path
    $existing = Get-CommandSafe $CommandName
    if ($existing -and -not $Force) {
        Write-Step "$DisplayName already available: $(Get-CommandVersion -CommandName $CommandName)"
        return
    }

    $npmPath = Resolve-NpmExecutablePath
    if (-not $npmPath) {
        throw "npm is not available. Install Node.js first."
    }

    $normalizedVersion = if ([string]::IsNullOrWhiteSpace($PackageVersion)) { 'latest' } else { $PackageVersion.Trim() }
    $packageSpec = "${PackageName}@${normalizedVersion}"
    $actionLabel = if ($Force) { 'Updating' } else { 'Installing' }
    Write-Step "$actionLabel $DisplayName with npm ($normalizedVersion)..."

    $npmLines = @()
    $npmExitCode = 0
    Invoke-NpmInstallOnce -NpmPath $npmPath -PackageSpec $packageSpec -OutputLines ([ref]$npmLines) -ExitCode ([ref]$npmExitCode)

    if ($npmExitCode -ne 0) {
        $staleShims = @(Get-StaleNpmShimPath -NpmPath $npmPath -CommandName $CommandName -NpmOutput $npmLines)
        if ($staleShims.Count -gt 0) {
            foreach ($shim in $staleShims) {
                Write-Step "Removing leftover npm shim from a failed cleanup: $shim"
                Remove-Item -LiteralPath $shim -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $shim) {
                    # Still locked: retrying npm would fail identically, so stop with
                    # the one instruction that actually unblocks the user.
                    throw "$DisplayName installation is blocked by '$shim', which is locked and could not be removed. Close any running $CommandName process or open terminal, then run the setup again."
                }
            }

            Write-Step "Retrying $DisplayName installation after clearing the leftover shim..."
            Invoke-NpmInstallOnce -NpmPath $npmPath -PackageSpec $packageSpec -OutputLines ([ref]$npmLines) -ExitCode ([ref]$npmExitCode)
        }
    }

    if ($npmExitCode -ne 0) {
        throw "$DisplayName installation failed with npm exit code $npmExitCode."
    }

    Refresh-Path
    if (-not (Get-CommandSafe $CommandName)) {
        throw "$DisplayName installation finished, but '$CommandName' is still not on PATH."
    }

    Write-Step "$DisplayName installed: $(Get-CommandVersion -CommandName $CommandName)"
}

function Update-SelectedCli {
    param(
        [string]$SelectedCli,
        [string]$TargetVersion
    )

    Refresh-Path
    if (-not (Resolve-NpmExecutablePath)) {
        throw 'npm is not available. Install Node.js first.'
    }

    $normalizedVersion = if ([string]::IsNullOrWhiteSpace($TargetVersion)) { 'latest' } else { $TargetVersion.Trim() }
    Write-Step "Starting CLI update: target=$SelectedCli, version=$normalizedVersion."

    if ($SelectedCli -eq 'all' -or $SelectedCli -eq 'claude') {
        Install-NpmGlobal -PackageName '@anthropic-ai/claude-code' -CommandName 'claude' -DisplayName 'Claude CLI' -PackageVersion $normalizedVersion -Force
    }

    if ($SelectedCli -eq 'all' -or $SelectedCli -eq 'codex') {
        Install-NpmGlobal -PackageName '@openai/codex' -CommandName 'codex' -DisplayName 'Codex CLI' -PackageVersion $normalizedVersion -Force
    }

    Write-Step 'CLI update completed successfully.'
}

if ($Mode -eq 'update-cli') {
    Update-SelectedCli -SelectedCli $Cli -TargetVersion $Version
    return
}

Write-Step 'Starting one-click setup for Git, Node.js, Claude CLI, and Codex CLI.'

Install-WingetPackage -Id 'Git.Git' -DisplayName 'Git' -CommandName 'git'
Configure-GitBashPath

Refresh-Path
$npmExecutablePath = Resolve-NpmExecutablePath
if (-not (Get-CommandSafe 'node') -or -not $npmExecutablePath) {
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS' -CommandName 'node'
}
else {
    Write-Step "Node.js already available: $(Get-CommandVersion -CommandName 'node')"
    # Probe through the resolved .cmd shim for the same npm.ps1 reason as above:
    # the broken shim turns `--version` into `-version` and reports a bogus value.
    Write-Step "npm already available: $(Get-CommandVersion -CommandName $npmExecutablePath)"
}

Install-NpmGlobal -PackageName '@anthropic-ai/claude-code' -CommandName 'claude' -DisplayName 'Claude CLI'
Install-NpmGlobal -PackageName '@openai/codex' -CommandName 'codex' -DisplayName 'Codex CLI'

Write-Step 'One-click environment setup completed successfully.'
