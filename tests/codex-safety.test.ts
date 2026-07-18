import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('Codex and Claude share one destructive-command guard launcher while keeping protected roots process-local', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-codex-safety-'))
  const workspaceA = path.join(dataDir, 'workspace-a')
  const workspaceB = path.join(dataDir, 'workspace-b')
  const script = `
    import { prepareCodexSafetyRuntime, prepareDestructiveCommandGuardRuntime } from './server/codex-safety.ts'
    const makeRequest = (cardId, workspacePath) => ({
      provider: 'codex',
      workspacePath,
      prompt: 'test',
      cardId,
      codexDestructiveCommandProtectionEnabled: true,
      codexIsolatedHomeEnabled: false,
    })
    const first = await prepareCodexSafetyRuntime(makeRequest('card-a', ${JSON.stringify(workspaceA)}), [], process.env)
    const second = await prepareCodexSafetyRuntime(makeRequest('card-b', ${JSON.stringify(workspaceB)}), [], process.env)
    const moved = await prepareCodexSafetyRuntime(makeRequest('card-a', ${JSON.stringify(workspaceB)}), [], process.env)
    const claude = await prepareDestructiveCommandGuardRuntime({
      ...makeRequest('claude-card', ${JSON.stringify(workspaceA)}),
      provider: 'claude',
      codexIsolatedHomeEnabled: true,
    }, process.env)
    const summarize = (runtime) => ({
      hookCommand: runtime.hookCommand,
      protectedWorkspace: runtime.env.CHILL_VIBE_PROTECTED_WORKSPACE,
      guardExecutable: runtime.env.CHILL_VIBE_CODEX_GUARD_EXECUTABLE,
      guardScript: runtime.env.CHILL_VIBE_CODEX_GUARD_SCRIPT,
    })
    process.stdout.write(JSON.stringify([summarize(first), summarize(second), summarize(moved), summarize(claude)]))
  `

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        env: { ...process.env, CHILL_VIBE_DATA_DIR: dataDir },
        windowsHide: true,
      },
    )
    const runtimes = JSON.parse(stdout) as Array<{
      hookCommand?: string
      protectedWorkspace?: string
      guardExecutable?: string
      guardScript?: string
    }>

    assert.ok(runtimes[0]?.hookCommand)
    assert.equal(runtimes[0]?.hookCommand, runtimes[1]?.hookCommand)
    assert.equal(runtimes[0]?.hookCommand, runtimes[2]?.hookCommand)
    assert.equal(runtimes[0]?.hookCommand, runtimes[3]?.hookCommand)
    assert.equal(path.resolve(runtimes[0]?.protectedWorkspace ?? ''), path.resolve(workspaceA))
    assert.equal(path.resolve(runtimes[1]?.protectedWorkspace ?? ''), path.resolve(workspaceB))
    assert.equal(path.resolve(runtimes[2]?.protectedWorkspace ?? ''), path.resolve(workspaceB))
    assert.equal(path.resolve(runtimes[3]?.protectedWorkspace ?? ''), path.resolve(workspaceA))
    assert.equal(runtimes[0]?.guardExecutable, process.execPath)
    assert.match(runtimes[0]?.guardScript ?? '', /codex-destructive-command-guard\.js$/)

    const launcherPath = path.join(
      dataDir,
      'codex-safety',
      process.platform === 'win32' ? 'pre-tool-use-guard.cmd' : 'pre-tool-use-guard.sh',
    )
    const launcher = await readFile(launcherPath, 'utf8')
    assert.doesNotMatch(launcher, new RegExp(workspaceA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    assert.doesNotMatch(launcher, new RegExp(workspaceB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    assert.match(launcher, /CHILL_VIBE_CODEX_GUARD_EXECUTABLE/)
    assert.match(launcher, /CHILL_VIBE_CODEX_GUARD_SCRIPT/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
