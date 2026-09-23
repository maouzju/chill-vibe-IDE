import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GIT_TOOL_MODEL,
  buildLocalModelToken,
  listSelectableModelCatalog,
} from '../shared/models.ts'

// 超管 create_session 与将来的渲染端共用这一份"可选模型目录"（SPEC agent-model-choice AC4）。
const settings = {
  requestModels: { codex: 'gpt-6-astra', claude: 'claude-fable-5' },
  localModelEntries: [
    {
      id: 'ollama-1',
      label: 'Qwen local',
      harness: 'claude' as const,
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: 'x',
      model: 'qwen3',
    },
  ],
}

test('the selectable model catalog lists visible catalog models with labels and drops placeholders', () => {
  const catalog = listSelectableModelCatalog(settings)
  const models = catalog.map((entry) => entry.model)

  assert.ok(!models.includes(GIT_TOOL_MODEL), 'tool cards are not models')
  assert.ok(!models.includes(''), 'the "use configured default" placeholder is not a model')
  assert.deepEqual(
    catalog.find((entry) => entry.model === 'gpt-5.6-luna'),
    { provider: 'codex', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  )
  assert.ok(models.includes('claude-haiku-4-5-20251001'))
  assert.ok(!models.includes('claude-sonnet-4-6'), 'models hidden from the picker stay hidden')
})

test('the configured default of each provider is always selectable, even when hidden from the picker', () => {
  const catalog = listSelectableModelCatalog(settings)
  assert.deepEqual(
    catalog.find((entry) => entry.model === 'claude-fable-5'),
    { provider: 'claude', model: 'claude-fable-5', label: 'Fable 5' },
  )
  // 已经可见的默认模型不能重复出现。
  assert.equal(catalog.filter((entry) => entry.model === 'gpt-6-astra').length, 1)

  const custom = listSelectableModelCatalog({
    ...settings,
    requestModels: { codex: 'my-relay-model', claude: 'claude-opus-5' },
  })
  assert.deepEqual(
    custom.find((entry) => entry.model === 'my-relay-model'),
    { provider: 'codex', model: 'my-relay-model', label: 'configured default' },
  )
})

test('local model entries join the catalog as tokens carrying their label, after catalog models', () => {
  const catalog = listSelectableModelCatalog(settings)
  const local = catalog.at(-1)
  assert.deepEqual(local, {
    provider: 'claude',
    model: buildLocalModelToken('ollama-1'),
    label: 'Qwen local',
  })
  assert.equal(listSelectableModelCatalog({ ...settings, localModelEntries: [] }).some((entry) => entry.model.startsWith('__local__:')), false)
})
