import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { resolveSpawnLaunch } from '../scripts/spawn-launch.mjs'

const run = (command: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

test('resolveSpawnLaunch leaves non-Windows launches untouched', () => {
  const launch = resolveSpawnLaunch({
    command: 'pnpm',
    args: ['electron:compile'],
    platform: 'linux',
  })

  assert.deepEqual(launch, {
    command: 'pnpm',
    args: ['electron:compile'],
  })
})

test('resolveSpawnLaunch wraps bare Windows commands through cmd.exe', () => {
  const launch = resolveSpawnLaunch({
    command: 'pnpm',
    args: ['electron:compile'],
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  })

  assert.deepEqual(launch, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm', 'electron:compile'],
  })
})

test('resolveSpawnLaunch leaves explicit Windows paths untouched', () => {
  const launch = resolveSpawnLaunch({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['-v'],
    platform: 'win32',
  })

  assert.deepEqual(launch, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['-v'],
  })
})

test(
  'wrapped Windows launches preserve spaced args without shell=true',
  { skip: process.platform !== 'win32' },
  async () => {
    const launch = resolveSpawnLaunch({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.argv[1])', 'hello world'],
      platform: process.platform,
      comspec: process.env.ComSpec,
    })

    const result = await run(launch.command, launch.args)

    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'hello world')
    assert.equal(result.stderr, '')
  },
)
