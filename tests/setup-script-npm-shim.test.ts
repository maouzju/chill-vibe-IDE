import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = path.resolve(
  fileURLToPath(new URL('../scripts/setup-ai-cli.ps1', import.meta.url)),
)

// PowerShell resolves a bare `npm` to npm.ps1 *before* npm.cmd. The npm.ps1 shim
// bundled with Node 20/22 rebuilds its argument list by re-parsing the caller's
// source line, so `& npm install -g <pkg>` reaches npm as the command `pm` and
// exits 1 (npm/cli#8528). `npm i -g npm` does not replace that shim, so the only
// reliable fix is to invoke the .cmd shim by full path. These stubs make the
// distinction observable: reaching the .ps1 fails exactly like the real bug.
const brokenNpmPs1 = [
  'Write-Output \'Unknown command: "pm"\'',
  'exit 1',
  '',
].join('\r\n')

// Echoes the argv it received so the test can prove the subcommand and package
// spec arrive intact, not just that the run exited 0.
const workingNpmCmd = [
  '@echo off',
  'echo npm-argv: %*',
  'echo changed 1 package in 2s',
  'exit /b 0',
  '',
].join('\r\n')

const runUpdateClaude = () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'cv-setup-shim-'))
  try {
    writeFileSync(path.join(stubDir, 'npm.ps1'), brokenNpmPs1, 'utf8')
    writeFileSync(path.join(stubDir, 'npm.cmd'), workingNpmCmd, 'utf8')
    writeFileSync(
      path.join(stubDir, 'claude.cmd'),
      '@echo off\r\necho 9.9.9 (Claude Code)\r\nexit /b 0\r\n',
      'utf8',
    )

    return spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Mode',
        'update-cli',
        '-Cli',
        'claude',
        '-Version',
        'latest',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CHILL_VIBE_EXTRA_PATH: stubDir },
      },
    )
  } finally {
    rmSync(stubDir, { recursive: true, force: true })
  }
}

// npm removes the old global package before writing the new one. On Windows that
// delete can fail (EPERM on a locked `vendor` directory — an antivirus scan or a
// still-running codex.exe is enough), and npm then aborts writing its own shim with
// `EEXIST: file already exists ... codex.ps1`. The install is now wedged: every
// retry hits the same leftover shim, so the one-click setup can never succeed again
// without manual cleanup. Reported 2026-08-25 against v0.20.8 on a box where the
// Claude install right above it had already succeeded.
const npmFailsWithLeftoverShim = [
  '@echo off',
  'if exist "%~dp0npm-called.marker" goto second',
  'echo marker> "%~dp0npm-called.marker"',
  'echo leftover> "%~dp0codex.ps1"',
  'echo npm error code EEXIST',
  'echo npm error path %~dp0codex.ps1',
  'echo npm error EEXIST: file already exists',
  'echo npm error File exists: %~dp0codex.ps1',
  'echo npm error Remove the existing file and try again, or run npm',
  'exit /b 1',
  ':second',
  'echo changed 2 packages in 5s',
  'exit /b 0',
  '',
].join('\r\n')

const runUpdateCodexWithLeftoverShim = () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'cv-setup-eexist-'))
  try {
    // The stub dir doubles as the npm global bin dir: npm.cmd lives here, so this
    // is exactly where a real leftover codex.ps1 would sit.
    writeFileSync(path.join(stubDir, 'npm.cmd'), npmFailsWithLeftoverShim, 'utf8')
    writeFileSync(
      path.join(stubDir, 'codex.cmd'),
      '@echo off\r\necho codex-cli 1.2.3\r\nexit /b 0\r\n',
      'utf8',
    )

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Mode',
        'update-cli',
        '-Cli',
        'codex',
        '-Version',
        'latest',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CHILL_VIBE_EXTRA_PATH: stubDir },
      },
    )

    // Must be sampled before the finally block wipes the directory.
    return { result, leftoverStillThere: existsSync(path.join(stubDir, 'codex.ps1')) }
  } finally {
    rmSync(stubDir, { recursive: true, force: true })
  }
}

test(
  'update-cli clears a leftover npm shim and retries instead of dying on EEXIST',
  { skip: process.platform !== 'win32' },
  () => {
    const { result, leftoverStillThere } = runUpdateCodexWithLeftoverShim()
    assert.equal(
      result.status,
      0,
      `an EEXIST leftover must be recoverable, got exit ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.equal(
      leftoverStillThere,
      false,
      'the leftover codex.ps1 shim must be removed so the retry can write a fresh one',
    )
    assert.match(
      result.stdout,
      /codex-cli 1\.2\.3/,
      'the retry must complete and report the installed version',
    )
  },
)

// The path that drives the deletion comes from child-process output, i.e. untrusted
// input. These two decoys cover both guards: right filename in the wrong directory,
// and right directory with a filename that is not this CLI's shim. Neither may be
// deleted, and with nothing legitimately removable the run must fail rather than
// retry pointlessly.
const runUpdateCodexWithOutOfScopePaths = () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'cv-setup-guard-npm-'))
  const victimDir = mkdtempSync(path.join(tmpdir(), 'cv-setup-guard-victim-'))
  try {
    const outsideShim = path.join(victimDir, 'codex.ps1')
    const wrongNameShim = path.join(stubDir, 'unrelated.ps1')
    writeFileSync(outsideShim, 'must survive', 'utf8')
    writeFileSync(wrongNameShim, 'must survive', 'utf8')
    writeFileSync(
      path.join(stubDir, 'npm.cmd'),
      [
        '@echo off',
        'echo npm error code EEXIST',
        `echo npm error path ${outsideShim}`,
        `echo npm error File exists: ${wrongNameShim}`,
        'exit /b 1',
        '',
      ].join('\r\n'),
      'utf8',
    )
    writeFileSync(
      path.join(stubDir, 'codex.cmd'),
      '@echo off\r\necho codex-cli 1.2.3\r\nexit /b 0\r\n',
      'utf8',
    )

    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Mode',
        'update-cli',
        '-Cli',
        'codex',
        '-Version',
        'latest',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CHILL_VIBE_EXTRA_PATH: stubDir },
      },
    )

    return {
      result,
      outsideSurvived: existsSync(outsideShim),
      wrongNameSurvived: existsSync(wrongNameShim),
    }
  } finally {
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(victimDir, { recursive: true, force: true })
  }
}

test(
  'update-cli never deletes a path outside the npm bin dir or one that is not this CLI shim',
  { skip: process.platform !== 'win32' },
  () => {
    const { result, outsideSurvived, wrongNameSurvived } = runUpdateCodexWithOutOfScopePaths()
    assert.equal(
      outsideSurvived,
      true,
      'a shim-named file outside the npm bin directory must never be deleted',
    )
    assert.equal(
      wrongNameSurvived,
      true,
      'a file in the npm bin directory that is not this CLI shim must never be deleted',
    )
    assert.notEqual(
      result.status,
      0,
      'with nothing safely removable the install must fail instead of silently retrying',
    )
  },
)

test(
  'update-cli bypasses the npm.ps1 shim so a mangling shim cannot break the install',
  { skip: process.platform !== 'win32' },
  () => {
    const result = runUpdateClaude()
    assert.doesNotMatch(
      result.stdout,
      /Unknown command/,
      'the setup script must not route npm through npm.ps1',
    )
    assert.equal(
      result.status,
      0,
      `expected exit 0 when npm.cmd works, got ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.match(
      result.stdout,
      /npm-argv: install -g @anthropic-ai\/claude-code@latest/,
      'npm must receive the full subcommand and package spec',
    )
  },
)
