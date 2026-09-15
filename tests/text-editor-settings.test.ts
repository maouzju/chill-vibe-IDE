import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getTextEditorSettings,
  publishTextEditorSettings,
  registerTextEditorSettingsPatchHandler,
  requestTextEditorSettingsPatch,
} from '../src/components/text-editor-settings.ts'

test('editor cards can request a settings patch that App applies to the global editor settings', () => {
  publishTextEditorSettings({ fontSize: 13, wordWrap: false, minimap: false, tabSize: 2 })
  const received: Array<Record<string, unknown>> = []
  const unregister = registerTextEditorSettingsPatchHandler((patch) => {
    received.push(patch)
  })

  requestTextEditorSettingsPatch({ wordWrap: !getTextEditorSettings().wordWrap })

  assert.deepEqual(received, [{ wordWrap: true }])
  unregister()

  // After the host unregisters, requests become no-ops instead of throwing.
  requestTextEditorSettingsPatch({ wordWrap: false })
  assert.deepEqual(received, [{ wordWrap: true }])
})
