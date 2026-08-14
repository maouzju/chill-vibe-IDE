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
  it('defaults new Codex cards to the official balanced reasoning effort', () => {
    assert.equal(createCard(undefined, undefined, 'codex').reasoningEffort, 'medium')
    assert.equal(createCard(undefined, undefined, 'claude').reasoningEffort, 'max')
  })

  it('lists provider-specific reasoning options with full Claude tiers plus ultracode', () => {
    assert.deepEqual(
      getReasoningOptions('codex').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    )
    assert.deepEqual(
      getReasoningOptions('claude').map((option) => option.value),
      ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    )
  })

  it('normalizes empty and cross-provider effort values', () => {
    assert.equal(normalizeReasoningEffort('codex', ''), 'medium')
    assert.equal(normalizeReasoningEffort('codex', 'max'), 'max')
    // xhigh is now a real, distinct Claude tier (no longer aliased to max).
    assert.equal(normalizeReasoningEffort('claude', 'xhigh'), 'xhigh')
    assert.equal(normalizeReasoningEffort('claude', 'unknown'), 'max')
  })

  it('keeps provider-specific top-level orchestration names distinct', () => {
    assert.equal(normalizeReasoningEffort('claude', 'ultracode'), 'ultracode')
    assert.equal(normalizeReasoningEffort('codex', 'ultra'), 'ultra')
    assert.equal(normalizeReasoningEffort('codex', 'ultracode'), 'ultra')
  })

  it('normalizes unsupported Codex auto to the default while keeping Claude auto', () => {
    assert.equal(normalizeReasoningEffort('codex', 'auto'), 'medium')
    assert.equal(normalizeReasoningEffort('claude', 'auto'), 'auto')
  })

  it('keeps schema fallbacks provider-neutral while createCard applies model defaults', () => {
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
    assert.equal(getDefaultReasoningEffortForModel('codex', 'gpt-5.6-sol'), 'medium')
    assert.equal(getDefaultReasoningEffortForModel('codex', 'gpt-5.5'), 'medium')
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
      getReasoningOptionsForModel('codex', 'gpt-5.6-sol').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    )
    assert.deepEqual(
      getReasoningOptionsForModel('codex', 'gpt-5.6-terra').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    )
    assert.deepEqual(
      getReasoningOptionsForModel('codex', 'gpt-5.6-luna').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh', 'max'],
    )
    assert.deepEqual(
      getReasoningOptionsForModel('codex', 'gpt-5.5').map((option) => option.value),
      ['low', 'medium', 'high', 'xhigh'],
    )
  })

  it('clamps saved Codex 5.6 tiers to each model capability', () => {
    assert.equal(normalizeReasoningEffortForModel('codex', 'gpt-5.6-sol', 'ultra'), 'ultra')
    assert.equal(normalizeReasoningEffortForModel('codex', 'gpt-5.6-terra', 'max'), 'max')
    assert.equal(normalizeReasoningEffortForModel('codex', 'gpt-5.6-luna', 'ultra'), 'max')
    assert.equal(normalizeReasoningEffortForModel('codex', 'gpt-5.5', 'max'), 'xhigh')
  })

  it('normalizes persisted auto and empty tiers to high on Fable 5', () => {
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-fable-5', 'auto'), 'high')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-fable-5', ''), 'high')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-fable-5', 'max'), 'max')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-opus-4-8', 'auto'), 'auto')
    assert.equal(normalizeReasoningEffortForModel('claude', 'claude-opus-4-8', ''), 'max')
  })

  it('never emits an --effort value the CLI rejects', () => {
    // 症状：选「自动」或关掉思考后，Claude CLI 每轮都打
    //   Warning: Unknown --effort value 'none' — ignoring it and using the default effort.
    // 两档因此双双失效，用户的档位选择被静默丢弃。
    // 根因：`none` 是本仓库自造的值。2026-08-13 实测 `claude --effort none` 与
    // `claude --effort bogus` 输出完全相同的警告并同样回落默认档；`claude --help`
    // 只承认 low/medium/high/xhigh/max，且 CLI 没有任何关闭思考的开关。
    // 为什么不能继续传 none：它与拼错的值完全等价，等于没传。auto 改为省略 flag
    // （null）才是真正的「跟随 CLI 默认」；关思考改为 low —— 合法值里唯一忠实于
    // 「别想太多」意图的档，省略 flag 会让默认档反而更深，背离用户的选择。
    const CLI_ACCEPTED = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

    // auto = 跟随 CLI 默认 → 必须省略 flag，而不是传一个 CLI 不认的假值
    assert.equal(toClaudeEffortFlagValue('claude-opus-5', 'auto', false), null)
    // 关闭思考 → 合法值里的最低档
    assert.equal(toClaudeEffortFlagValue('claude-opus-5', 'max', true), 'low')
    // 明确选择的档位原样透传；ultracode 仍走 xhigh + settings 开关
    assert.equal(toClaudeEffortFlagValue('claude-opus-5', 'max', false), 'max')
    assert.equal(toClaudeEffortFlagValue('claude-opus-5', 'ultracode', false), 'xhigh')
    assert.equal(toClaudeEffortFlagValue('claude-opus-4-8', 'auto', false), null)
    assert.equal(toClaudeEffortFlagValue('claude-opus-4-8', 'max', true), 'low')

    // Fable 5 关不掉思考：auto 与关思考都退回它的 high 默认（本次改动不影响）
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'auto', false), 'high')
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'max', true), 'high')
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'ultracode', false), 'xhigh')
    assert.equal(toClaudeEffortFlagValue('claude-fable-5', 'xhigh', false), 'xhigh')

    // 守卫：穷举档位 × 思考开关 × 模型，产出要么省略、要么是 CLI 真正接受的值。
    // 这条断言的全部意义就是让任何新的自造值（none / auto / ultracode …）当场变红。
    for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-fable-5']) {
      for (const option of getReasoningOptions('claude')) {
        for (const thinkingDisabled of [true, false]) {
          const flag = toClaudeEffortFlagValue(model, option.value, thinkingDisabled)
          if (flag !== null) {
            assert.ok(
              CLI_ACCEPTED.has(flag),
              `${model} / ${option.value} / thinkingDisabled=${thinkingDisabled} produced --effort ${flag}, which the CLI rejects`,
            )
          }
        }
      }
    }
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
