import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'
import {
  MODEL_OPTIONS,
  MODEL_SUCCESSORS,
  findModelUpgradeSuggestions,
  isModelPickerOptionVisible,
  listModelUpgradeKeys,
} from '../shared/models.ts'

test('a default model beaten by a built-in successor triggers one suggestion per provider', () => {
  const suggestions = findModelUpgradeSuggestions({ codex: 'gpt-6-sol', claude: 'claude-sonnet-5' }, [])

  assert.deepEqual(
    suggestions.map(({ provider, from, to }) => ({ provider, from, to })),
    [
      { provider: 'codex', from: 'gpt-6-sol', to: 'gpt-6.1-sol' },
      { provider: 'claude', from: 'claude-sonnet-5', to: 'claude-sonnet-5-5' },
    ],
  )
})

test('no suggestion when the default is already the newest of its tier or a custom name', () => {
  assert.deepEqual(
    findModelUpgradeSuggestions({ codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5-5' }, []),
    [],
  )
  assert.deepEqual(
    findModelUpgradeSuggestions({ codex: 'my-relay-model', claude: '__local__:abc' }, []),
    [],
  )
})

test('an acknowledged suggestion is never shown again', () => {
  const [first] = findModelUpgradeSuggestions({ codex: 'gpt-6-sol', claude: 'claude-opus-5-5' }, [])
  assert.ok(first)
  assert.deepEqual(
    findModelUpgradeSuggestions({ codex: 'gpt-6-sol', claude: 'claude-opus-5-5' }, [first.key]),
    [],
  )
})

test('prototype property names are never mistaken for a successor', () => {
  assert.deepEqual(
    findModelUpgradeSuggestions({ codex: 'constructor', claude: 'toString' }, []),
    [],
  )
})

test('every successor is a visible picker model and every outdated model is a known option', () => {
  for (const provider of ['codex', 'claude'] as const) {
    for (const [from, to] of Object.entries(MODEL_SUCCESSORS[provider])) {
      assert.ok(
        MODEL_OPTIONS.some((option) => option.provider === provider && option.model === from),
        `${from} must exist in MODEL_OPTIONS`,
      )
      assert.ok(
        MODEL_OPTIONS.some(
          (option) => option.provider === provider && option.model === to && isModelPickerOptionVisible(option),
        ),
        `${to} must be a visible picker option`,
      )
      assert.notEqual(from, to)
    }
  }
})

test('a fresh install is not nagged, but a saved state from before this feature is', () => {
  const fresh = createDefaultSettings()
  assert.deepEqual(fresh.acknowledgedModelUpgrades, listModelUpgradeKeys())
  assert.deepEqual(findModelUpgradeSuggestions(fresh.requestModels, fresh.acknowledgedModelUpgrades), [])

  const legacy = normalizeAppSettings({
    ...createDefaultSettings(),
    acknowledgedModelUpgrades: undefined,
    requestModels: { codex: 'gpt-6-sol', claude: 'claude-opus-5-5' },
  } as never)
  assert.deepEqual(legacy.acknowledgedModelUpgrades, [])
  assert.equal(
    findModelUpgradeSuggestions(legacy.requestModels, legacy.acknowledgedModelUpgrades).length,
    1,
  )
})

test('acknowledged keys survive normalization and drop junk', () => {
  const settings = normalizeAppSettings({
    ...createDefaultSettings(),
    acknowledgedModelUpgrades: ['codex:gpt-6-sol>gpt-6.1-sol', 'codex:gpt-6-sol>gpt-6.1-sol', 7, ''],
  } as never)

  assert.deepEqual(settings.acknowledgedModelUpgrades, ['codex:gpt-6-sol>gpt-6.1-sol'])
})

test('the upgrade dialog is wired into App with one-click switch and a persisted acknowledgement', async () => {
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const localeSource = await readFile(new URL('../shared/i18n.ts', import.meta.url), 'utf8')
  const stateSource = await readFile(new URL('../src/state.ts', import.meta.url), 'utf8')

  assert.match(appSource, /findModelUpgradeSuggestions\(/)
  assert.match(appSource, /model-upgrade-dialog-title/)
  assert.match(appSource, /acknowledgedModelUpgrades/)
  assert.match(appSource, /confirmModelUpgrade/)
  assert.match(appSource, /dismissModelUpgrade/)
  assert.match(stateSource, /'acknowledgedModelUpgrades'/)

  assert.match(localeSource, /modelUpgradeDialogTitle/)
  assert.match(localeSource, /modelUpgradeDialogConfirm/)
  assert.match(localeSource, /modelUpgradeDialogKeep/)
  assert.match(appSource, /text\.modelUpgradeItemSeparator/)
  assert.doesNotMatch(appSource, /\{'：'\}/)
})
