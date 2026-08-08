import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  createCard,
  createDefaultSettings,
  createDefaultState,
  getFirstPane,
  normalizeAppSettings,
} from '../shared/default-state.ts'
import { appSettingsSchema, type ChatCard } from '../shared/schema.ts'
import { WEATHER_TOOL_MODEL } from '../shared/models.ts'
import {
  getEarliestRepeatLoopPrompt,
  resolveRepeatLoopCompletion,
} from '../src/components/repeat-loop.ts'
import { ideReducer, type IdeAction } from '../src/state.ts'

const timestamp = '2026-08-06T00:00:00.000Z'

describe('agent repeat loop state', () => {
  let tmpDir = ''

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `chill-vibe-repeat-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('defaults the global and per-card repeat switches off while preserving explicit settings', () => {
    assert.equal((appSettingsSchema.parse({}) as { repeatLoopEnabled?: boolean }).repeatLoopEnabled, false)
    assert.equal((createDefaultSettings() as { repeatLoopEnabled?: boolean }).repeatLoopEnabled, false)
    assert.equal(
      (normalizeAppSettings({ repeatLoopEnabled: true } as never) as { repeatLoopEnabled?: boolean })
        .repeatLoopEnabled,
      true,
    )
    assert.equal((createCard() as ChatCard & { repeatLoopActive?: boolean }).repeatLoopActive, false)
  })

  it('round-trips repeat switches through persisted state normalization', async () => {
    const { loadState, saveState } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/repeat-loop')
    const column = state.columns[0]!
    const pane = getFirstPane(column.layout)
    const card = column.cards[pane.activeTabId]!

    Object.assign(state.settings, { repeatLoopEnabled: true })
    Object.assign(card, { repeatLoopActive: true })

    await saveState(state)
    const restored = await loadState()
    const restoredColumn = restored.columns[0]!
    const restoredCard = restoredColumn.cards[getFirstPane(restoredColumn.layout).activeTabId]!

    assert.equal((restored.settings as { repeatLoopEnabled?: boolean }).repeatLoopEnabled, true)
    assert.equal((restoredCard as ChatCard & { repeatLoopActive?: boolean }).repeatLoopActive, true)
  })

  it('spawns a fresh background tab without interrupting the tab where the user is typing', () => {
    const state = createDefaultState('D:/repeat-loop')
    const column = state.columns[0]!
    const pane = getFirstPane(column.layout)
    const sourceCard = column.cards[pane.activeTabId]!
    Object.assign(sourceCard, {
      repeatLoopActive: true,
      repeatLoopRemaining: 2,
      sessionId: 'source-session',
      sessionModel: sourceCard.model,
      thinkingEnabled: false,
      planMode: true,
      messages: [
        { id: 'user-1', role: 'user', content: 'repeat this task', createdAt: timestamp },
        { id: 'assistant-1', role: 'assistant', content: 'done', createdAt: timestamp },
      ],
    })

    const spawnAction = {
      type: 'spawnRepeatLoopTab',
      columnId: column.id,
      sourceCardId: sourceCard.id,
      cardId: 'repeat-card-2',
    } as IdeAction
    const next = ideReducer(state, spawnAction)

    const nextColumn = next.columns.find((entry) => entry.id === column.id)!
    const nextPane = getFirstPane(nextColumn.layout)
    const repeatedCard = nextColumn.cards['repeat-card-2'] as
      | (ChatCard & { repeatLoopActive?: boolean })
      | undefined

    assert.ok(repeatedCard)
    assert.deepEqual(nextPane.tabs, [...pane.tabs, 'repeat-card-2'])
    assert.equal(nextPane.activeTabId, pane.activeTabId)
    assert.equal(repeatedCard.provider, sourceCard.provider)
    assert.equal(repeatedCard.model, sourceCard.model)
    assert.equal(repeatedCard.reasoningEffort, sourceCard.reasoningEffort)
    assert.equal(repeatedCard.thinkingEnabled, false)
    assert.equal(repeatedCard.planMode, true)
    assert.equal(repeatedCard.repeatLoopActive, true)
    assert.equal(repeatedCard.repeatLoopRemaining, 1)
    assert.equal(repeatedCard.sessionId, undefined)
    assert.equal(repeatedCard.streamId, undefined)
    assert.deepEqual(repeatedCard.messages, [])
    assert.deepEqual(repeatedCard.queuedSends, [])
    assert.deepEqual(repeatedCard.wakeTimerQueuedSends, [])
    assert.equal(ideReducer(next, spawnAction), next)
  })

  it('reuses the earliest non-empty user-authored text exactly', () => {
    const messages: ChatCard['messages'] = [
      { id: 'system-1', role: 'system', content: 'internal', createdAt: timestamp },
      { id: 'user-empty', role: 'user', content: '   ', createdAt: timestamp },
      { id: 'assistant-1', role: 'assistant', content: 'ready', createdAt: timestamp },
      { id: 'user-first', role: 'user', content: '  first prompt\nwith details  ', createdAt: timestamp },
      { id: 'user-second', role: 'user', content: 'second prompt', createdAt: timestamp },
    ]

    assert.equal(getEarliestRepeatLoopPrompt(messages), '  first prompt\nwith details  ')
  })

  it('only schedules a clean terminal repeat after other queued continuations are exhausted', () => {
    const card = createCard('Repeat source')
    card.repeatLoopActive = true
    card.messages = [
      { id: 'user-1', role: 'user', content: 'repeat this task', createdAt: timestamp },
    ]

    assert.deepEqual(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'terminal', card }),
      { prompt: 'repeat this task' },
    )
    card.repeatLoopRemaining = 2
    assert.deepEqual(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'terminal', card }),
      { prompt: 'repeat this task', remainingRepeats: 2 },
    )
    card.repeatLoopRemaining = 0
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'terminal', card }),
      null,
    )
    card.repeatLoopRemaining = undefined
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: false, completionKind: 'terminal', card }),
      null,
    )
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'background-pending', card }),
      null,
    )
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'stopped', card }),
      null,
    )

    card.queuedSends = [{ id: 'queued-1', prompt: 'follow-up first', attachments: [] }]
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'terminal', card }),
      null,
    )

    card.queuedSends = []
    card.wakeTimerQueuedSends = [{ id: 'wake-1', prompt: 'wake later', attachments: [] }]
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'terminal', card }),
      null,
    )

    card.wakeTimerQueuedSends = []
    card.model = WEATHER_TOOL_MODEL
    assert.equal(
      resolveRepeatLoopCompletion({ featureEnabled: true, completionKind: 'terminal', card }),
      null,
    )
  })
})
