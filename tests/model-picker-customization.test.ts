import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pickWheelPreviewToCommit } from '../src/components/wheel-step.ts'
import {
  createDefaultSettings,
  normalizeAppSettings,
  normalizeModelPickerCustomModels,
} from '../shared/default-state.ts'
import {
  GIT_TOOL_MODEL,
  MODEL_OPTIONS,
  buildLocalModelToken,
  buildModelPickerOptions,
  getModelPickerOptionKey,
  isModelPickerOptionEnabled,
  isModelPickerOptionVisible,
  isValidCustomPickerModelName,
  listConfigurableModelPickerOptions,
  stepModelPickerOption,
} from '../shared/models.ts'
import { createWheelStepAccumulator } from '../src/components/wheel-step.ts'

const keysOf = (options: Parameters<typeof getModelPickerOptionKey>[0][]) => options.map(getModelPickerOptionKey)

const retired = MODEL_OPTIONS.find((option) => option.hiddenFromPicker && !option.usesConfiguredDefault)!
const visibleBuiltIn = MODEL_OPTIONS.find(
  (option) => isModelPickerOptionVisible(option) && !option.usesConfiguredDefault,
)!

describe('model picker customization (SPEC model-picker-customization)', () => {
  it('defaults to the built-in visibility when nothing is customized', () => {
    const options = buildModelPickerOptions({ current: { provider: 'claude', model: '' } })
    assert.deepEqual(
      keysOf(options),
      keysOf(MODEL_OPTIONS.filter(isModelPickerOptionVisible)),
    )
  })

  it('lets the user hide a default option and re-show a retired one', () => {
    const visibility = {
      [getModelPickerOptionKey(visibleBuiltIn)]: false,
      [getModelPickerOptionKey(retired)]: true,
    }
    assert.equal(isModelPickerOptionEnabled(visibleBuiltIn, visibility), false)
    assert.equal(isModelPickerOptionEnabled(retired, visibility), true)

    const keys = keysOf(
      buildModelPickerOptions({
        customization: { visibility },
        current: { provider: 'claude', model: '' },
      }),
    )
    assert.ok(!keys.includes(getModelPickerOptionKey(visibleBuiltIn)))
    assert.ok(keys.includes(getModelPickerOptionKey(retired)))
  })

  it('never lets a visibility override surface a tool card', () => {
    assert.equal(
      isModelPickerOptionEnabled({ provider: 'codex', model: GIT_TOOL_MODEL }, { [`codex:${GIT_TOOL_MODEL}`]: true }),
      false,
    )
    assert.ok(listConfigurableModelPickerOptions().every((option) => !option.model.startsWith('__')))
    assert.ok(listConfigurableModelPickerOptions().some((option) => option.usesConfiguredDefault))
  })

  it('keeps the currently selected model visible even when it was turned off, in catalog order', () => {
    const key = getModelPickerOptionKey(visibleBuiltIn)
    const keys = keysOf(
      buildModelPickerOptions({
        customization: { visibility: { [key]: false } },
        current: { provider: visibleBuiltIn.provider, model: visibleBuiltIn.model },
      }),
    )
    assert.ok(keys.includes(key))
    const catalogOrder = keysOf(MODEL_OPTIONS)
    const indexes = keys.map((entry) => catalogOrder.indexOf(entry))
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b))
  })

  it('keeps local entries first, groups custom entries with their provider series, and dedupes by key', () => {
    const options = buildModelPickerOptions({
      localModelEntries: [
        { id: 'qwen', label: 'Qwen', harness: 'codex', baseUrl: '', apiKey: '', model: 'qwen3' },
      ],
      customization: {
        customModels: [
          { id: 'c1', provider: 'codex', model: 'gpt-5.4', label: 'GPT 5.4' },
          // 与内置项重名：不重复出现，按自定义项（先到）保留
          { id: 'c2', provider: visibleBuiltIn.provider, model: visibleBuiltIn.model, label: 'Custom Sol' },
        ],
      },
      current: { provider: 'codex', model: 'gpt-5.4' },
    })
    const keys = keysOf(options)
    assert.equal(keys[0], `codex:${buildLocalModelToken('qwen')}`)
    assert.equal(keys.indexOf('codex:gpt-5.4') > keys.indexOf('codex:gpt-6-astra'), true)
    assert.equal(keys.indexOf('codex:gpt-5.4') < keys.indexOf('claude:claude-opus-5-5'), true)
    assert.equal(options.find((entry) => entry.model === 'gpt-5.4')?.label, 'GPT 5.4')
    assert.equal(options.find((entry) => entry.model === visibleBuiltIn.model)?.label, 'Custom Sol')
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(keys.filter((entry) => entry === getModelPickerOptionKey(visibleBuiltIn)).length, 1)
  })

  it('groups same-series custom and built-in models together in logical order', () => {
    const options = buildModelPickerOptions({
      customization: {
        visibility: {
          'codex:': false,
          'claude:': false,
          'gemini:': false,
          'codex:gpt-6-luna': false,
          'codex:gpt-6-astra': false,
          'gemini:gemini-3.1-pro-preview': false,
          'gemini:gemini-3-flash-preview': false,
          'gemini:gemini-3.8-flash': false,
          'gemini:gemini-3.5-flash-lite': false,
          'gemini:gemini-3.1-flash-lite': false,
        },
        customModels: [
          { id: '1', provider: 'claude', model: 'claude-fable-5-2', label: 'claude-fable-5-2' },
          { id: '2', provider: 'gemini', model: 'gemini-4-hydrogen', label: 'gemini-4-hydrogen' },
          { id: '3', provider: 'gemini', model: 'gemini-4-carbon', label: 'gemini-4-carbon' },
          { id: '4', provider: 'gemini', model: 'gemini-4-argon-thinking-high', label: 'Gemini 4 Argon Thinking High' },
          { id: '5', provider: 'gemini', model: 'gemini-4-argon-thinking-low', label: 'Gemini 4 Argon Thinking Low' },
          { id: '6', provider: 'gemini', model: 'gemini-4-argon-thinking-medium', label: 'Gemini 4 Argon Thinking Medium' },
        ],
      },
      current: { provider: 'gemini', model: 'gemini-4-argon' },
    })

    assert.deepEqual(
      options.map((entry) => entry.label),
      [
        'GPT-6.2 Sol',
        'GPT-6.2 Astra',
        'claude-fable-5-2',
        'Opus 5.5',
        'Sonnet 5.5',
        'Haiku 5.5',
        'gemini-4-carbon',
        'gemini-4-hydrogen',
        'Gemini 4 Argon',
        'Gemini 4 Argon Thinking High',
        'Gemini 4 Argon Thinking Medium',
        'Gemini 4 Argon Thinking Low',
      ],
    )
  })

  it('places newer/older discovered versions adjacent to their series and uncatalogued current models with their provider', () => {
    const options = buildModelPickerOptions({
      customization: {
        visibility: { 'codex:': false, 'claude:': false, 'gemini:': false },
        customModels: [
          { id: '1', provider: 'gemini', model: 'gemini-3.9-flash', label: 'Gemini 3.9 Flash' },
          { id: '2', provider: 'claude', model: 'claude-opus-6', label: 'Opus 6' },
          { id: '3', provider: 'claude', model: 'claude-opus-4-8', label: 'Opus 4.8' },
          { id: '4', provider: 'codex', model: 'gpt-6.3-sol', label: 'GPT-6.3 Sol' },
          { id: '5', provider: 'gemini', model: 'gemini-4-neon', label: 'Gemini 4 Neon' },
        ],
      },
      current: { provider: 'codex', model: 'deepseek-v4' },
    })

    assert.deepEqual(
      options.map((entry) => entry.model),
      [
        'gpt-6.3-sol',
        'gpt-6.2-sol',
        'gpt-6.2-astra',
        'gpt-6-luna',
        'deepseek-v4',
        'claude-fable-5-2',
        'claude-opus-6',
        'claude-opus-5-5',
        'claude-opus-4-8',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
        'gemini-4-carbon',
        'gemini-4-hydrogen',
        'gemini-4-argon',
        'gemini-4-neon',
        'gemini-3.1-pro-preview',
        'gemini-3.9-flash',
        'gemini-3.8-flash',
        'gemini-3-flash-preview',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
      ],
    )
  })

  it('keeps a series newest-first: a custom 3.7 Flash sorts between 3.8 Flash and 3 Flash', () => {
    const models = buildModelPickerOptions({
      customization: {
        visibility: { 'codex:': false, 'claude:': false, 'gemini:': false },
        customModels: [{ id: '1', provider: 'gemini', model: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }],
      },
      current: { provider: 'codex', model: 'deepseek-v4' },
    }).map((entry) => entry.model)

    const at = (model: string) => models.indexOf(model)
    assert.ok(at('gemini-3.8-flash') >= 0 && at('gemini-3.7-flash') >= 0 && at('gemini-3-flash-preview') >= 0)
    assert.ok(at('gemini-3.8-flash') < at('gemini-3.7-flash'), 'custom 3.7 must not sort above 3.8')
    assert.ok(at('gemini-3.7-flash') < at('gemini-3-flash-preview'), 'custom 3.7 must sort above 3 Flash')
  })

  it('treats a trailing tier word that is the model name itself (gemini-4-ultra) as part of the series', () => {
    const models = buildModelPickerOptions({
      customization: {
        visibility: { 'codex:': false, 'claude:': false, 'gemini:': false },
        customModels: [{ id: '1', provider: 'gemini', model: 'gemini-4-ultra', label: 'Gemini 4 Ultra' }],
      },
      current: { provider: 'codex', model: 'deepseek-v4' },
    }).map((entry) => entry.model)

    assert.ok(models.indexOf('gemini-4-ultra') >= 0, 'custom gemini-4-ultra must be listed')
    assert.ok(
      models.indexOf('gemini-4-ultra') < models.indexOf('gemini-3.1-pro-preview'),
      'gemini-4-ultra belongs with the Gemini 4 group, not at the bottom',
    )
  })

  it('adds a temporary option for an uncatalogued current model', () => {
    const keys = keysOf(buildModelPickerOptions({ current: { provider: 'codex', model: 'deepseek-v4' } }))
    assert.ok(keys.includes('codex:deepseek-v4'))
  })

  it('brainstorm mode drops local entries and the use-default options', () => {
    const options = buildModelPickerOptions({
      mode: 'brainstorm',
      localModelEntries: [
        { id: 'qwen', label: 'Qwen', harness: 'codex', baseUrl: '', apiKey: '', model: 'qwen3' },
      ],
      customization: { customModels: [{ id: 'c1', provider: 'claude', model: 'claude-x-1', label: '' }] },
      current: { provider: 'claude', model: 'claude-opus-5-5' },
    })
    assert.ok(options.every((option) => !option.usesConfiguredDefault))
    assert.ok(options.every((option) => !option.model.startsWith('__local__:')))
    assert.ok(keysOf(options).includes('claude:claude-x-1'))
  })

  it('steps to the previous / next option and stops at both ends', () => {
    const options = [
      { provider: 'codex' as const, model: 'a1' },
      { provider: 'codex' as const, model: 'b2' },
      { provider: 'claude' as const, model: 'c3' },
    ]
    assert.equal(stepModelPickerOption(options, 'codex:b2', 1), 'codex:a1')
    assert.equal(stepModelPickerOption(options, 'codex:b2', -1), 'claude:c3')
    assert.equal(stepModelPickerOption(options, 'codex:a1', 1), null)
    assert.equal(stepModelPickerOption(options, 'claude:c3', -1), null)
    assert.equal(stepModelPickerOption(options, 'codex:missing', -1), 'codex:a1')
    assert.equal(stepModelPickerOption(options, 'codex:missing', 1), 'claude:c3')
    assert.equal(stepModelPickerOption([], 'codex:a1', 1), null)
  })

  it('validates custom model names like /model custom names', () => {
    assert.equal(isValidCustomPickerModelName('gpt-5.4'), true)
    assert.equal(isValidCustomPickerModelName('openrouter/deepseek-v4:free'), true)
    assert.equal(isValidCustomPickerModelName(''), false)
    assert.equal(isValidCustomPickerModelName('has spaces'), false)
    assert.equal(isValidCustomPickerModelName(GIT_TOOL_MODEL), false)
    assert.equal(isValidCustomPickerModelName(buildLocalModelToken('x')), false)
  })
})

