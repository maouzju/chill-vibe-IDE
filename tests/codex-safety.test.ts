import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

test('parallel Codex cards receive separate workspace-bound safety launchers', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-codex-safety-'))
  const workspaceA = path.join(dataDir, 'workspace-a')
  const workspaceB = path.join(dataDir, 'workspace-b')
  const script = `
    import { prepareCodexSafetyRuntime } from './server/codex-safety.ts'
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
    process.stdout.write(JSON.stringify([first.hookCommand, second.hookCommand, moved.hookCommand]))
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
    const commands = JSON.parse(stdout) as [string, string, string]

    assert.ok(commands[0])
    assert.ok(commands[1])
    assert.ok(commands[2])
    assert.notEqual(commands[0], commands[1])
    assert.notEqual(commands[0], commands[2])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
