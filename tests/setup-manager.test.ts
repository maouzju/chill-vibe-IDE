import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { buildSetupScriptArguments, resolveSetupScriptPath } from '../server/setup-manager.ts'

// These scenarios model a Windows install, so paths and module URLs are built
// with path.win32 / literal file URLs; pathToFileURL would resolve the drive
// path against the posix cwd on Linux CI and break the scenario.
test('setup manager resolves the repo script from the module location instead of the current workspace cwd', () => {
  const projectRoot = path.win32.join('D:', 'Git', 'chill-vibe')
  const expectedScriptPath = path.win32.join(projectRoot, 'scripts', 'setup-ai-cli.ps1')

  const resolved = resolveSetupScriptPath({
    cwd: path.win32.join('E:', 'work', 'ide'),
    moduleUrl: 'file:///D:/Git/chill-vibe/server/setup-manager.ts',
    resourcesPath: path.win32.join('C:', 'Users', 'tester', 'AppData', 'Local', 'Chill Vibe', 'resources'),
    env: {} as NodeJS.ProcessEnv,
    exists: (candidate) => candidate === expectedScriptPath,
  })

  assert.equal(resolved, expectedScriptPath)
})

test('setup manager resolves the bundled setup script from Electron resources in packaged builds', () => {
  const resourcesPath = path.win32.join('C:', 'Users', 'tester', 'AppData', 'Local', 'Chill Vibe', 'resources')
  const expectedScriptPath = path.win32.join(resourcesPath, 'scripts', 'setup-ai-cli.ps1')

  const resolved = resolveSetupScriptPath({
    cwd: path.win32.join('E:', 'work', 'ide'),
    moduleUrl: 'file:///C:/Users/tester/AppData/Local/Chill%20Vibe/resources/app.asar/dist/server/setup-manager.js',
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
