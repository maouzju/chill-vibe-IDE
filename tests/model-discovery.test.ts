import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'
import {
  buildDiscoveredModelLabel,
  findDiscoveredNewModels,
  parseModelListIds,
} from '../shared/model-discovery.ts'
import { resolveModelDiscoveryEndpoint } from '../server/model-discovery.ts'

// 2026-10-22 真实中转站（duckcoding）返回的列表：全是目录里已有、更旧或非对话的变体，必须一条都不提示。
const relayClaudeIds = [
  'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-opus-4-6',
  'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-4-6',
  'claude-sonnet-5', 'claude-sonnet-5-5',
]
const relayCodexIds = [
  'codex-auto-review', 'gpt-5.6-luna', 'gpt-5.6-luna-openai-compact', 'gpt-5.6-sol', 'gpt-5.6-sol-openai-compact',
  'gpt-5.6-terra', 'gpt-5.6-terra-openai-compact', 'gpt-6-astra', 'gpt-6-astra-openai-compact', 'gpt-6-luna',
  'gpt-6-luna-openai-compact', 'gpt-6-sol', 'gpt-6-sol-openai-compact', 'gpt-6.1-sol', 'gpt-6.1-sol-openai-compact',
]

test('parses Anthropic/OpenAI data[].id and Google models[].name lists', () => {
  assert.deepEqual(parseModelListIds({ data: [{ id: 'claude-opus-6' }, { id: '' }, {}] }), ['claude-opus-6'])
  assert.deepEqual(parseModelListIds({ models: [{ name: 'models/gemini-4.1-pro' }] }), ['gemini-4.1-pro'])
  assert.deepEqual(parseModelListIds('nope'), [])
  assert.deepEqual(parseModelListIds(null), [])
})

test('today\'s real relay lists produce no suggestions', () => {
  assert.deepEqual(findDiscoveredNewModels({ provider: 'claude', ids: relayClaudeIds }), [])
  assert.deepEqual(findDiscoveredNewModels({ provider: 'codex', ids: relayCodexIds }), [])
})

test('a newer version of a known tier is suggested, older and noise are not', () => {
  const found = findDiscoveredNewModels({
    provider: 'claude',
    ids: [...relayClaudeIds, 'claude-opus-6', 'claude-opus-6-20270101', 'claude-sonnet-4-9', 'claude-embed-6'],
  })
  assert.deepEqual(found.map((entry) => entry.model), ['claude-opus-6'])
  assert.equal(found[0]!.key, 'claude:claude-opus-6')
  assert.equal(found[0]!.label, 'Opus 6')

  const codex = findDiscoveredNewModels({
    provider: 'codex',
    ids: [...relayCodexIds, 'gpt-6.2-sol', 'gpt-6.2-sol-openai-compact', 'gpt-6-terra', 'text-embedding-4'],
  })
  // gpt-6-terra：目录里 Terra 只到 5.6，6 比它新 → 也算新型号
  assert.deepEqual(codex.map((entry) => entry.model), ['gpt-6.2-sol', 'gpt-6-terra'])
})

test('a brand-new tier must be at least the provider\'s newest major version', () => {
  assert.deepEqual(
    findDiscoveredNewModels({ provider: 'claude', ids: ['claude-maestro-6', 'claude-instant-1-2'] }).map((e) => e.model),
    ['claude-maestro-6'],
  )
  assert.deepEqual(
    findDiscoveredNewModels({ provider: 'gemini', ids: ['gemini-4.1-pro-preview', 'gemini-3.9-flash', 'gemini-1.5-pro'] })
      .map((e) => e.model),
    ['gemini-4.1-pro-preview', 'gemini-3.9-flash'],
  )
})

test('already-seen and already-custom models are skipped; duplicates collapse', () => {
  const found = findDiscoveredNewModels({
    provider: 'claude',
    ids: ['claude-opus-6', 'claude-opus-6', 'claude-fable-6', 'claude-haiku-6'],
    seen: ['claude:claude-fable-6'],
    customModels: [{ id: 'x', provider: 'claude', model: 'claude-haiku-6', label: '' }],
  })
  assert.deepEqual(found.map((entry) => entry.model), ['claude-opus-6'])
})

