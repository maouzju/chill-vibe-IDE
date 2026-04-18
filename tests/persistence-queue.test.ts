import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import {
  createQueuedStateSaveScheduler,
  getPersistenceVersion,
  shouldPersistActionImmediately,
  shouldSyncRuntimeSettings,
  shouldPauseQueuedStateSave,
} from '../src/hooks/persistence-queue.ts'

describe('persistence queue', () => {
  it('uses updatedAt as the lightweight persistence version when present', () => {
    const state = createDefaultState('')
    state.updatedAt = '2026-04-07T10:00:00.000Z'

    assert.equal(getPersistenceVersion(state), '2026-04-07T10:00:00.000Z')
  })

  it('pauses queued saves while any card is streaming', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      status: 'streaming',
    }

    assert.equal(shouldPauseQueuedStateSave(state), true)
  })

  it('keeps queued saves enabled when no card is streaming', () => {
    const state = createDefaultState('')

    assert.equal(shouldPauseQueuedStateSave(state), false)
  })

  it('forces immediate persistence for model picks when another card is still streaming', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      status: 'streaming',
    }

    assert.equal(shouldPersistActionImmediately('selectCardModel', state), true)
    assert.equal(shouldPersistActionImmediately('updateRequestModels', state), false)
  })

  it('keeps model picks on the queued path when no stream is active', () => {
    const state = createDefaultState('')

    assert.equal(shouldPersistActionImmediately('selectCardModel', state), false)
  })

  it('flags runtime-routing changes for immediate backend sync', () => {
    const state = createDefaultState('')

    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { cliRoutingEnabled: false } }), true)
    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { resilientProxyEnabled: false } }), true)
    assert.equal(
      shouldSyncRuntimeSettings({
        type: 'updateSettings',
        patch: {
          providerProfiles: state.settings.providerProfiles,
        },
      }),
      true,
    )
    assert.equal(
      shouldSyncRuntimeSettings({
        type: 'upsertProviderProfile',
        provider: 'codex',
        profile: {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      }),
      true,
    )
    assert.equal(
      shouldSyncRuntimeSettings({
        type: 'setActiveProviderProfile',
        provider: 'codex',
        profileId: 'codex-profile-1',
      }),
      true,
    )
    assert.equal(
      shouldSyncRuntimeSettings({
        type: 'removeProviderProfile',
        provider: 'codex',
        profileId: 'codex-profile-1',
      }),
      true,
    )
    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { theme: 'dark' } }), false)
  })

  it('batches rapid schedules and flushes only the newest state', () => {
    const queuedTitles: string[] = []
    const pendingTimers = new Map<unknown, () => void>()
    let nextTimerId = 1

    const scheduler = createQueuedStateSaveScheduler({
      delayMs: 200,
      queueStateSave: (state) => {
        queuedTitles.push(state.columns[0]?.title ?? '')
      },
      setTimeoutFn: (callback) => {
        const id = nextTimerId++
        pendingTimers.set(id, callback)
        return id
      },
      clearTimeoutFn: (id) => {
        pendingTimers.delete(id)
      },
    })

    const first = createDefaultState('')
    first.updatedAt = '2026-04-07T10:00:00.000Z'
    first.columns[0]!.title = 'First save'

    const second = createDefaultState('')
    second.updatedAt = '2026-04-07T10:00:01.000Z'
    second.columns[0]!.title = 'Latest save'

    scheduler.schedule(first)
    scheduler.schedule(second)

    assert.equal(pendingTimers.size, 1, 'expected a single pending flush after rescheduling')

    pendingTimers.values().next().value?.()

    assert.deepEqual(queuedTitles, ['Latest save'])
  })

  it('flushes pending state immediately when requested', () => {
    const queuedTitles: string[] = []

    const scheduler = createQueuedStateSaveScheduler({
      delayMs: 200,
      queueStateSave: (state) => {
        queuedTitles.push(state.columns[0]?.title ?? '')
      },
      setTimeoutFn: (callback) => callback as unknown as number,
      clearTimeoutFn: () => undefined,
    })

    const state = createDefaultState('')
    state.updatedAt = '2026-04-07T10:00:00.000Z'
    state.columns[0]!.title = 'Flush now'

    scheduler.schedule(state)
    scheduler.flush()

    assert.deepEqual(queuedTitles, ['Flush now'])
  })
})
