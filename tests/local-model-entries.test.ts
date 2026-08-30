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
  // 非法 harness 必须回退到默认值，否则会拿一个不存在的 provider 去 spawn
  assert.equal(entry.harness, 'codex')
  assert.equal(entry.baseUrl, 'http://127.0.0.1:11434')
  assert.equal(entry.apiKey, 'local')
  assert.equal(entry.model, 'qwen3-coder:30b')
})

test('local model entry falls back to the provided id when none is stored', () => {
  const entry = createLocalModelEntry({ model: 'qwen3:8b' }, { fallbackId: 'fallback-2' })
  assert.equal(entry.id, 'fallback-2')
  assert.equal(entry.harness, 'codex')
})

// 症状：新建一个本地模型条目、什么都不改就发一条「OK」，一次对话吃掉 27k token（32k 上下文的
//   84%）、耗时 299 秒，且界面上的「关闭思考」开关按下去毫无变化。
// 根因：默认 harness 是 claude。三层叠加——(1) Claude CLI 根本没有关思考的开关，IDE 的开关只能
//   翻成 `--effort low`（shared/reasoning.ts:261）；(2) Ollama 的 /v1/messages 只认
//   `thinking:{type:"disabled"}`、无视 budget 大小，于是 low 和 max 行为完全一致；(3) Claude CLI
//   的系统提示与工具定义本身就极其庞大。2026-08-30 同机同模型实测：codex harness 同一句「OK」
//   只用 9,164 token（28%），且 `model_reasoning_effort="none"` 实测能让 Responses 的输出从
//   ['reasoning','message'] 变成 ['message']——思考是真的关掉了。
// 当初默认选 claude 的唯一理由，是 Ollama 0.32.9 没有 /v1/responses（codex 一打就 404，
//   见 docs/specs/local-model-entries/design.md 的实测表）。Ollama 0.32.15 已经补上该端点，
//   这个前提不再成立。
// 被否决的替代方案：保留 claude 默认、只在 UI 上加一句提示。用户要先读懂提示、再理解两个 CLI
//   的协议差异才能自救；而默认值本就该指向当下能用的那一个。
test('local model entries default to the codex harness', async () => {
  const { localModelEntrySchema } = await import('../shared/schema.ts')

  // schema 与工厂函数两条路径都会被用到（前者读盘、后者建条目），默认值必须一致。
  assert.equal(localModelEntrySchema.parse({ id: 'x', model: 'qwen3:8b' }).harness, 'codex')
  assert.equal(createLocalModelEntry({ model: 'qwen3:8b' }).harness, 'codex')

  // 反向守卫：显式选 claude 的老条目不能被默认值改写掉。
  assert.equal(createLocalModelEntry({ model: 'qwen3:8b', harness: 'claude' }).harness, 'claude')
  assert.equal(
    localModelEntrySchema.parse({ id: 'x', model: 'qwen3:8b', harness: 'claude' }).harness,
    'claude',
  )

  // 「新增本地模型」表单的初值是第三条独立路径：用户什么都不点就直接保存，走的是它而不是
  // 上面两条。默认值漂移在这里最难发现——UI 上只是下拉框停在另一项。
  const { emptyLocalModelDraft } = await import('../src/app-helpers.ts')
  assert.equal(emptyLocalModelDraft().harness, 'codex')
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
