import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard, createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'
import { getLocaleText } from '../shared/i18n.ts'
import { appSettingsSchema, appStateSchema } from '../shared/schema.ts'
import {
  armWakeTimerBatch,
  buildCanceledWakeTimerDraft,
  isWakeTimerConditionReady,
  mergeWakeTimerRequests,
  removeCompletedWakeTimerTarget,
  shouldReleaseCompletedWakeTimerTarget,
  shouldQueueWakeTimerSend,
  shouldConfirmWakeTimerCompletion,
} from '../src/components/wake-timer.ts'

const request = (id: string, prompt: string) => ({
  id,
  prompt,
  attachments: [],
})

describe('wake timer settings and card defaults', () => {
  it('enables the global feature by default while each new card stays disabled', () => {
    const settings = createDefaultSettings()
    const card = createCard('Timer card')

    assert.equal(settings.wakeTimerEnabled, true)
    assert.equal(appSettingsSchema.parse({}).wakeTimerEnabled, true)
    assert.equal(
      appStateSchema.parse({
        version: 1,
        columns: [],
        updatedAt: '2026-08-02T00:00:00.000Z',
      }).settings.wakeTimerEnabled,
      true,
    )
    assert.equal(card.wakeTimerActive, false)
    assert.equal(card.wakeTimerMode, 'workspace-agents')
    assert.equal(card.wakeTimerDurationMinutes, 30)
    assert.deepEqual(card.wakeTimerQueuedSends, [])
    assert.deepEqual(card.wakeTimerPendingTargetIds, [])
  })

  it('defaults missing legacy settings to enabled and preserves explicit choices', () => {
    assert.equal(normalizeAppSettings({}).wakeTimerEnabled, true)
    assert.equal(normalizeAppSettings({ wakeTimerEnabled: true }).wakeTimerEnabled, true)
    assert.equal(normalizeAppSettings({ wakeTimerEnabled: false }).wakeTimerEnabled, false)
  })

  it('uses the product name 计划唤醒 in Chinese settings surfaces', () => {
    const text = getLocaleText('zh-CN')

    assert.equal(text.wakeTimerFeatureLabel, '计划唤醒')
    assert.equal(text.wakeTimerLabel, '计划唤醒')
  })
})

