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

// Drives the real setup script in `update-cli` mode against a stubbed `npm` so the
// test never touches the network or the machine's real global packages. The stub
// dir is injected through CHILL_VIBE_EXTRA_PATH, which the script's Refresh-Path
// keeps at the front of PATH so the stub wins over any real npm/claude.
const runUpdateClaude = (npmCmdBody: string) => {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'cv-setup-stub-'))
  try {
    writeFileSync(path.join(stubDir, 'npm.cmd'), npmCmdBody, 'utf8')
    // Stub claude so the post-install PATH check and version probe succeed.
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

const npmWarnThenSucceed = [
  '@echo off',
  '>&2 echo npm warn cleanup Failed to remove some directories',
  'echo changed 1 package in 2s',
  'exit /b 0',
  '',
].join('\r\n')

const npmFail = ['@echo off', '>&2 echo npm error code E404', 'exit /b 1', ''].join('\r\n')

test(
  'update-cli succeeds when npm only prints warnings to stderr and exits 0',
  { skip: process.platform !== 'win32' },
  () => {
    const result = runUpdateClaude(npmWarnThenSucceed)
    assert.equal(
      result.status,
      0,
      `expected exit 0 on a warning-only npm run, got ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.match(result.stdout, /npm warn cleanup/)
  },
)

test(
  'update-cli still fails when npm exits non-zero',
  { skip: process.platform !== 'win32' },
  () => {
    const result = runUpdateClaude(npmFail)
    assert.notEqual(result.status, 0, 'a real npm failure must propagate a non-zero exit')
  },
)
