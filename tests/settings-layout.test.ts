import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createInterfaceDefaultsPatch } from '../src/settings-layout.ts'
import { createDefaultEditorSettings } from '../shared/default-state.ts'

describe('settings layout', () => {
  it('resets the editor sub-module together with the rest of the appearance group', () => {
    const patch = createInterfaceDefaultsPatch()

    assert.deepEqual(patch.editor, createDefaultEditorSettings())
    assert.equal(patch.uiScale, 1)
    assert.equal(patch.fontFamily, 'default')
    assert.equal(patch.fontScale, 1)
    assert.equal(patch.lineHeightScale, 1)
    assert.equal(patch.theme, 'light')
    assert.equal(patch.customThemeBase, 'dark')
    assert.equal(patch.customBaseColor, null)
    assert.equal(patch.accentColor, null)
  })
})