describe('wake timer arming', () => {
  const cards = [
    { id: 'left-idle', status: 'idle' as const, isAgent: true },
    { id: 'left-running', status: 'streaming' as const, isAgent: true },
    { id: 'tool-running', status: 'streaming' as const, isAgent: false },
    { id: 'owner', status: 'idle' as const, isAgent: true },
    { id: 'other-running', status: 'streaming' as const, isAgent: true },
  ]

  it('freezes only currently running peer agents for workspace mode', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'workspace-agents',
        ownerCardId: 'owner',
        durationMinutes: 30,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards,
        paneTabIds: ['left-idle', 'left-running', 'owner'],
      }),
      {
        ok: true,
        armedAt: '2026-07-25T00:00:00.000Z',
        wakeAt: undefined,
        pendingTargetIds: ['left-running', 'other-running'],
      },
    )
  })

  it('treats a Claude card waiting on native background work as a busy peer', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'workspace-agents',
        ownerCardId: 'owner',
        durationMinutes: 30,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards: [
          { id: 'background-peer', status: 'idle' as const, isAgent: true, backgroundWorkPending: true },
          { id: 'owner', status: 'idle' as const, isAgent: true },
        ],
        paneTabIds: ['background-peer', 'owner'],
      }),
      {
        ok: true,
        armedAt: '2026-07-25T00:00:00.000Z',
        wakeAt: undefined,
        pendingTargetIds: ['background-peer'],
      },
    )
  })

  it('binds left-tab mode to the direct left agent only', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'left-tab',
        ownerCardId: 'owner',
        durationMinutes: 30,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards,
        paneTabIds: ['left-idle', 'left-running', 'owner'],
      }),
      {
        ok: true,
        armedAt: '2026-07-25T00:00:00.000Z',
        wakeAt: undefined,
        pendingTargetIds: ['left-running'],
      },
    )
  })

  it('chains left-tab mode onto a left neighbour that is itself waiting to wake', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'left-tab',
        ownerCardId: 'owner',
        durationMinutes: 30,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards: [
          { id: 'left-pending', status: 'idle' as const, isAgent: true, hasPendingWakeBatch: true },
          { id: 'owner', status: 'idle' as const, isAgent: true },
        ],
        paneTabIds: ['left-pending', 'owner'],
      }),
      {
        ok: true,
        armedAt: '2026-07-25T00:00:00.000Z',
        wakeAt: undefined,
        pendingTargetIds: ['left-pending'],
      },
    )
  })

  it('keeps workspace mode blind to peers that are only waiting to wake', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'workspace-agents',
        ownerCardId: 'owner',
        durationMinutes: 30,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards: [
          { id: 'peer-pending', status: 'idle' as const, isAgent: true, hasPendingWakeBatch: true },
          { id: 'owner', status: 'idle' as const, isAgent: true },
        ],
        paneTabIds: ['peer-pending', 'owner'],
      }),
      {
        ok: true,
        armedAt: '2026-07-25T00:00:00.000Z',
        wakeAt: undefined,
        pendingTargetIds: [],
      },
    )
  })

  it('rejects left-tab mode when the direct left tab is not an agent', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'left-tab',
        ownerCardId: 'owner',
        durationMinutes: 30,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards,
        paneTabIds: ['left-running', 'tool-running', 'owner'],
      }),
      { ok: false, reason: 'left-target-unavailable' },
    )
  })

  it('stores an absolute wake time for duration mode', () => {
    assert.deepEqual(
      armWakeTimerBatch({
        mode: 'duration',
        ownerCardId: 'owner',
        durationMinutes: 15,
        nowMs: Date.parse('2026-07-25T00:00:00.000Z'),
        cards,
        paneTabIds: ['owner'],
      }),
      {
        ok: true,
        armedAt: '2026-07-25T00:00:00.000Z',
        wakeAt: '2026-07-25T00:15:00.000Z',
        pendingTargetIds: [],
      },
    )
  })
})

