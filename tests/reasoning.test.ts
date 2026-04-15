import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard } from '../shared/default-state.ts'
import { chatCardSchema, chatRequestSchema } from '../shared/schema.ts'
import {
  getReasoningOptions,
  normalizeReasoningEffort,
} from '../shared/reasoning.ts'

describe('reasoning helpers', () => {
  it('defaults cards to each provider\'s highest reasoning effort', () => {
    assert.equal(createCard(undefined, undefined, 'codex').reasoningEffort, 'xhigh')
    assert.equal(createCard(undefined, undefined, 'claude').reasoningEffort, 'max')
  })

  it('lists provider-specific reasoning options including auto', () => {
    assert.deepEqual(
      getReasoningOptions('codex').map((option) => option.value),
      ['auto', 'low', 'medium', 'high', 'xhigh'],
    )
    assert.deepEqual(
      getReasoningOptions('claude').map((option) => option.value),
      ['auto', 'low', 'medium', 'high', 'max'],
    )
  })

  it('normalizes empty and cross-provider effort values', () => {
    assert.equal(normalizeReasoningEffort('codex', ''), 'xhigh')
    assert.equal(normalizeReasoningEffort('codex', 'max'), 'xhigh')
    assert.equal(normalizeReasoningEffort('claude', 'xhigh'), 'max')
    assert.equal(normalizeReasoningEffort('claude', 'unknown'), 'max')
  })

  it('accepts auto as a valid reasoning effort for both providers', () => {
    assert.equal(normalizeReasoningEffort('codex', 'auto'), 'auto')
    assert.equal(normalizeReasoningEffort('claude', 'auto'), 'auto')
  })

  it('uses the highest reasoning alias in schema defaults', () => {
    assert.equal(
      chatCardSchema.parse({
        id: 'card-1',
        title: '',
        status: 'idle',
        messages: [],
      }).reasoningEffort,
      'max',
    )
    assert.equal(
      chatRequestSchema.parse({
        provider: 'codex',
        workspacePath: 'D:/repo',
        prompt: 'hello',
      }).reasoningEffort,
      'max',
    )
  })

  it('includes localized label for auto option', () => {
    const codexZh = getReasoningOptions('codex', 'zh-CN')
    const claudeEn = getReasoningOptions('claude', 'en')
    assert.equal(codexZh.find((o) => o.value === 'auto')?.label, '自动')
    assert.equal(claudeEn.find((o) => o.value === 'auto')?.label, 'Auto')
  })
})