describe('model picker settings normalization', () => {
  it('defaults to an empty override table and no custom entries', () => {
    const settings = createDefaultSettings()
    assert.deepEqual(settings.modelPickerVisibility, {})
    assert.deepEqual(settings.modelPickerCustomModels, [])
    const upgraded = normalizeAppSettings({})
    assert.deepEqual(upgraded.modelPickerVisibility, {})
    assert.deepEqual(upgraded.modelPickerCustomModels, [])
  })

  it('cleans dirty overrides and custom entries from hand-edited state', () => {
    const settings = normalizeAppSettings({
      modelPickerVisibility: {
        'codex:gpt-6-luna': false,
        'claude:': false,
        '': true,
        [`codex:${GIT_TOOL_MODEL}`]: true,
        'codex:gpt-5.5': 'yes' as never,
      },
      modelPickerCustomModels: [
        { id: ' c1 ', provider: 'codex', model: ' gpt-5.4 ', label: ' 5.4 ' },
        { id: 'c2', provider: 'codex', model: 'gpt-5.4', label: 'dup by key' },
        { id: 'c1', provider: 'claude', model: 'claude-x', label: 'dup by id' },
        { id: 'c3', provider: 'nope' as never, model: 'm-3', label: '' },
        { id: 'c4', provider: 'codex', model: GIT_TOOL_MODEL, label: '' },
        { id: 'c5', provider: 'codex', model: 'bad name', label: '' },
        null as never,
      ],
    })
    assert.deepEqual(settings.modelPickerVisibility, { 'codex:gpt-6-luna': false, 'claude:': false })
    assert.deepEqual(settings.modelPickerCustomModels, [
      { id: 'c1', provider: 'codex', model: 'gpt-5.4', label: '5.4' },
      { id: 'c3', provider: 'codex', model: 'm-3', label: '' },
    ])
    assert.deepEqual(normalizeModelPickerCustomModels(undefined), [])
  })

  // 自定义模型可绑定一个供应商配置（profileId）：只有真绑了才带这个键，没绑的旧数据保持原形状。
  it('keeps a bound provider profile id and omits it when blank', () => {
    assert.deepEqual(
      normalizeModelPickerCustomModels([
        { id: 'a', provider: 'claude', model: 'ds-model', label: '', profileId: ' extra ' },
        { id: 'b', provider: 'claude', model: 'plain-model', label: '', profileId: '  ' },
        { id: 'c', provider: 'claude', model: 'older-model', label: '' },
      ]),
      [
        { id: 'a', provider: 'claude', model: 'ds-model', label: '', profileId: 'extra' },
        { id: 'b', provider: 'claude', model: 'plain-model', label: '' },
        { id: 'c', provider: 'claude', model: 'older-model', label: '' },
      ],
    )
  })
})

