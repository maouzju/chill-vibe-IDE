import assert from 'node:assert/strict'
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
