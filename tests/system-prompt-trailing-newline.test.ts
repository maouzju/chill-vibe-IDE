import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeAppSettings } from '../shared/default-state.ts'
import { buildSystemPromptForModel, defaultSystemPrompt } from '../shared/system-prompt.ts'

describe('system prompt editing', () => {
  it('keeps a trailing newline typed in the settings textarea', () => {
    const settings = normalizeAppSettings({ systemPrompt: 'Line one\n' })
    assert.equal(settings.systemPrompt, 'Line one\n')
  })

  it('still falls back to the default when cleared', () => {
    assert.equal(normalizeAppSettings({ systemPrompt: '  \n ' }).systemPrompt, defaultSystemPrompt)
  })

  it('trims surrounding whitespace when composing the prompt sent to the model', () => {
    assert.equal(buildSystemPromptForModel('Line one\n\n', 'gpt-5', []), 'Line one')
  })
})