describe('wheel step accumulator', () => {
  const wheel = (deltaY: number, timeStamp: number, deltaMode = 0) => ({ deltaY, deltaMode, timeStamp })

  it('treats one mouse notch as one step: up = 1, down = -1', () => {
    const step = createWheelStepAccumulator()
    assert.equal(step(wheel(-100, 0)), 1)
    assert.equal(step(wheel(100, 500)), -1)
    // 300% DPI 一齿只剩 ~33
    assert.equal(step(wheel(33, 1000)), -1)
  })

  it('accumulates small trackpad deltas and resets after a 200ms pause', () => {
    const step = createWheelStepAccumulator()
    assert.equal(step(wheel(6, 0)), 0)
    assert.equal(step(wheel(6, 10)), 0)
    assert.equal(step(wheel(6, 20)), -1)
    assert.equal(step(wheel(10, 30)), 0)
    assert.equal(step(wheel(10, 400)), 0)
    assert.equal(step(wheel(0, 410)), 0)
  })

  it('converts line-mode deltas', () => {
    const step = createWheelStepAccumulator()
    assert.equal(step(wheel(-1, 0, 1)), 1)
  })
})

describe('wheel preview commit', () => {
  it('does not commit a wheel preview while the card is streaming', () => {
    assert.equal(
      pickWheelPreviewToCommit({ preview: 'claude:sonnet', current: 'codex:luna', streaming: true }),
      null,
    )
    assert.equal(
      pickWheelPreviewToCommit({ preview: 'claude:sonnet', current: 'codex:luna', streaming: false }),
      'claude:sonnet',
    )
    assert.equal(pickWheelPreviewToCommit({ preview: 'codex:luna', current: 'codex:luna', streaming: false }), null)
    assert.equal(pickWheelPreviewToCommit({ preview: null, current: 'codex:luna', streaming: false }), null)
  })
})
