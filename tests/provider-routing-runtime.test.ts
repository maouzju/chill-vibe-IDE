import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDefaultState } from '../shared/default-state.ts'
import { mergeImportedProviderProfiles } from '../shared/provider-profile-import.ts'

const restoreEnvVar = (name: 'OPENAI_API_KEY' | 'OPENAI_BASE_URL', value: string | undefined) => {
  if (typeof value === 'string') {
    process.env[name] = value
    return
  }

  delete process.env[name]
}

describe('provider runtime routing', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `chill-vibe-provider-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('does not inject provider profile settings when both CLI routing and resilient proxy are disabled', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime } = await import('../server/providers.ts')
    const state = createDefaultState('')
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL

    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL

    state.settings.cliRoutingEnabled = false
    state.settings.resilientProxyEnabled = false
    state.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    await saveState(state)

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.deepEqual(runtime.args, [])
      assert.equal(runtime.env.OPENAI_API_KEY, undefined)
      assert.equal(runtime.env.OPENAI_BASE_URL, undefined)
      assert.notEqual(runtime.env.OPENAI_API_KEY, 'sk-codex')
      assert.notEqual(runtime.env.OPENAI_BASE_URL, 'https://codex.example/v1')
    } finally {
      restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey)
      restoreEnvVar('OPENAI_BASE_URL', originalOpenAiBaseUrl)
    }
  })

  it('does not inject provider profile settings when only resilient proxy is enabled (CLI routing controls injection)', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime } = await import('../server/providers.ts')
    const state = createDefaultState('')
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL

    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL

    state.settings.cliRoutingEnabled = false
    state.settings.resilientProxyEnabled = true
    state.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    await saveState(state)

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.deepEqual(runtime.args, [])
      assert.equal(runtime.env.OPENAI_API_KEY, undefined)
      assert.equal(runtime.env.OPENAI_BASE_URL, undefined)
    } finally {
      restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey)
      restoreEnvVar('OPENAI_BASE_URL', originalOpenAiBaseUrl)
    }
  })

  it('prefers staged runtime settings over stale persisted routing settings before the next save flushes', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import('../server/providers.ts')
    const persistedState = createDefaultState('')
    const stagedState = createDefaultState('')
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL

    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL

    persistedState.settings.cliRoutingEnabled = false
    await saveState(persistedState)

    stagedState.settings.cliRoutingEnabled = true
    stagedState.settings.resilientProxyEnabled = false
    stagedState.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    setProviderRuntimeSettingsOverride(stagedState.settings)

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.equal(runtime.env.OPENAI_API_KEY, 'sk-codex')
      assert.equal(runtime.env.OPENAI_BASE_URL, 'https://codex.example/v1')
      assert.notDeepEqual(runtime.args, [])
    } finally {
      setProviderRuntimeSettingsOverride(null)
      restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey)
      restoreEnvVar('OPENAI_BASE_URL', originalOpenAiBaseUrl)
    }
  })
})

describe('cc-switch provider profile import merge', () => {
  it('preserves existing secrets when a re-import omits the api key and keeps the current usable profile active', () => {
    const result = mergeImportedProviderProfiles(
      {
        activeProfileId: 'cc-switch:codex:default',
        profiles: [
          {
            id: 'cc-switch:codex:default',
            name: 'Codex Proxy',
            apiKey: 'sk-existing',
            baseUrl: 'https://codex.example/v1',
          },
        ],
      },
      'codex',
      [
        {
          sourceId: 'default',
          provider: 'codex',
          name: 'Codex Proxy',
          apiKey: '',
          baseUrl: '',
          active: true,
        },
      ],
    )

    assert.equal(result.collection.activeProfileId, 'cc-switch:codex:default')
    assert.deepEqual(result.collection.profiles, [
      {
        id: 'cc-switch:codex:default',
        name: 'Codex Proxy',
        apiKey: 'sk-existing',
        baseUrl: 'https://codex.example/v1',
      },
    ])
  })

  it('does not switch the active profile to a newly imported entry that lacks an api key', () => {
    const result = mergeImportedProviderProfiles(
      {
        activeProfileId: 'manual-codex',
        profiles: [
          {
            id: 'manual-codex',
            name: 'Manual Codex',
            apiKey: 'sk-manual',
            baseUrl: 'https://manual.example/v1',
          },
        ],
      },
      'codex',
      [
        {
          sourceId: 'default',
          provider: 'codex',
          name: 'Codex Import',
          apiKey: '',
          baseUrl: 'https://codex.example/v1',
          active: true,
        },
      ],
    )

    assert.equal(result.collection.activeProfileId, 'manual-codex')
    assert.deepEqual(result.collection.profiles, [
      {
        id: 'manual-codex',
        name: 'Manual Codex',
        apiKey: 'sk-manual',
        baseUrl: 'https://manual.example/v1',
      },
      {
        id: 'cc-switch:codex:default',
        name: 'Codex Import',
        apiKey: '',
        baseUrl: 'https://codex.example/v1',
      },
    ])
  })
})