test('labels read like the built-in catalog', () => {
  assert.equal(buildDiscoveredModelLabel('claude', 'claude-opus-6-1'), 'Opus 6.1')
  assert.equal(buildDiscoveredModelLabel('codex', 'gpt-6.2-sol'), 'GPT-6.2 Sol')
  assert.equal(buildDiscoveredModelLabel('codex', 'gpt-7'), 'GPT-7')
  assert.equal(buildDiscoveredModelLabel('gemini', 'gemini-4.1-pro-preview'), 'Gemini 4.1 Pro Preview')
})

test('seenDiscoveredModels defaults to empty and normalizes garbage away', () => {
  assert.deepEqual(createDefaultSettings().seenDiscoveredModels, [])
  const normalized = normalizeAppSettings({
    ...createDefaultSettings(),
    seenDiscoveredModels: ['claude:claude-opus-6', 'claude:claude-opus-6', '', 3 as unknown as string],
  })
  assert.deepEqual(normalized.seenDiscoveredModels, ['claude:claude-opus-6'])
  assert.deepEqual(normalizeAppSettings({ ...createDefaultSettings(), seenDiscoveredModels: undefined as never }).seenDiscoveredModels, [])
})

const makeIo = (files: Record<string, string>, env: Record<string, string> = {}) => ({
  homedir: '/fake-home',
  env,
  readFile: async (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/')
    if (normalized in files) return files[normalized]!
    throw new Error('ENOENT')
  },
})

test('discovery uses the in-app profile when routing is on', async () => {
  const settings = createDefaultSettings()
  settings.cliRoutingEnabled = true
  settings.providerProfiles.claude = {
    activeProfileId: 'p1',
    profiles: [{ id: 'p1', name: 'relay', apiKey: 'sk-app', baseUrl: 'https://relay.example/' }],
  }
  const endpoint = await resolveModelDiscoveryEndpoint('claude', settings, makeIo({}))
  assert.equal(endpoint?.url, 'https://relay.example/v1/models')
  assert.equal(endpoint?.headers['x-api-key'], 'sk-app')
})

test('discovery falls back to ~/.claude/settings.json env when routing is off', async () => {
  const settings = createDefaultSettings()
  const endpoint = await resolveModelDiscoveryEndpoint(
    'claude',
    settings,
    makeIo(
      { '/fake-home/.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-file', ANTHROPIC_BASE_URL: 'https://a.example' } }) },
      { ANTHROPIC_API_KEY: 'sk-env', ANTHROPIC_BASE_URL: 'https://env.example' },
    ),
  )
  assert.equal(endpoint?.url, 'https://a.example/v1/models')
  assert.equal(endpoint?.headers.authorization, 'Bearer sk-file')
})

test('codex discovery reads the active model_provider section of config.toml', async () => {
  const settings = createDefaultSettings()
  const toml = [
    'model = "gpt-6.1-sol"',
    'model_provider = "duck"',
    '[model_providers.other]',
    'base_url = "https://wrong.example/v1"',
    '[model_providers.duck]',
    'name = "duck"',
    'base_url = "https://duck.example/v1/"',
  ].join('\n')
  const endpoint = await resolveModelDiscoveryEndpoint(
    'codex',
    settings,
    makeIo({ '/fake-home/.codex/config.toml': toml, '/fake-home/.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-codex' }) }),
  )
  assert.equal(endpoint?.url, 'https://duck.example/v1/models')
  assert.equal(endpoint?.headers.authorization, 'Bearer sk-codex')

  const withEnvKey = await resolveModelDiscoveryEndpoint(
    'codex',
    settings,
    makeIo(
      { '/fake-home/.codex/config.toml': `${toml}\nenv_key = "DUCK_KEY"` },
      { DUCK_KEY: 'sk-from-env' },
    ),
  )
  assert.equal(withEnvKey?.headers.authorization, 'Bearer sk-from-env')
})

test('no key anywhere → no endpoint (never calls out unauthenticated)', async () => {
  const settings = createDefaultSettings()
  assert.equal(await resolveModelDiscoveryEndpoint('claude', settings, makeIo({})), null)
  assert.equal(await resolveModelDiscoveryEndpoint('codex', settings, makeIo({})), null)
  assert.equal(await resolveModelDiscoveryEndpoint('gemini', settings, makeIo({})), null)
})
