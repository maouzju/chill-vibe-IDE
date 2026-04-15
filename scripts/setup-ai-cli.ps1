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
    $env:Path = "$machinePath;$userPath"
}

function Get-CommandSafe {
    param([string]$Name)

    return Get-Command $Name -ErrorAction SilentlyContinue
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

function Install-NpmGlobal {
    param(
        [string]$PackageName,
        [string]$CommandName,
        [string]$DisplayName
    )

    Refresh-Path
    $existing = Get-CommandSafe $CommandName
    if ($existing) {
        Write-Step "$DisplayName already available: $(Get-CommandVersion -CommandName $CommandName)"
        return
    }

    if (-not (Get-CommandSafe 'npm')) {
        throw "npm is not available. Install Node.js first."
    }

    Write-Step "Installing $DisplayName with npm..."
    & npm install -g $PackageName 2>&1 | ForEach-Object {
        $line = $_.ToString().Trim()
        if ($line) {
            Write-Step "  $line"
        }
    }

    Refresh-Path
    if (-not (Get-CommandSafe $CommandName)) {
        throw "$DisplayName installation finished, but '$CommandName' is still not on PATH."
    }

    Write-Step "$DisplayName installed: $(Get-CommandVersion -CommandName $CommandName)"
}

Write-Step 'Starting one-click setup for Git, Node.js, Claude CLI, and Codex CLI.'

Install-WingetPackage -Id 'Git.Git' -DisplayName 'Git' -CommandName 'git'
Configure-GitBashPath

Refresh-Path
if (-not (Get-CommandSafe 'node') -or -not (Get-CommandSafe 'npm')) {
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS' -CommandName 'node'
}
else {
    Write-Step "Node.js already available: $(Get-CommandVersion -CommandName 'node')"
    Write-Step "npm already available: $(Get-CommandVersion -CommandName 'npm')"
}

Install-NpmGlobal -PackageName '@anthropic-ai/claude-code' -CommandName 'claude' -DisplayName 'Claude CLI'
Install-NpmGlobal -PackageName '@openai/codex' -CommandName 'codex' -DisplayName 'Codex CLI'

Write-Step 'One-click environment setup completed successfully.'
