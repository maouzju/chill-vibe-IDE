import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSystemPromptForModel,
  defaultSystemPrompt,
  normalizeModelPromptRules,
} from '../shared/system-prompt.ts'

describe('model prompt rules', () => {
  it('drops incomplete rules and trims persisted entries', () => {
    const normalized = normalizeModelPromptRules([
      {
        id: 'rule-claude',
        modelMatch: '  claude  ',
        prompt: '  Use concise review bullets.  ',
      },
      {
        id: 'rule-empty-match',
        modelMatch: '   ',
        prompt: 'Should be ignored.',
      },
      {
        id: '',
        modelMatch: '  sonnet ',
        prompt: '  Prefer faster tradeoffs when possible. ',
      },
      {
        id: 'rule-empty-prompt',
        modelMatch: 'opus',
        prompt: '   ',
      },
    ])

    assert.deepEqual(normalized, [
      {
        id: 'rule-claude',
        modelMatch: 'claude',
        prompt: 'Use concise review bullets.',
      },
      {
        id: 'model-prompt-rule-3',
        modelMatch: 'sonnet',
        prompt: 'Prefer faster tradeoffs when possible.',
      },
    ])
  })

  it('appends matching prompts in order using case-insensitive substring matching', () => {
    const prompt = buildSystemPromptForModel('  Always verify before claiming success.  ', 'Claude-Sonnet-4-6', [
      {
        id: 'rule-claude',
        modelMatch: 'claude',
        prompt: 'Use concise review bullets.',
      },
      {
        id: 'rule-sonnet',
        modelMatch: 'sonnet',
        prompt: 'Prefer faster tradeoffs when possible.',
      },
      {
        id: 'rule-gpt',
        modelMatch: 'gpt',
        prompt: 'Should not match this Claude request.',
      },
    ])

    assert.equal(
      prompt,
      [
        'Always verify before claiming success.',
        'Use concise review bullets.',
        'Prefer faster tradeoffs when possible.',
      ].join('\n\n'),
    )
  })

  it('falls back to the built-in prompt when the base prompt is empty and no rules match', () => {
    assert.equal(
      buildSystemPromptForModel('', 'gpt-5.5', [
        {
          id: 'rule-claude',
          modelMatch: 'claude',
          prompt: 'Should not match this request.',
        },
      ]),
      defaultSystemPrompt,
    )
  })

  it('does not append the same rule again when an already-composed prompt reaches the backend', () => {
    const rules = [
      {
        id: 'rule-claude',
        modelMatch: 'claude',
        prompt: 'Use concise review bullets.',
      },
    ]
    const composed = buildSystemPromptForModel(
      'Always verify before claiming success.',
      'claude-sonnet-4-6',
      rules,
    )

    assert.equal(
      buildSystemPromptForModel(composed, 'claude-sonnet-4-6', rules),
      composed,
    )
  })

  it('still appends other matching rules when one matching prompt is already present', () => {
    const rules = [
      {
        id: 'rule-claude',
        modelMatch: 'claude',
        prompt: 'Use concise review bullets.',
      },
      {
        id: 'rule-sonnet',
        modelMatch: 'sonnet',
        prompt: 'Prefer faster tradeoffs when possible.',
      },
    ]

    assert.equal(
      buildSystemPromptForModel(
        'Always verify before claiming success.\n\nUse concise review bullets.',
        'claude-sonnet-4-6',
        rules,
      ),
      [
        'Always verify before claiming success.',
        'Use concise review bullets.',
        'Prefer faster tradeoffs when possible.',
      ].join('\n\n'),
    )
  })
})
