import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { getResolvedAppTheme } from '../src/theme.ts'

const originalWindow = globalThis.window

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
    return
  }

  ;(globalThis as typeof globalThis & { window?: Window }).window = originalWindow
})

describe('theme runtime helpers', () => {
  it('falls back to dark when system theme detection is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'window')

    assert.equal(getResolvedAppTheme('system'), 'dark')
  })
})
