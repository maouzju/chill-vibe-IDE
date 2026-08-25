import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalModelEntry, normalizeLocalModelEntries } from '../shared/default-state.ts'
import {
  buildLocalModelOptions,
  buildLocalModelToken,
  isLocalModelToken,
  parseLocalModelToken,
  resolveSlashModelInput,
} from '../shared/models.ts'

test('local model entry normalizes harness, trims text, and keeps an id', () => {
  const entry = createLocalModelEntry(
    {
      id: '  entry-1  ',
      label: '  本机 Qwen  ',
      // 用户可能从旧配置或手改 state.json 带进任意字符串
      harness: 'gemini' as never,
      baseUrl: ' http://127.0.0.1:11434 ',
      apiKey: ' local ',
      model: ' qwen3-coder:30b ',
    },
    { fallbackId: 'fallback-1' },
  )

  assert.equal(entry.id, 'entry-1')
  assert.equal(entry.label, '本机 Qwen')
  // 非法 harness 必须回退到 claude，否则会拿一个不存在的 provider 去 spawn
  assert.equal(entry.harness, 'claude')
  assert.equal(entry.baseUrl, 'http://127.0.0.1:11434')
  assert.equal(entry.apiKey, 'local')
  assert.equal(entry.model, 'qwen3-coder:30b')
})

test('local model entry falls back to the provided id when none is stored', () => {
  const entry = createLocalModelEntry({ model: 'qwen3:8b' }, { fallbackId: 'fallback-2' })
  assert.equal(entry.id, 'fallback-2')
  assert.equal(entry.harness, 'claude')
})

test('normalizing local model entries drops unusable rows and dedupes ids', () => {
  const entries = normalizeLocalModelEntries([
    { id: 'a', label: 'A', harness: 'codex', baseUrl: 'http://a', apiKey: 'k', model: 'model-a' },
    // 没有真实模型名的条目无法工作，必须丢弃而不是留一个坏选项在选择器里
    { id: 'b', label: 'B', harness: 'claude', baseUrl: 'http://b', apiKey: 'k', model: '   ' },
    // 重复 id 会让选择器里两条互相选中
    { id: 'a', label: 'A2', harness: 'claude', baseUrl: 'http://a2', apiKey: 'k', model: 'model-a2' },
    null,
    'nope',
  ] as never)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'a')
  assert.equal(entries[0].model, 'model-a')
  assert.equal(entries[0].harness, 'codex')
})

test('normalizing local model entries tolerates legacy state without the field', () => {
  assert.deepEqual(normalizeLocalModelEntries(undefined), [])
  assert.deepEqual(normalizeLocalModelEntries(null), [])
  assert.deepEqual(normalizeLocalModelEntries({} as never), [])
})

test('local model tokens round-trip and reject everything else', () => {
  const token = buildLocalModelToken('entry-1')
  assert.equal(parseLocalModelToken(token), 'entry-1')
  assert.equal(isLocalModelToken(token), true)

  assert.equal(parseLocalModelToken('claude-opus-5'), null)
  assert.equal(parseLocalModelToken(''), null)
  assert.equal(parseLocalModelToken(undefined), null)
  assert.equal(isLocalModelToken('__git_tool__'), false)
})

// 令牌落进 /model 自定义分支会造出指向不存在条目的卡（同 TOOL_CARD_MODELS 的空壳卡问题）。
// customModelNamePattern 要求首字符是字母数字，下划线前缀天然被挡；这条测试守住这个前缀。
test('slash model input refuses local model tokens', () => {
  assert.equal(resolveSlashModelInput('claude', buildLocalModelToken('entry-1')), null)
})

test('local model options carry the harness as provider and fall back to the model name', () => {
  const options = buildLocalModelOptions([
    createLocalModelEntry({ id: 'e1', label: '本机 Qwen', harness: 'codex', model: 'qwen3-coder:30b' }),
    createLocalModelEntry({ id: 'e2', label: '', harness: 'claude', model: 'qwen3:8b' }),
  ])

  assert.equal(options.length, 2)
  assert.deepEqual(options[0], {
    label: '本机 Qwen',
    provider: 'codex',
    model: buildLocalModelToken('e1'),
  })
  // 没起名字的条目直接用模型名当显示名，不要显示成空白项
  assert.equal(options[1].label, 'qwen3:8b')
  assert.equal(options[1].provider, 'claude')
})
