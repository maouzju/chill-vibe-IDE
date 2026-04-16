import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { resolveAppLoadError } from '../src/app-load-error.ts'

test('bridge-unavailable load errors point back to the Electron desktop runtime', () => {
  const result = resolveAppLoadError('zh-CN', new Error('Electron desktop bridge is unavailable.'))

  assert.match(result.title, /桌面|客户端|窗口/)
  assert.match(result.description, /Electron|桌面客户端|桌面版/)
  assert.doesNotMatch(result.description, /开发服务器/)
})

test('generic load errors no longer tell users to start a browser dev server', () => {
  const result = resolveAppLoadError('en', new Error('socket hang up'))

  assert.match(result.title, /workspace service|desktop client/i)
  assert.match(result.description, /desktop app|desktop client/i)
  assert.doesNotMatch(result.description, /dev server/i)
})

test('startup recovery renders as a standalone recovery shell instead of mounting the full blurred board', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8')
  const startupRecoveryStart = source.indexOf('if (startupRecovery) {')
  const settingsGroupStart = source.indexOf('const settingsGroupNodes:')
  const startupRecoveryBlock =
    startupRecoveryStart >= 0 && settingsGroupStart > startupRecoveryStart
      ? source.slice(startupRecoveryStart, settingsGroupStart)
      : ''

  assert.match(startupRecoveryBlock, /if \(startupRecovery\)/)
  assert.match(startupRecoveryBlock, /className="loading-shell"/)
  assert.doesNotMatch(startupRecoveryBlock, /structured-preview-layer/)
})
