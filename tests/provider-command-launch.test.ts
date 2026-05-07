import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { resolveProviderCommandLaunch } from '../server/provider-command-launch.ts'

const run = (command: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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

test('Windows npm cmd shims resolve to node plus the underlying JS entrypoint', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-command-launch-'))

  try {
    const shimPath = path.join(tempRoot, 'claude.cmd')
    const cliPath = path.join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    await mkdir(path.dirname(cliPath), { recursive: true })
    await writeFile(
      cliPath,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
      'utf8',
    )
    await writeFile(
      shimPath,
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=%',
        ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
        '',
      ].join('\r\n'),
      'utf8',
    )

    const launch = await resolveProviderCommandLaunch({
      command: shimPath,
      args: ['hello world', 'quote "value"'],
      platform: 'win32',
    })

    assert.equal(launch.command, 'node')
    assert.equal(launch.args[0], cliPath)

    const result = await run(launch.command, launch.args)
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), ['hello world', 'quote "value"'])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('Windows npm cmd shims that directly launch bundled executables avoid spawning the cmd file', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-command-launch-'))

  try {
    const shimPath = path.join(tempRoot, 'claude.cmd')
    const cliPath = path.join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    const args = ['-e', 'process.stdout.write(process.argv[1])', 'hello world']

    await mkdir(path.dirname(cliPath), { recursive: true })
    await copyFile(process.execPath, cliPath)
    await writeFile(
      shimPath,
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
        '',
      ].join('\r\n'),
      'utf8',
    )

    const launch = await resolveProviderCommandLaunch({
      command: shimPath,
      args,
      platform: 'win32',
    })

    assert.equal(launch.command, cliPath)
    assert.deepEqual(launch.args, args)

    const result = await run(launch.command, launch.args)
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'hello world')
    assert.equal(result.stderr, '')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('non-cmd executables stay unchanged', async () => {
  const launch = await resolveProviderCommandLaunch({
    command: 'codex.exe',
    args: ['exec', '--json'],
    platform: 'win32',
  })

  assert.deepEqual(launch, {
    command: 'codex.exe',
    args: ['exec', '--json'],
  })
})
