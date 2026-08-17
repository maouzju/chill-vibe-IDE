import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard, createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'
import { getLocaleText } from '../shared/i18n.ts'
import { appSettingsSchema, appStateSchema, chatCardSchema, type ChatCard } from '../shared/schema.ts'
import {
  armWakeTimerBatch,
  buildCanceledWakeTimerDraft,
  buildWakeTimerBatchEndPatch,
  collectWakeTimerDefaultPreference,
  isWakeTimerConditionReady,
  mergeWakeTimerRequests,
  removeCompletedWakeTimerTarget,
  resolveSupervisorWakeTargets,
  shouldArmWakeTimerForDeferSend,
  shouldReleaseCompletedWakeTimerTarget,
  shouldQueueWakeTimerSend,
  shouldConfirmWakeTimerCompletion,
  rearmWakeTimerBatchForPatch,
  summarizeWakeTimerBatch,
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

  it('remembers the last picked wake condition as the default for new chats', () => {
    const settings = createDefaultSettings()

    assert.equal(settings.wakeTimerDefaultMode, 'workspace-agents')
    assert.equal(settings.wakeTimerDefaultDurationMinutes, 30)
    assert.equal(appSettingsSchema.parse({}).wakeTimerDefaultMode, 'workspace-agents')
    assert.equal(appSettingsSchema.parse({}).wakeTimerDefaultDurationMinutes, 30)
    assert.equal(
      appStateSchema.parse({
        version: 1,
        columns: [],
        updatedAt: '2026-08-14T00:00:00.000Z',
      }).settings.wakeTimerDefaultMode,
      'workspace-agents',
    )
    assert.equal(normalizeAppSettings({}).wakeTimerDefaultMode, 'workspace-agents')
    assert.equal(normalizeAppSettings({}).wakeTimerDefaultDurationMinutes, 30)
    assert.equal(
      normalizeAppSettings({ wakeTimerDefaultMode: 'duration', wakeTimerDefaultDurationMinutes: 120 })
        .wakeTimerDefaultMode,
      'duration',
    )
    assert.equal(
      normalizeAppSettings({ wakeTimerDefaultMode: 'duration', wakeTimerDefaultDurationMinutes: 120 })
        .wakeTimerDefaultDurationMinutes,
      120,
    )
  })
})

describe('remembering the picked wake condition', () => {
  it('extracts the user-picked mode and duration from a card patch', () => {
    assert.deepEqual(collectWakeTimerDefaultPreference({ wakeTimerMode: 'left-tab' }), {
      wakeTimerDefaultMode: 'left-tab',
    })
    assert.deepEqual(collectWakeTimerDefaultPreference({ wakeTimerDurationMinutes: 90 }), {
      wakeTimerDefaultDurationMinutes: 90,
    })
    assert.deepEqual(
      collectWakeTimerDefaultPreference({ wakeTimerMode: 'duration', wakeTimerDurationMinutes: 45 }),
      { wakeTimerDefaultMode: 'duration', wakeTimerDefaultDurationMinutes: 45 },
    )
  })

  it('ignores patches that carry no wake condition choice', () => {
    assert.equal(collectWakeTimerDefaultPreference({ wakeTimerActive: true }), null)
    assert.equal(collectWakeTimerDefaultPreference({ draft: 'hello' }), null)
    assert.equal(collectWakeTimerDefaultPreference({}), null)
  })

  it('drops out-of-range durations instead of persisting them as the default', () => {
    assert.equal(collectWakeTimerDefaultPreference({ wakeTimerDurationMinutes: 0 }), null)
    assert.equal(collectWakeTimerDefaultPreference({ wakeTimerDurationMinutes: 999_999 }), null)
    assert.equal(collectWakeTimerDefaultPreference({ wakeTimerDurationMinutes: Number.NaN }), null)
  })
})

