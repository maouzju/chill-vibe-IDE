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

  it('orders local entries, then custom entries, then built-ins, deduping by key', () => {
    const options = buildModelPickerOptions({
      localModelEntries: [
        { id: 'qwen', label: 'Qwen', harness: 'codex', baseUrl: '', apiKey: '', model: 'qwen3' },
      ],
      customization: {
        customModels: [
          { id: 'c1', provider: 'codex', model: 'gpt-5.4', label: 'GPT 5.4' },
          // 与内置项重名：不重复出现，按自定义项（先到）保留
          { id: 'c2', provider: visibleBuiltIn.provider, model: visibleBuiltIn.model, label: '' },
        ],
      },
      current: { provider: 'codex', model: 'gpt-5.4' },
    })
    const keys = keysOf(options)
    assert.equal(keys[0], `codex:${buildLocalModelToken('qwen')}`)
    assert.equal(keys[1], 'codex:gpt-5.4')
    assert.equal(options[1]?.label, 'GPT 5.4')
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(keys.filter((entry) => entry === getModelPickerOptionKey(visibleBuiltIn)).length, 1)
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
