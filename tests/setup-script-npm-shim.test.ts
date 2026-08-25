import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
