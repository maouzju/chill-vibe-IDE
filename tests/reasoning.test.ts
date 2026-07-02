import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard, createDefaultSettings, getPreferredReasoningEffort } from '../shared/default-state.ts'
import { chatCardSchema, chatRequestSchema } from '../shared/schema.ts'
import {
  getDefaultReasoningEffortForModel,
  getReasoningOptions,
  getReasoningOptionsForModel,
  isClaudeAlwaysThinkingModel,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  toClaudeEffortFlagValue,
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

  it('identifies Fable 5 ids and aliases as always-thinking models', () => {
    // Official rule: the model id contains "claude-fable-5"; loose alias forms
    // cover hand-typed custom model values.
    assert.equal(isClaudeAlwaysThinkingModel('claude-fable-5'), true)
    assert.equal(isClaudeAlwaysThinkingModel('fable'), true)
    assert.equal(isClaudeAlwaysThinkingModel('fable-5'), true)
    assert.equal(isClaudeAlwaysThinkingModel('claude-opus-4-8'), false)
    assert.equal(isClaudeAlwaysThinkingModel(''), false)
    assert.equal(isClaudeAlwaysThinkingModel(undefined), false)
  })

  it('defaults Fable 5 to high while other models keep their provider default', () => {
    // Fable 5's official default is high; max is prone to overthinking there.
    assert.equal(getDefaultReasoningEffortForModel('claude', 'claude-fable-5'), 'high')
    assert.equal(getDefaultReasoningEffortForModel('claude', 'claude-opus-4-8'), 'max')
    assert.equal(getDefaultReasoningEffortForModel('claude', ''), 'max')
    assert.equal(getDefaultReasoningEffortForModel('codex', 'gpt-5.5'), 'xhigh')
  })

  it('hides auto from the Fable 5 tier menu because thinking cannot be turned off', () => {
    assert.deepEqual(
      getReasoningOptionsForModel('claude', 'claude-fable-5').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    )
    assert.deepEqual(
      getReasoningOptionsForModel('claude', 'claude-opus-4-8').map((option) => option.value),
      ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    )
    assert.deepEqual(
      getReasoningOptionsForModel('codex', 'gpt-5.5').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh'],
    )
  })

  it('normalizes persisted auto and empty tiers to high on Fable 5', () => {
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-fable-5', 'auto'), 'high')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-fable-5', ''), 'high')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-fable-5', 'max'), 'max')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-opus-4-8', 'auto'), 'auto')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-opus-4-8', ''), 'max')
  })

  it('never yields --effort none for Fable 5', () => {
    // Fable 5: thinking cannot be turned off; degrade to its high default.
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'max', true), 'high')
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'auto', false), 'high')
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'ultracode', false), 'xhigh')
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'xhigh', false), 'xhigh')
    // Other models keep the legacy thinking-off contract, and auto now
    // consistently rides the thinking-disabled path instead of leaking the
    // invalid literal "auto" to the flag.
    assert.equal(toClaudeEffortFlagValue('claude-opus-4-8', 'max', true), 'none')
    assert.equal(toClaudeEffortFlagValue('claude-opus-4-8', 'auto', false), 'none')
    assert.equal(toClaudeEffortFlagValue('claude-opus-4-8', 'max', false), 'max')
    assert.equal(toClaudeEffortFlagValue('claude-opus-4-8', 'ultracode', false), 'xhigh')
  })

  it('prefers the Fable 5 high default when no tier was remembered for it', () => {
    const settings = createDefaultSettings()
    assert.equal(getPreferredReasoningEffort(settings, 'claude', 'claude-fable-5'), 'high')
    assert.equal(getPreferredReasoningEffort(settings, 'claude', 'claude-opus-4-8'), 'max')
  })

  it('creates Fable 5 cards with the high default tier', () => {
    assert.equal(
      createCard(undefined, undefined, 'claude', 'claude-fable-5').reasoningEffort,
      'high',
    )
    // The default Claude model (Opus) keeps its max default.
    assert.equal(createCard(undefined, undefined, 'claude').reasoningEffort, 'max')
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