describe('wake timer release', () => {
  it('queues only ordinary user sends while the feature and card timer are active', () => {
    assert.equal(shouldQueueWakeTimerSend({ featureEnabled: true, cardActive: true, origin: 'user' }), true)
    assert.equal(shouldQueueWakeTimerSend({ featureEnabled: false, cardActive: true, origin: 'user' }), false)
    assert.equal(shouldQueueWakeTimerSend({ featureEnabled: true, cardActive: false, origin: 'user' }), false)
    assert.equal(shouldQueueWakeTimerSend({ featureEnabled: true, cardActive: true, origin: 'auto-urge' }), false)
    assert.equal(shouldQueueWakeTimerSend({ featureEnabled: true, cardActive: true, origin: 'wake-timer-release' }), false)
    assert.equal(shouldQueueWakeTimerSend({
      featureEnabled: true,
      cardActive: true,
      origin: 'user',
      answersPendingAskUser: true,
    }), false)
  })

  it('waits for every frozen target and for the owner card to be idle', () => {
    assert.equal(isWakeTimerConditionReady({
      mode: 'workspace-agents',
      ownerStatus: 'idle',
      pendingTargetIds: ['agent-2'],
      wakeAt: undefined,
      nowMs: Date.now(),
    }), false)

    assert.equal(isWakeTimerConditionReady({
      mode: 'workspace-agents',
      ownerStatus: 'idle',
      pendingTargetIds: [],
      activePeerIds: ['agent-started-after-arming'],
      wakeAt: undefined,
      nowMs: Date.now(),
    }), false)

    assert.equal(isWakeTimerConditionReady({
      mode: 'workspace-agents',
      ownerStatus: 'idle',
      pendingTargetIds: [],
      activePeerIds: [],
      wakeAt: undefined,
      nowMs: Date.now(),
    }), true)

    assert.equal(isWakeTimerConditionReady({
      mode: 'workspace-agents',
      ownerStatus: 'idle',
      ownerBackgroundWorkPending: true,
      pendingTargetIds: [],
      activePeerIds: [],
      wakeAt: undefined,
      nowMs: Date.now(),
    }), false)

    assert.equal(isWakeTimerConditionReady({
      mode: 'workspace-agents',
      ownerStatus: 'streaming',
      pendingTargetIds: [],
      wakeAt: undefined,
      nowMs: Date.now(),
    }), false)
  })

  it('releases duration mode only after its absolute time', () => {
    const wakeAt = '2026-07-25T00:15:00.000Z'
    assert.equal(isWakeTimerConditionReady({
      mode: 'duration',
      ownerStatus: 'idle',
      pendingTargetIds: [],
      wakeAt,
      nowMs: Date.parse('2026-07-25T00:14:59.999Z'),
    }), false)
    assert.equal(isWakeTimerConditionReady({
      mode: 'duration',
      ownerStatus: 'idle',
      pendingTargetIds: [],
      wakeAt,
      nowMs: Date.parse('2026-07-25T00:15:00.000Z'),
    }), true)
  })

  it('removes a normally completed target without disturbing the rest', () => {
    assert.deepEqual(
      removeCompletedWakeTimerTarget(['agent-1', 'agent-2', 'agent-1'], 'agent-1'),
      ['agent-2'],
    )
  })

  it('does not count a stopped/error run or the transient idle before auto urge starts', () => {
    assert.equal(shouldConfirmWakeTimerCompletion({
      normalCompletion: false,
      statusAfterStability: 'idle',
    }), false)
    assert.equal(shouldConfirmWakeTimerCompletion({
      normalCompletion: true,
      statusAfterStability: 'streaming',
    }), false)
    assert.equal(shouldConfirmWakeTimerCompletion({
      normalCompletion: true,
      statusAfterStability: 'idle',
    }), true)
    assert.equal(shouldConfirmWakeTimerCompletion({
      normalCompletion: true,
      statusAfterStability: 'idle',
      backgroundWorkPending: true,
    }), false)
  })

  it('keeps only downstream left-tab batches blocked while the completed target is still waiting to wake', () => {
    assert.equal(shouldReleaseCompletedWakeTimerTarget({
      waitingMode: 'left-tab',
      completedTargetHasPendingWakeBatch: true,
    }), false)
    assert.equal(shouldReleaseCompletedWakeTimerTarget({
      waitingMode: 'workspace-agents',
      completedTargetHasPendingWakeBatch: true,
    }), true)
    assert.equal(shouldReleaseCompletedWakeTimerTarget({
      waitingMode: 'left-tab',
      completedTargetHasPendingWakeBatch: true,
      forceRelease: true,
    }), true)
  })

  it('merges all queued messages into one ordered activation batch', () => {
    assert.deepEqual(
      mergeWakeTimerRequests([
        request('one', '先检查构建'),
        {
          id: 'two',
          prompt: '再运行截图验证',
          attachments: [{
            id: 'image-1',
            fileName: 'evidence.png',
            mimeType: 'image/png' as const,
            sizeBytes: 128,
          }],
        },
      ]),
      {
        prompt: '先检查构建\n\n再运行截图验证',
        attachments: [{
          id: 'image-1',
          fileName: 'evidence.png',
          mimeType: 'image/png',
          sizeBytes: 128,
        }],
      },
    )
  })

  it('restores a canceled batch before the current composer draft without losing attachments', () => {
    assert.deepEqual(
      buildCanceledWakeTimerDraft({
        requests: [
          request('one', '先检查构建'),
          {
            id: 'two',
            prompt: '再运行截图验证',
            attachments: [{
              id: 'queued-image',
              fileName: 'queued.png',
              mimeType: 'image/png' as const,
              sizeBytes: 128,
            }],
          },
        ],
        currentDraft: '我还在补充验收条件',
        currentDraftAttachments: [{
          id: 'draft-image',
          fileName: 'draft.png',
          mimeType: 'image/png' as const,
          sizeBytes: 256,
        }],
      }),
      {
        draft: '先检查构建\n\n再运行截图验证\n\n我还在补充验收条件',
        draftAttachments: [
          {
            id: 'queued-image',
            fileName: 'queued.png',
            mimeType: 'image/png',
            sizeBytes: 128,
          },
          {
            id: 'draft-image',
            fileName: 'draft.png',
            mimeType: 'image/png',
            sizeBytes: 256,
          },
        ],
      },
    )
  })
})
