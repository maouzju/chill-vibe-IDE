import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultSettings } from '../shared/default-state.ts'
import type { AppState, AppStateLoadResponse, ProviderStatus } from '../shared/schema.ts'
import { startInitialAppLoad } from '../src/app-initial-load.ts'

const createState = (): AppState => ({
  version: 1,
  settings: {
    ...createDefaultSettings('en'),
    language: 'en',
    theme: 'dark',
    activeTopTab: 'ambience',
    fontScale: 1,
    lineHeightScale: 1,
    resilientProxyEnabled: true,
    cliRoutingEnabled: true,
    resilientProxyStallTimeoutSec: 60,
    resilientProxyFirstByteTimeoutSec: 90,
    resilientProxyMaxRetries: 6,
    musicAlbumCoverEnabled: false,
    gitCardEnabled: true,
    fileTreeCardEnabled: true,
    stickyNoteCardEnabled: true,
    experimentalMusicEnabled: false,
    experimentalWhiteNoiseEnabled: false,
    experimentalWeatherEnabled: false,
    agentDoneSoundEnabled: false,
    agentDoneSoundVolume: 0.7,
    autoUrgeEnabled: false,
    autoUrgeMessage: '你必须百分百验证通过你要解决的问题，才能结束回答，如果确定解决了，回复YES，否则不准停下来',
    autoUrgeSuccessKeyword: 'YES',
    weatherCity: '',
    gitAgentModel: 'gpt-5.4 low',
    requestModels: {
      codex: 'gpt-5.4',
      claude: 'claude-opus-4-6',
    },
    modelReasoningEfforts: {
      codex: {},
      claude: {},
    },
    providerProfiles: {
      codex: {
        activeProfileId: '',
        profiles: [],
      },
      claude: {
        activeProfileId: '',
        profiles: [],
      },
    },
    recentWorkspaces: [],
  },
  columns: [],
  sessionHistory: [],
  updatedAt: '2026-04-06T00:00:00.000Z',
})

const createLoadResponse = (state: AppState): AppStateLoadResponse => ({
  state,
  recovery: {
    startup: null,
    recentCrash: null,
    interruptedSessions: null,
  },
})

test('startInitialAppLoad does not block restored state on slow provider checks', async () => {
  const state = createState()
  const providers: ProviderStatus[] = [
    { provider: 'codex', available: true, command: 'codex.cmd' },
    { provider: 'claude', available: true, command: 'claude.cmd' },
  ]

  let resolveProviders: ((value: ProviderStatus[]) => void) | undefined
  let providerFetchStarted = false
  const providerFetch = new Promise<ProviderStatus[]>((resolve) => {
    providerFetchStarted = true
    resolveProviders = resolve
  })

  const load = startInitialAppLoad({
    fetchState: async () => createLoadResponse(state),
    fetchProviders: async () => providerFetch,
  })

  const { state: hydratedState, providersPromise, recovery } = await load

  assert.equal(providerFetchStarted, true)
  assert.equal(hydratedState, state)
  assert.equal(recovery.startup, null)
  assert.equal(recovery.recentCrash, null)

  let providersSettled = false
  void providersPromise.then(() => {
    providersSettled = true
  })
  await Promise.resolve()
  assert.equal(providersSettled, false)

  resolveProviders?.(providers)
  assert.deepEqual(await providersPromise, providers)
})

test('startInitialAppLoad treats provider lookup failures as non-blocking', async () => {
  const state = createState()

  const { state: hydratedState, providersPromise, recovery } = await startInitialAppLoad({
    fetchState: async () => createLoadResponse(state),
    fetchProviders: async () => {
      throw new Error('provider lookup failed')
    },
  })

  assert.equal(hydratedState, state)
  assert.equal(recovery.startup, null)
  assert.equal(await providersPromise, null)
})

test('startInitialAppLoad preserves startup recovery metadata for the renderer prompt', async () => {
  const state = createState()

  const startup = {
    issues: [
      {
        kind: 'newer-temp-state' as const,
        fileName: 'state.tmp.123456',
        updatedAt: '2026-04-11T05:00:00.000Z',
        details: 'A newer temporary state file was left behind by an interrupted save.',
      },
    ],
    options: [
      {
        id: 'current:state.json',
        source: 'current-state' as const,
        fileName: 'state.json',
        updatedAt: '2026-04-11T04:55:00.000Z',
        recommended: false,
      },
      {
        id: 'temp:state.tmp.123456',
        source: 'temp-state' as const,
        fileName: 'state.tmp.123456',
        updatedAt: '2026-04-11T05:00:00.000Z',
        recommended: true,
      },
    ],
    currentOptionId: 'current:state.json',
  }

  const recentCrash = {
    crashedAt: '2026-04-11T05:10:00.000Z',
    errorSummary: 'ReferenceError: renderCard is not defined',
    sessionHistoryEntryIds: ['history-1', 'history-2'],
  }

  const { recovery } = await startInitialAppLoad({
    fetchState: async () => ({
      state,
      recovery: {
        startup,
        recentCrash,
        interruptedSessions: null,
      },
    }),
    fetchProviders: async () => [],
  })

  assert.deepEqual(recovery, {
    startup,
    recentCrash,
    interruptedSessions: null,
  })
})
