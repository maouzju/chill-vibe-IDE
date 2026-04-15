import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BRAINSTORM_TOOL_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  getModelOptions,
  normalizeModel,
  normalizeStoredModel,
  resolveSlashModel,
} from '../shared/models.ts'

describe('model helpers', () => {
  it('resolves configured defaults and preserves stored default selections', () => {
    assert.equal(normalizeStoredModel('codex', ''), '')
    assert.equal(normalizeModel('codex', ''), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeModel('codex', 'gpt-4.5'), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeStoredModel('codex', '__dream_tool__'), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeStoredModel('claude', ''), '')
    assert.equal(normalizeModel('claude', ''), DEFAULT_CLAUDE_MODEL)
    assert.equal(normalizeModel('claude', ' claude-opus-4-6 '), 'claude-opus-4-6')
  })

  it('lists Git tool first among codex model options', () => {
    const codexOptions = getModelOptions('codex')
    assert.equal(codexOptions[0].model, GIT_TOOL_MODEL, 'Git tool option must be first')
  })

  it('lists configured-default entries before provider-specific model options', () => {
    assert.deepEqual(
      getModelOptions('codex').map((option) => option.model),
      [
        GIT_TOOL_MODEL,
        MUSIC_TOOL_MODEL,
        WHITENOISE_TOOL_MODEL,
        WEATHER_TOOL_MODEL,
        STICKYNOTE_TOOL_MODEL,
        FILETREE_TOOL_MODEL,
        BRAINSTORM_TOOL_MODEL,
        TEXTEDITOR_TOOL_MODEL,
        '',
        DEFAULT_CODEX_MODEL,
      ],
    )
    assert.deepEqual(
      getModelOptions('claude').map((option) => option.model),
      ['', DEFAULT_CLAUDE_MODEL, 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    )
  })

  it('resolves slash-command aliases to canonical model names', () => {
    assert.equal(resolveSlashModel('codex', 'gpt'), '')
    assert.equal(resolveSlashModel('codex', '5.4'), DEFAULT_CODEX_MODEL)
    assert.equal(resolveSlashModel('codex', 'git'), GIT_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'files'), FILETREE_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'brainstorm'), BRAINSTORM_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'ideas'), BRAINSTORM_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'dream'), null)
    assert.equal(resolveSlashModel('codex', 'reflection'), null)
    assert.equal(resolveSlashModel('codex', 'editor'), TEXTEDITOR_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'whitenoise'), WHITENOISE_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'ambient'), WHITENOISE_TOOL_MODEL)
    assert.equal(resolveSlashModel('claude', 'claude'), '')
    assert.equal(resolveSlashModel('claude', 'opus'), 'claude-opus-4-6')
    assert.equal(resolveSlashModel('claude', 'unknown-model'), null)
  })
})
