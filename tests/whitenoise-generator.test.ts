import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildWhitenoiseCliArgs,
  getWhitenoiseCliTimeoutMs,
  resolveWhitenoiseCliCwd,
  runWhitenoiseCliProcess,
  type WhitenoiseCliChild,
} from '../server/whitenoise/whitenoise-generator.ts'

test('white-noise CLI uses the configured default workspace when it exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chill-vibe-whitenoise-'))
  const workspaceDir = path.join(root, 'workspace')
  const appDataDir = path.join(root, 'app-data')

  try {
    await mkdir(workspaceDir, { recursive: true })
    const resolved = await resolveWhitenoiseCliCwd({
      defaultWorkspacePath: workspaceDir,
      appDataDir,
    })

    assert.equal(resolved, workspaceDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('white-noise CLI falls back to the app data dir instead of process cwd when no workspace is configured', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chill-vibe-whitenoise-'))
  const appDataDir = path.join(root, 'app-data')

  try {
    const resolved = await resolveWhitenoiseCliCwd({
      defaultWorkspacePath: '',
      appDataDir,
    })

    assert.equal(resolved, appDataDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

class FakeCliChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killCount = 0

  kill() {
    this.killCount += 1
    return true
  }
}

const createFakeSpawn = () => {
  const child = new FakeCliChild()
  const calls: Array<{ command: string; args: string[] }> = []

  return {
    child,
    calls,
    spawnProcess: (command: string, args: string[]) => {
      calls.push({ command, args })
      return child as unknown as WhitenoiseCliChild
    },
  }
}

const runFakeCli = (
  provider: 'claude' | 'codex',
  spawnProcess: (command: string, args: string[]) => WhitenoiseCliChild,
  overrides: { timeoutMs?: number; maxOutputChars?: number } = {},
) =>
  runWhitenoiseCliProcess({
    provider,
    launch: { command: 'fake-cli', args: ['--stub'] },
    cwd: tmpdir(),
    env: {},
    spawnProcess,
    ...overrides,
  })

test('white-noise codex argv never bypasses the sandbox', () => {
  const args = buildWhitenoiseCliArgs('codex', 'PROMPT', ['--runtime-flag'])

  assert.ok(
    !args.includes('--dangerously-bypass-approvals-and-sandbox'),
    'white-noise generation must not run codex with approvals/sandbox bypassed',
  )
  assert.deepEqual(args.slice(0, 2), ['--runtime-flag', 'exec'])
  assert.ok(args.includes('--skip-git-repo-check'))

  // 审批策略从 `--ask-for-approval never` 换成 `-c approval_policy="never"`：
  // codex-cli 0.144 删了前者，详见 buildWhitenoiseCliArgs 的注释。
  assert.ok(args.includes('approval_policy="never"'), 'codex argv must pin an approval policy')
  assert.ok(!args.includes('--ask-for-approval'), 'codex-cli 0.144 rejects --ask-for-approval')

  const sandboxIndex = args.indexOf('--sandbox')
  assert.ok(sandboxIndex >= 0, 'codex argv must pin a sandbox mode')
  assert.equal(args[sandboxIndex + 1], 'read-only')

  assert.equal(args.at(-1), 'PROMPT')
})

test('white-noise claude argv keeps the single-turn text contract', () => {
  const args = buildWhitenoiseCliArgs('claude', 'PROMPT', ['--runtime-flag'])

  assert.deepEqual(args, [
    '--runtime-flag',
    '-p',
    '--output-format',
    'text',
    '--max-turns',
    '1',
    'PROMPT',
  ])
})

test('white-noise CLI timeout is bounded and overridable through the environment', () => {
  const previous = process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS

  try {
    delete process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS
    const fallback = getWhitenoiseCliTimeoutMs()
    assert.ok(Number.isFinite(fallback) && fallback > 0, 'a finite default timeout is required')

    process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS = '4321'
    assert.equal(getWhitenoiseCliTimeoutMs(), 4321)

    process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS = 'not-a-number'
    assert.equal(getWhitenoiseCliTimeoutMs(), fallback)
  } finally {
    if (previous === undefined) {
      delete process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS
    } else {
      process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS = previous
    }
  }
})

test('a hung white-noise CLI is killed and rejects instead of hanging the IPC call forever', async () => {
  const { child, spawnProcess } = createFakeSpawn()
  const pending = runFakeCli('codex', spawnProcess, { timeoutMs: 30 })

  child.stdout.emit('data', Buffer.from('{"type":"item.started"}\n'))

  await assert.rejects(pending, /timed out/i)
  assert.ok(child.killCount > 0, 'the timed-out child process must be killed')
})

test('white-noise CLI output is capped and still yields the codex assistant message', async () => {
  const { child, spawnProcess } = createFakeSpawn()
  const pending = runFakeCli('codex', spawnProcess, { timeoutMs: 5_000, maxOutputChars: 1_000 })

  child.stdout.emit('data', Buffer.from(`${'x'.repeat(200_000)}\n`))
  child.stderr.emit('data', Buffer.from('y'.repeat(200_000)))
  child.stdout.emit(
    'data',
    Buffer.from(`${JSON.stringify({ type: 'message', role: 'assistant', content: '{"title":"雨"}' })}\n`),
  )
  child.emit('close', 0)

  assert.equal(await pending, '{"title":"雨"}')
})

test('white-noise claude output stops growing once the cap is reached', async () => {
  const { child, spawnProcess } = createFakeSpawn()
  const pending = runFakeCli('claude', spawnProcess, { timeoutMs: 5_000, maxOutputChars: 1_000 })

  for (let i = 0; i < 20; i += 1) {
    child.stdout.emit('data', Buffer.from('z'.repeat(50_000)))
  }
  child.emit('close', 0)

  const resolved = await pending
  assert.ok(resolved.length <= 1_000, `claude stdout must stay bounded, got ${resolved.length}`)
})

test('a failed white-noise CLI rejects once with a bounded stderr excerpt', async () => {
  const { child, spawnProcess } = createFakeSpawn()
  const pending = runFakeCli('codex', spawnProcess, { timeoutMs: 5_000, maxOutputChars: 1_000 })

  child.stderr.emit('data', Buffer.from('boom'.repeat(100_000)))
  child.emit('close', 1)
  child.emit('error', new Error('late error must not double-settle'))

  await assert.rejects(pending, /exited with code 1/)
})
