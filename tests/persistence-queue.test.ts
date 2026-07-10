import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import {
  createQueuedStateSaveScheduler,
  createQueuedPersistenceStateSnapshot,
  defaultQueuedStateSaveDelayMs,
  getLiveChatContentChars,
  getQueuedStateSaveDelayMs,
  getPersistenceVersion,
  getStreamDeltaFlushIntervalMs,
  getStreamingCardCount,
  isBusyStreamingState,
  streamActivityFlushIntervalMs,
  streamDeltaFlushIntervalMs,
  shouldResetQueuedStateSaveTimer,
  shouldPersistActionImmediately,
  shouldUseQueuedPersistenceForAction,
  shouldSyncRuntimeSettings,
  shouldPauseQueuedStateSave,
  streamingQueuedStateSaveDelayMs,
} from '../src/hooks/persistence-queue.ts'

describe('persistence queue', () => {
  it('uses updatedAt as the lightweight persistence version when present', () => {
    const state = createDefaultState('')
    state.updatedAt = '2026-04-07T10:00:00.000Z'

    assert.equal(getPersistenceVersion(state), '2026-04-07T10:00:00.000Z')
  })

  it('keeps queued saves active while cards are streaming so completed messages survive a crash', () => {
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

    assert.equal(shouldPauseQueuedStateSave(state), false)
  })

  it('keeps queued saves enabled when no card is streaming', () => {
    const state = createDefaultState('')

    assert.equal(shouldPauseQueuedStateSave(state), false)
  })

  it('uses a longer non-resetting queued save window while streams are active', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    assert.equal(getQueuedStateSaveDelayMs(state), defaultQueuedStateSaveDelayMs)
    assert.equal(shouldResetQueuedStateSaveTimer(state), true)

    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      status: 'streaming',
    }

    assert.equal(getQueuedStateSaveDelayMs(state), streamingQueuedStateSaveDelayMs)
    assert.equal(shouldResetQueuedStateSaveTimer(state), false)
  })

  it('flushes streaming deltas fast enough to read as live typing while still batching per-token renders', () => {
    assert.equal(streamDeltaFlushIntervalMs, 80)
  })

  it('backs off renderer delta flushes as more sessions stream concurrently', () => {
    assert.equal(getStreamDeltaFlushIntervalMs(0), 80)
    assert.equal(getStreamDeltaFlushIntervalMs(1), 80)
    assert.equal(getStreamDeltaFlushIntervalMs(2), 120)
    assert.equal(getStreamDeltaFlushIntervalMs(3), 120)
    assert.equal(getStreamDeltaFlushIntervalMs(4), 180)
    assert.equal(getStreamDeltaFlushIntervalMs(7), 180)
  })

  it('flushes structured stream activities promptly without per-event renders', () => {
    assert.equal(streamActivityFlushIntervalMs, 250)
  })

  it('backs off queued saves further when several sessions stream at once', () => {
    const state = createDefaultState('')
    const firstColumn = state.columns[0]
    const activeCardId = firstColumn?.layout.type === 'pane'
      ? firstColumn.layout.activeTabId
      : ''

    if (!firstColumn || !activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    const secondCardId = 'second-streaming-card'
    firstColumn.cards[activeCardId] = {
      ...firstColumn.cards[activeCardId]!,
      status: 'streaming',
    }
    firstColumn.cards[secondCardId] = {
      ...firstColumn.cards[activeCardId]!,
      id: secondCardId,
      status: 'streaming',
    }

    assert.equal(getStreamingCardCount(state), 2)
    assert.equal(isBusyStreamingState(state), true)
    assert.ok(
      getQueuedStateSaveDelayMs(state) > streamingQueuedStateSaveDelayMs,
      'multi-session streaming should use a larger save window than a single active stream',
    )
    assert.equal(shouldResetQueuedStateSaveTimer(state), false)
  })

  it('backs off queued saves for one very large live streaming transcript', () => {
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
      messages: [
        {
          id: 'large-live-message',
          role: 'assistant',
          content: 'x'.repeat(800_000),
          createdAt: '2026-05-03T11:00:00.000Z',
        },
      ],
    }

    assert.ok(getLiveChatContentChars(state) >= 800_000)
    assert.equal(isBusyStreamingState(state), true)
    assert.ok(getQueuedStateSaveDelayMs(state) > streamingQueuedStateSaveDelayMs)
  })

  it('backs off queued saves after restoring a large archived transcript', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      status: 'idle',
      messages: Array.from({ length: 900 }, (_, index) => ({
        id: `restored-large-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(1_000),
        createdAt: '2026-05-03T11:00:00.000Z',
      })),
    }

    assert.ok(getQueuedStateSaveDelayMs(state) > defaultQueuedStateSaveDelayMs)
    assert.equal(shouldResetQueuedStateSaveTimer(state), false)
  })

  it('keeps the high-pressure save window after a large transcript leaves streaming', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      status: 'idle',
      streamId: undefined,
      messages: [
        {
          id: 'large-idle-message',
          role: 'assistant',
          content: 'x'.repeat(800_000),
          createdAt: '2026-05-03T11:00:00.000Z',
        },
      ],
    }

    assert.equal(isBusyStreamingState(state), true)
    assert.equal(shouldResetQueuedStateSaveTimer(state), false)
    assert.ok(getQueuedStateSaveDelayMs(state) > streamingQueuedStateSaveDelayMs)
  })

  it('creates a compact queued persistence snapshot before crossing the Electron IPC bridge', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    const hugeOutput = 'A'.repeat(40_000)
    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      messages: [
        {
          id: 'huge-command',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-03T11:00:00.000Z',
          meta: {
            kind: 'command',
            structuredData: JSON.stringify({
              kind: 'command',
              command: 'pnpm test',
              output: hugeOutput,
            }),
          },
        },
      ],
    }

    const snapshot = createQueuedPersistenceStateSnapshot(state)
    const originalStructuredData = state.columns[0]!.cards[activeCardId]!.messages[0]!.meta?.structuredData ?? ''
    const snapshotStructuredData = snapshot.columns[0]!.cards[activeCardId]!.messages[0]!.meta?.structuredData ?? ''

    assert.equal(originalStructuredData.includes(hugeOutput), true)
    assert.ok(snapshotStructuredData.length < originalStructuredData.length)
    assert.match(snapshotStructuredData, /Output truncated in queued state save/)
  })

  // 真实事故回归：edits 载荷没有顶层 output/content 字符串，旧逻辑对原始 JSON
  // 整串头尾截断，产出非法 JSON —— 重启后改动卡解析失败、渲染降级。
  it('keeps oversized edits structuredData valid JSON in queued snapshots', () => {
    const state = createDefaultState('')
    const activeCardId = state.columns[0]?.layout.type === 'pane'
      ? state.columns[0].layout.activeTabId
      : ''

    if (!activeCardId) {
      throw new Error('Expected default state to include an active card.')
    }

    const hugePatch = `@@ -1,2 +1,2 @@\n-${'a'.repeat(9_000)}\n+${'b'.repeat(9_000)}\n`
    state.columns[0]!.cards[activeCardId] = {
      ...state.columns[0]!.cards[activeCardId]!,
      messages: [
        {
          id: 'huge-edits',
          role: 'assistant',
          content: '',
          createdAt: '2026-05-03T11:00:00.000Z',
          meta: {
            kind: 'edits',
            structuredData: JSON.stringify({
              itemId: 'toolu_x',
              kind: 'edits',
              status: 'completed',
              files: [
                { path: 'src/renderer/app.js', kind: 'modified', addedLines: 1, removedLines: 1, patch: hugePatch },
                { path: 'src/other.ts', kind: 'modified', addedLines: 1, removedLines: 1, patch: hugePatch },
              ],
            }),
          },
        },
      ],
    }

    const snapshot = createQueuedPersistenceStateSnapshot(state)
    const snapshotStructuredData = snapshot.columns[0]!.cards[activeCardId]!.messages[0]!.meta?.structuredData ?? ''
    const original = state.columns[0]!.cards[activeCardId]!.messages[0]!.meta?.structuredData ?? ''

    assert.ok(snapshotStructuredData.length < original.length, 'oversized edits payload should shrink')

    const parsed = JSON.parse(snapshotStructuredData) as {
      kind?: string
      files?: Array<{ path?: string; patch?: string }>
    }
    assert.equal(parsed.kind, 'edits')
    assert.equal(parsed.files?.length, 2)
    assert.equal(parsed.files?.[0]?.path, 'src/renderer/app.js')
    assert.match(parsed.files?.[0]?.patch ?? '', /truncated in queued state save/)
  })

  it('keeps model picks on the queued path even when another card is still streaming', () => {
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

    assert.equal(shouldPersistActionImmediately('selectCardModel', state), false)
    assert.equal(shouldPersistActionImmediately('updateRequestModels', state), false)
  })

  it('keeps model picks on the queued path when no stream is active', () => {
    const state = createDefaultState('')

    assert.equal(shouldPersistActionImmediately('selectCardModel', state), false)
  })

  it('routes high-churn chat mutations through queued persistence', () => {
    assert.equal(shouldUseQueuedPersistenceForAction('appendAssistantDelta'), true)
    assert.equal(shouldUseQueuedPersistenceForAction('appendMessages'), true)
    assert.equal(shouldUseQueuedPersistenceForAction('upsertMessages'), true)
    assert.equal(shouldUseQueuedPersistenceForAction('updateCard'), true)
    assert.equal(shouldUseQueuedPersistenceForAction('importExternalSession'), true)
    assert.equal(shouldUseQueuedPersistenceForAction('removeSessionHistory'), true)
    assert.equal(shouldUseQueuedPersistenceForAction('resetCardConversation'), false)
    assert.equal(shouldUseQueuedPersistenceForAction('replace'), false)
  })

  it('flags runtime-routing changes for immediate backend sync', () => {
    const state = createDefaultState('')

    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { cliRoutingEnabled: false } }), true)
    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { resilientProxyEnabled: false } }), true)
    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { resilientProxyStallTimeoutSec: 120 } }), true)
    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { resilientProxyFirstByteTimeoutSec: 180 } }), true)
    assert.equal(shouldSyncRuntimeSettings({ type: 'updateSettings', patch: { resilientProxyMaxRetries: -1 } }), true)
    assert.equal(
      shouldSyncRuntimeSettings({
        type: 'updateRequestModels',
        patch: { claude: 'claude-opus-4-8' },
      }),
      true,
    )
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

  it('keeps one in-flight streaming save timer while replacing the pending state', () => {
    const queuedTitles: string[] = []
    const pendingTimers = new Map<unknown, () => void>()
    const scheduledDelays: number[] = []
    let nextTimerId = 1

    const scheduler = createQueuedStateSaveScheduler({
      delayMs: 200,
      queueStateSave: (state) => {
        queuedTitles.push(state.columns[0]?.title ?? '')
      },
      setTimeoutFn: (callback, delayMs) => {
        const id = nextTimerId++
        pendingTimers.set(id, callback)
        scheduledDelays.push(delayMs)
        return id
      },
      clearTimeoutFn: (id) => {
        pendingTimers.delete(id)
      },
    })

    const first = createDefaultState('')
    first.updatedAt = '2026-04-07T10:00:00.000Z'
    first.columns[0]!.title = 'First streaming save'

    const second = createDefaultState('')
    second.updatedAt = '2026-04-07T10:00:01.000Z'
    second.columns[0]!.title = 'Latest streaming save'

    scheduler.schedule(first, {
      delayMs: streamingQueuedStateSaveDelayMs,
      resetTimer: false,
    })
    scheduler.schedule(second, {
      delayMs: streamingQueuedStateSaveDelayMs,
      resetTimer: false,
    })

    assert.equal(pendingTimers.size, 1, 'expected only the original streaming timer to remain')
    assert.deepEqual(scheduledDelays, [streamingQueuedStateSaveDelayMs])

    pendingTimers.values().next().value?.()

    assert.deepEqual(queuedTitles, ['Latest streaming save'])
  })
})
