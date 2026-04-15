import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import {
  getTitleBarStyleForPlatform,
  shouldUseCustomWindowFrameForPlatform,
  shouldRemoveMenuForPlatform,
} from '../electron/window-options.ts'

test('macOS keeps the inset title bar style', () => {
  assert.equal(getTitleBarStyleForPlatform('darwin'), 'hiddenInset')
})

test('Windows uses a frameless window for a fully custom single-row chrome', () => {
  assert.equal(getTitleBarStyleForPlatform('win32'), undefined)
  assert.equal(shouldUseCustomWindowFrameForPlatform('win32'), true)
  assert.equal(shouldRemoveMenuForPlatform('win32'), true)
})

test('Linux uses a frameless window for a fully custom single-row chrome', () => {
  assert.equal(getTitleBarStyleForPlatform('linux'), undefined)
  assert.equal(shouldUseCustomWindowFrameForPlatform('linux'), true)
  assert.equal(shouldRemoveMenuForPlatform('linux'), true)
})

test('macOS keeps the global app menu behavior', () => {
  assert.equal(shouldRemoveMenuForPlatform('darwin'), false)
  assert.equal(shouldUseCustomWindowFrameForPlatform('darwin'), false)
})

test('Windows resolves a bundled window icon asset', async () => {
  const windowOptionsModule = (await import('../electron/window-options.ts')) as Record<string, unknown>

  assert.equal(typeof windowOptionsModule.getWindowIconPathForPlatform, 'function')

  const getWindowIconPathForPlatform = windowOptionsModule.getWindowIconPathForPlatform as (
    platform: NodeJS.Platform,
    projectRoot: string,
  ) => string | undefined

  const iconPath = getWindowIconPathForPlatform('win32', process.cwd())

  assert.match(iconPath ?? '', /build[\\/]icon\.png$/)
  assert.equal(existsSync(iconPath ?? ''), true)
})
