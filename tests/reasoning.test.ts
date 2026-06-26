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

  it('lists provider-specific reasoning options with full Claude tiers plus ultracode', () => {
    assert.deepEqual(
      getReasoningOptions('codex').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh'],
    )
    assert.deepEqual(
      getReasoningOptions('claude').map((option) => option.value),
      ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    )
  })

  it('normalizes empty and cross-provider effort values', () => {
    assert.equal(normalizeReasoningEffort('codex', ''), 'xhigh')
    assert.equal(normalizeReasoningEffort('codex', 'max'), 'xhigh')
    // xhigh is now a real, distinct Claude tier (no longer aliased to max).
    assert.equal(normalizeReasoningEffort('claude', 'xhigh'), 'xhigh')
    assert.equal(normalizeReasoningEffort('claude', 'unknown'), 'max')
  })

  it('keeps ultracode as a distinct Claude top rung but rejects it for Codex', () => {
    assert.equal(normalizeReasoningEffort('claude', 'ultracode'), 'ultracode')
    // Codex has no ultracode/max concept; both collapse to its xhigh top tier.
    assert.equal(normalizeReasoningEffort('codex', 'ultracode'), 'xhigh')
  })

  it('normalizes unsupported Codex auto to the default while keeping Claude auto', () => {
    assert.equal(normalizeReasoningEffort('codex', 'auto'), 'xhigh')
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

  it('includes localized label for supported auto option only', () => {
    const codexZh = getReasoningOptions('codex', 'zh-CN')
    const claudeEn = getReasoningOptions('claude', 'en')
    assert.equal(codexZh.find((o) => o.value === 'auto'), undefined)
    assert.equal(claudeEn.find((o) => o.value === 'auto')?.label, 'Auto')
  })

  it('gives xhigh, max and ultracode distinct Claude labels', () => {
    const en = getReasoningOptions('claude', 'en')
    const zh = getReasoningOptions('claude', 'zh-CN')
    const labelOf = (opts: typeof en, value: string) => opts.find((o) => o.value === value)?.label
    // The three top tiers must be visually distinguishable, not all "Max".
    assert.notEqual(labelOf(en, 'xhigh'), labelOf(en, 'max'))
    assert.notEqual(labelOf(en, 'max'), labelOf(en, 'ultracode'))
    assert.notEqual(labelOf(en, 'xhigh'), labelOf(en, 'ultracode'))
    assert.notEqual(labelOf(zh, 'xhigh'), labelOf(zh, 'max'))
    assert.notEqual(labelOf(zh, 'max'), labelOf(zh, 'ultracode'))
  })
})