describe('right-click send on an idle card', () => {
  const base = {
    featureEnabled: true,
    mode: 'defer' as const,
    origin: 'user' as const,
    cardStatus: 'idle' as const,
    isToolCard: false,
  }

  it('turns a right-click send into a wake timer batch when nothing is running', () => {
    assert.equal(shouldArmWakeTimerForDeferSend(base), true)
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, cardStatus: 'error' }), true)
  })

  it('keeps the FIFO defer queue while the card is answering', () => {
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, cardStatus: 'streaming' }), false)
  })

  it('leaves ordinary left-click sends untouched', () => {
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, mode: undefined }), false)
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, mode: 'auto' }), false)
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, mode: 'interrupt' }), false)
  })

  it('never arms from automated senders, tool cards, or a disabled feature', () => {
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, featureEnabled: false }), false)
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, origin: 'auto-urge' }), false)
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, origin: 'wake-timer-release' }), false)
    assert.equal(shouldArmWakeTimerForDeferSend({ ...base, isToolCard: true }), false)
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

describe('changing the wake condition while a batch is pending', () => {
  const cards = [
    { id: 'left-running', status: 'streaming' as const, isAgent: true },
    { id: 'owner', status: 'idle' as const, isAgent: true },
    { id: 'peer-running', status: 'streaming' as const, isAgent: true },
  ]
  const pendingOwner = {
    id: 'owner',
    wakeTimerMode: 'workspace-agents' as const,
    wakeTimerDurationMinutes: 30,
    wakeTimerQueuedSends: [request('one', '先检查构建')],
  }
  const context = {
    cards,
    paneTabIds: ['left-running', 'owner'],
    nowMs: Date.parse('2026-08-15T00:00:00.000Z'),
  }

  it('re-arms the pending batch onto the newly picked condition', () => {
    assert.deepEqual(
      rearmWakeTimerBatchForPatch({
        patch: { wakeTimerMode: 'duration', wakeTimerDurationMinutes: 45 },
        card: pendingOwner,
        ...context,
      }),
      {
        ok: true,
        patch: {
          wakeTimerArmedAt: '2026-08-15T00:00:00.000Z',
          wakeTimerWakeAt: '2026-08-15T00:45:00.000Z',
          wakeTimerPendingTargetIds: [],
        },
      },
    )
  })

  it('restarts the duration countdown from the moment the user changed it', () => {
    const result = rearmWakeTimerBatchForPatch({
      patch: { wakeTimerDurationMinutes: 10 },
      card: {
        ...pendingOwner,
        // 旧的 armedAt/wakeAt 故意不传：重算只看"改的这一刻"，
        // 沿用首条入队时间会让改期后立刻到点。
        wakeTimerMode: 'duration' as const,
      },
      ...context,
    })

    assert.equal(result?.ok, true)
    assert.equal(result?.ok === true ? result.patch.wakeTimerWakeAt : '', '2026-08-15T00:10:00.000Z')
  })

  it('recomputes the waiting targets when switching to a target-based condition', () => {
    const result = rearmWakeTimerBatchForPatch({
      patch: { wakeTimerMode: 'left-tab' },
      card: { ...pendingOwner, wakeTimerMode: 'duration' as const },
      ...context,
    })

    assert.equal(result?.ok, true)
    assert.deepEqual(
      result?.ok === true ? result.patch.wakeTimerPendingTargetIds : [],
      ['left-running'],
    )
    assert.equal(result?.ok === true ? result.patch.wakeTimerWakeAt : 'x', undefined)
  })

  it('refuses a switch that would wait on a left tab that does not exist', () => {
    assert.deepEqual(
      rearmWakeTimerBatchForPatch({
        patch: { wakeTimerMode: 'left-tab' },
        card: pendingOwner,
        cards,
        paneTabIds: ['owner'],
        nowMs: context.nowMs,
      }),
      { ok: false, reason: 'left-target-unavailable' },
    )
  })

  it('leaves ordinary patches and cards without a pending batch untouched', () => {
    assert.equal(
      rearmWakeTimerBatchForPatch({ patch: { title: 'renamed' }, card: pendingOwner, ...context }),
      null,
    )
    assert.equal(
      rearmWakeTimerBatchForPatch({
        patch: { wakeTimerMode: 'duration' },
        card: { ...pendingOwner, wakeTimerQueuedSends: [] },
        ...context,
      }),
      null,
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

  it('previews the merged batch text so the pending card shows what will be sent', () => {
    assert.deepEqual(
      summarizeWakeTimerBatch([
        request('one', '  先检查构建\n  然后跑测试  '),
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
        count: 2,
        preview: '先检查构建 然后跑测试 再运行截图验证',
        attachmentCount: 1,
      },
    )
  })

  it('keeps the preview single-line and bounded for a very long queued prompt', () => {
    const summary = summarizeWakeTimerBatch([request('one', `${'长'.repeat(400)}\n收尾`)])

    assert.equal(summary.preview.length, 120)
    assert.equal(summary.preview.includes('\n'), false)
  })

  it('renders an image-only batch preview in both languages', () => {
    assert.equal(getLocaleText('zh-CN').wakeTimerQueuePreview('', 2), '图片消息，含 2 张图片')
    assert.equal(getLocaleText('zh-CN').wakeTimerQueuePreview('先检查构建', 0), '先检查构建')
    assert.equal(getLocaleText('en').wakeTimerQueuePreview('', 1), 'image message, 1 image')
    assert.equal(getLocaleText('en').wakeTimerQueuePreview('run the build', 2), 'run the build, 2 images')
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

describe('auto-activated per-card wake timer turns itself off', () => {
  it('keeps the batch-end patch only for the auto-activated switch', () => {
    assert.deepEqual(buildWakeTimerBatchEndPatch({ autoActivated: true }), {
      wakeTimerActive: false,
      wakeTimerAutoActivated: false,
    })
    assert.equal(buildWakeTimerBatchEndPatch({ autoActivated: false }), null)
  })

  it('stops swallowing ordinary sends once the auto-armed batch is released', () => {
    // 空闲卡右键发送 → 自动打开逐卡开关
    assert.equal(
      shouldArmWakeTimerForDeferSend({
        featureEnabled: true,
        mode: 'defer',
        origin: 'user',
        cardStatus: 'idle',
      }),
      true,
    )

    const armed: Partial<ChatCard> = { wakeTimerActive: true, wakeTimerAutoActivated: true }

    // 批次释放后开关必须归零，否则此后每一次普通回车都被静默塞进待唤醒批次
    const card: Partial<ChatCard> = {
      ...armed,
      ...buildWakeTimerBatchEndPatch({ autoActivated: armed.wakeTimerAutoActivated === true }),
    }

    const stillActive = card.wakeTimerActive === true
    assert.equal(stillActive, false)
    assert.equal(
      shouldQueueWakeTimerSend({
        featureEnabled: true,
        cardActive: stillActive,
        origin: 'user',
      }),
      false,
    )
  })

  it('leaves a user-opened per-card switch on after the batch is released', () => {
    const card: Partial<ChatCard> = { wakeTimerActive: true, wakeTimerAutoActivated: false }
    assert.equal(
      buildWakeTimerBatchEndPatch({ autoActivated: card.wakeTimerAutoActivated === true }),
      null,
    )
    assert.equal(
      shouldQueueWakeTimerSend({
        featureEnabled: true,
        cardActive: card.wakeTimerActive === true,
        origin: 'user',
      }),
      true,
    )
  })

  it('persists and normalizes the auto-activated marker', () => {
    assert.equal(createCard('Timer card').wakeTimerAutoActivated, false)

    const parsed = chatCardSchema.parse({
      ...createCard('存档卡'),
      wakeTimerActive: true,
      wakeTimerAutoActivated: true,
    })
    assert.equal(parsed.wakeTimerAutoActivated, true)

    // 旧存档没有这个字段：读成 undefined，按 `=== true` 判定即视为用户显式开启，
    // 批次结束后不会被自动关掉。
    const legacyCard: Record<string, unknown> = { ...createCard('旧卡'), wakeTimerActive: true }
    delete legacyCard.wakeTimerAutoActivated
    const legacy = chatCardSchema.parse(legacyCard)
    assert.equal(legacy.wakeTimerAutoActivated, undefined)
    assert.equal(
      buildWakeTimerBatchEndPatch({ autoActivated: legacy.wakeTimerAutoActivated === true }),
      null,
    )
  })
})

// 超管注册的「等这些会话跑完再叫醒我」批次。与用户自己挂的三种条件的根本差别：
// 等待名单是超管 MCP 命令点名的**显式集合**，不是从当前拓扑推出来的 —— 所以
// 任何按忙闲重算的路径都必须对它绕行，否则一次无关的 patch 就会把名单换成
// "此刻在跑的所有 agent"。
describe('supervisor wake timer batches (explicit targets)', () => {
  const cards = [
    { id: 'admin', status: 'idle' as const, isAgent: true },
    { id: 'fresh', status: 'idle' as const, isAgent: true },
    { id: 'busy', status: 'streaming' as const, isAgent: true },
    { id: 'board', status: 'idle' as const, isAgent: false },
  ]

  it('keeps every named target even when it has not started streaming yet', () => {
    // 刚被 create_session 建出来的卡还没进 streaming。按忙闲过滤会让等待名单当场
    // 为空 → 本轮一结束就自唤醒，这个工具就废了。
    assert.deepEqual(
      resolveSupervisorWakeTargets({
        ownerCardId: 'admin',
        requestedTargetIds: ['fresh', 'busy'],
        cards,
      }),
      { ok: true, targetIds: ['fresh', 'busy'] },
    )
  })

  it('waits for every other agent when the caller named no target', () => {
    assert.deepEqual(
      resolveSupervisorWakeTargets({
        ownerCardId: 'admin',
        requestedTargetIds: [],
        cards,
      }),
      // 工具卡（看板 / 统计 / 便签）和自己都不是会话。
      { ok: true, targetIds: ['fresh', 'busy'] },
    )
  })

  it('drops itself, tool cards and ids that no longer exist', () => {
    assert.deepEqual(
      resolveSupervisorWakeTargets({
        ownerCardId: 'admin',
        requestedTargetIds: ['admin', 'board', 'ghost', 'busy'],
        cards,
      }),
      { ok: true, targetIds: ['busy'] },
    )
  })

  it('drops a target that is already waiting on the owner instead of deadlocking', () => {
    // A 等 B、B 等 A 时两边都不再产生回合，也就都不会广播完成 —— 只有兜底超时能
    // 拆开。workspace-agents 靠"不把待唤醒算作忙"规避成环，left-tab 靠严格更小的
    // Tab 索引天然无环；显式名单是任意集合，两条护栏都没有，只能在这里查一层。
    assert.deepEqual(
      resolveSupervisorWakeTargets({
        ownerCardId: 'admin',
        requestedTargetIds: ['peer-admin', 'busy'],
        cards: [
          { id: 'admin', status: 'idle' as const, isAgent: true },
          {
            id: 'peer-admin',
            status: 'idle' as const,
            isAgent: true,
            hasPendingWakeBatch: true,
            pendingWakeTargetIds: ['admin'],
          },
          { id: 'busy', status: 'streaming' as const, isAgent: true },
        ],
      }),
      { ok: true, targetIds: ['busy'] },
    )
  })

  it('refuses to register a wait that has nothing left to wait for', () => {
    // 空等待名单 = 本轮一结束立刻自唤醒。宁可注册失败，也不要一个 0 秒的等待。
    assert.deepEqual(
      resolveSupervisorWakeTargets({
        ownerCardId: 'admin',
        requestedTargetIds: [],
        cards: [
          { id: 'admin', status: 'idle' as const, isAgent: true },
          { id: 'board', status: 'idle' as const, isAgent: false },
        ],
      }),
      { ok: false, reason: 'no-live-target' },
    )
  })

  it('never recomputes an explicit target list from the current topology', () => {
    // 症状预演：用户在超管卡上碰一下唤醒条件下拉或时长框，就会走 rearm。它按拓扑
    // 重算，会把点名的三张卡换成"此刻在跑的所有 agent"、并把兜底超时置空。
    assert.equal(
      rearmWakeTimerBatchForPatch({
        patch: { wakeTimerDurationMinutes: 15 },
        card: {
          id: 'admin',
          wakeTimerMode: 'workspace-agents',
          wakeTimerDurationMinutes: 60,
          wakeTimerQueuedSends: [request('q-1', '回来验收')],
          wakeTimerExplicitTargets: true,
        },
        cards,
        paneTabIds: [],
        nowMs: Date.parse('2026-08-17T00:00:00.000Z'),
      }),
      null,
    )
  })

  it('ignores unrelated busy peers that are not on the explicit list', () => {
    // workspace-agents 的实时判据是"这一列此刻没有任何 agent 在跑"。超管点名了三
    // 张卡，却被一个无关的长跑 tab 永久压住，就是把它点的名当没看见。
    assert.equal(
      isWakeTimerConditionReady({
        mode: 'workspace-agents',
        ownerStatus: 'idle',
        pendingTargetIds: [],
        activePeerIds: ['unrelated-long-runner'],
        explicitTargets: true,
        wakeAt: '2026-08-17T01:00:00.000Z',
        nowMs: Date.parse('2026-08-17T00:00:00.000Z'),
      }),
      true,
    )
    // 没有显式名单时行为一个字不变。
    assert.equal(
      isWakeTimerConditionReady({
        mode: 'workspace-agents',
        ownerStatus: 'idle',
        pendingTargetIds: [],
        activePeerIds: ['unrelated-long-runner'],
        wakeAt: undefined,
        nowMs: Date.parse('2026-08-17T00:00:00.000Z'),
      }),
      false,
    )
  })

  it('treats wakeAt as a hard upper bound for every mode, not just duration', () => {
    // 被打断 / 报错 / 从没开跑的目标永远不会广播完成（完成广播只挂在正常终态上），
    // 所以兜底超时是这类批次唯一的出口。
    const base = {
      mode: 'workspace-agents' as const,
      ownerStatus: 'idle' as const,
      pendingTargetIds: ['busy'],
      explicitTargets: true,
      wakeAt: '2026-08-17T01:00:00.000Z',
    }

    assert.equal(
      isWakeTimerConditionReady({ ...base, nowMs: Date.parse('2026-08-17T00:59:59.000Z') }),
      false,
    )
    assert.equal(
      isWakeTimerConditionReady({ ...base, nowMs: Date.parse('2026-08-17T01:00:00.000Z') }),
      true,
    )
  })

  it('still times out when the supervisor turn itself ended in error', () => {
    // 超管本轮在 provider 侧失败就停在 error，而 error 不调完成广播、也不进拓扑
    // 签名。owner 门控若一刀切要求 idle，这张卡连兜底超时都等不到。
    assert.equal(
      isWakeTimerConditionReady({
        mode: 'workspace-agents',
        ownerStatus: 'error',
        pendingTargetIds: [],
        explicitTargets: true,
        wakeAt: '2026-08-17T01:00:00.000Z',
        nowMs: Date.parse('2026-08-17T00:00:00.000Z'),
      }),
      true,
    )
    // 但正在输出时绝不发车：那会打断它自己这一轮。
    assert.equal(
      isWakeTimerConditionReady({
        mode: 'workspace-agents',
        ownerStatus: 'streaming',
        pendingTargetIds: [],
        explicitTargets: true,
        wakeAt: '2026-08-17T01:00:00.000Z',
        nowMs: Date.parse('2026-08-17T00:00:00.000Z'),
      }),
      false,
    )
    // 显式名单之外的 error 卡行为不变：仍然不放行（既有三种条件一个字没改）。
    assert.equal(
      isWakeTimerConditionReady({
        mode: 'duration',
        ownerStatus: 'error',
        pendingTargetIds: [],
        wakeAt: '2026-08-17T01:00:00.000Z',
        nowMs: Date.parse('2026-08-17T02:00:00.000Z'),
      }),
      false,
    )
  })
})
