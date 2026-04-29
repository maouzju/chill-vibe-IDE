import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { buildSetupScriptArguments, resolveSetupScriptPath } from '../server/setup-manager.ts'

test('setup manager resolves the repo script from the module location instead of the current workspace cwd', () => {
  const projectRoot = path.join('D:', 'Git', 'chill-vibe')
  const expectedScriptPath = path.join(projectRoot, 'scripts', 'setup-ai-cli.ps1')

  const resolved = resolveSetupScriptPath({
    cwd: path.join('E:', 'work', 'ide'),
    moduleUrl: pathToFileURL(path.join(projectRoot, 'server', 'setup-manager.ts')).href,
    resourcesPath: path.join('C:', 'Users', 'tester', 'AppData', 'Local', 'Chill Vibe', 'resources'),
    env: {} as NodeJS.ProcessEnv,
    exists: (candidate) => candidate === expectedScriptPath,
  })

  assert.equal(resolved, expectedScriptPath)
})

test('setup manager resolves the bundled setup script from Electron resources in packaged builds', () => {
  const resourcesPath = path.join('C:', 'Users', 'tester', 'AppData', 'Local', 'Chill Vibe', 'resources')
  const expectedScriptPath = path.join(resourcesPath, 'scripts', 'setup-ai-cli.ps1')

  const resolved = resolveSetupScriptPath({
    cwd: path.join('E:', 'work', 'ide'),
    moduleUrl: pathToFileURL(
      path.join(resourcesPath, 'app.asar', 'dist', 'server', 'setup-manager.js'),
    ).href,
    resourcesPath,
    env: {} as NodeJS.ProcessEnv,
    exists: (candidate) => candidate === expectedScriptPath,
  })

  assert.equal(resolved, expectedScriptPath)
})

test('setup manager defaults CLI updates to the latest version', () => {
  assert.deepEqual(buildSetupScriptArguments('D:/repo/scripts/setup-ai-cli.ps1', {
    mode: 'update-cli',
    cli: 'all',
    version: '',
  }), [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'D:/repo/scripts/setup-ai-cli.ps1',
    '-Mode',
    'update-cli',
    '-Cli',
    'all',
    '-Version',
    'latest',
  ])
})

test('setup manager passes a requested CLI version through to the setup script', () => {
  assert.deepEqual(buildSetupScriptArguments('D:/repo/scripts/setup-ai-cli.ps1', {
    mode: 'update-cli',
    cli: 'codex',
    version: '0.23.4',
  }).slice(-6), ['-Mode', 'update-cli', '-Cli', 'codex', '-Version', '0.23.4'])
})
