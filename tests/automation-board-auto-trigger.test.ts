import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultAutomationBoardAutoTrigger } from '../shared/schema.ts'
import type { AutomationBoard, AutomationBoardAutoTrigger } from '../shared/schema.ts'
import {
  resolveAutomationBoardAutoTriggerDecision,
  type AutomationBoardCardActivity,
} from '../src/components/automation-board-auto-trigger.ts'

const board = (
  items: Array<{ cardId: string; lane: 'standby' | 'running' | 'done' }>,
  supervisorCardId = 'sup-1',
): AutomationBoard => ({
  items: items.map((item) => ({ ...item, requirement: `req ${item.cardId}` })),
  supervisorCardId,
  supervisorExpanded: false,
})

const activity = (
  entries: Record<string, Partial<AutomationBoardCardActivity>>,
): Record<string, AutomationBoardCardActivity> =>
  Object.fromEntries(
    Object.entries(entries).map(([cardId, value]) => [
      cardId,
      { status: value.status ?? 'idle', backgroundWorkPending: value.backgroundWorkPending ?? false },
    ]),
  )

const config = (overrides: Partial<AutomationBoardAutoTrigger> = {}): AutomationBoardAutoTrigger => ({
  ...createDefaultAutomationBoardAutoTrigger(),
  enabled: true,
  ...overrides,
})

const nowMs = Date.parse('2026-08-11T12:00:00.000Z')

const decide = (overrides: Parameters<typeof resolveAutomationBoardAutoTriggerDecision>[0]) =>
  resolveAutomationBoardAutoTriggerDecision(overrides)

describe('automation board auto trigger', () => {
  it('fires when the only running item settles', () => {
    assert.deepEqual(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'sup-1': {} }),
        lastFiredAtMs: null,
        nowMs,
      }),
      { fire: true, reason: 'ready' },
    )
  })

  it('does not fire when the feature is off', () => {
    assert.deepEqual(
      decide({
        config: config({ enabled: false }),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: null,
        nowMs,
      }),
      { fire: false, reason: 'disabled' },
    )
  })

  // 防递归的第一道：监工自己不在 items 里，所以它结束永远不算"最后一个需求结束"。
  it('does not fire when the supervisor itself settles', () => {
    assert.deepEqual(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'done' }]),
        settledCardId: 'sup-1',
        cardActivity: activity({ 'item-a': {}, 'sup-1': {} }),
        lastFiredAtMs: null,
        nowMs,
      }),
      { fire: false, reason: 'not-board-item' },
    )
  })

  it('does not fire for a card that is not a running-lane item', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([
          { cardId: 'item-a', lane: 'standby' },
          { cardId: 'item-b', lane: 'running' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'item-b': {} }),
        lastFiredAtMs: null,
        nowMs,
      }).reason,
      'not-board-item',
    )
  })

  it('does not fire for an unrelated chat card', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'unrelated',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: null,
        nowMs,
      }).reason,
      'not-board-item',
    )
  })

  it('waits while another running item is still streaming', () => {
    assert.deepEqual(
      decide({
        config: config(),
        board: board([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'item-b', lane: 'running' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'item-b': { status: 'streaming' } }),
        lastFiredAtMs: null,
        nowMs,
      }),
      { fire: false, reason: 'still-running' },
    )
  })

  // "agent 正在等子任务" —— 原生后台等待也算还在干活，否则监工会太早介入。
  it('waits while another running item awaits native background work', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'item-b', lane: 'running' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'item-b': { backgroundWorkPending: true } }),
        lastFiredAtMs: null,
        nowMs,
      }).reason,
      'still-running',
    )
  })

  it('ignores a still-streaming card that sits outside the running lane', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'item-b', lane: 'standby' },
        ]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'item-b': { status: 'streaming' } }),
        lastFiredAtMs: null,
        nowMs,
      }).fire,
      true,
    )
  })

  it('ignores the settling card even if its status has not flipped yet', () => {
    // 稳定窗口结束时状态可能还没落到 idle；触发判定不能因为它自己在名单里就永不放行。
    assert.equal(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': { status: 'streaming' } }),
        lastFiredAtMs: null,
        nowMs,
      }).fire,
      true,
    )
  })

  // 防递归的第二道：监工在跑就绝不再触发一轮。
  it('does not fire while the supervisor is busy', () => {
    assert.deepEqual(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'sup-1': { status: 'streaming' } }),
        lastFiredAtMs: null,
        nowMs,
      }),
      { fire: false, reason: 'supervisor-busy' },
    )
  })

  it('does not fire while the supervisor awaits background work', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {}, 'sup-1': { backgroundWorkPending: true } }),
        lastFiredAtMs: null,
        nowMs,
      }).reason,
      'supervisor-busy',
    )
  })

  it('throttles a second fire inside the minimum interval', () => {
    assert.deepEqual(
      decide({
        config: config({ minIntervalMinutes: 5 }),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: nowMs - 60_000,
        nowMs,
      }),
      { fire: false, reason: 'throttled' },
    )
  })

  it('fires again once the minimum interval has elapsed', () => {
    assert.equal(
      decide({
        config: config({ minIntervalMinutes: 5 }),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: nowMs - 6 * 60_000,
        nowMs,
      }).fire,
      true,
    )
  })

  it('never throttles when the interval is zero', () => {
    assert.equal(
      decide({
        config: config({ minIntervalMinutes: 0 }),
        board: board([{ cardId: 'item-a', lane: 'running' }]),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: nowMs,
        nowMs,
      }).fire,
      true,
    )
  })

  it('does not fire when the board has no items at all', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([]),
        settledCardId: 'item-a',
        cardActivity: activity({}),
        lastFiredAtMs: null,
        nowMs,
      }).reason,
      'not-board-item',
    )
  })

  it('does not fire without a board', () => {
    assert.deepEqual(
      decide({
        config: config(),
        board: undefined,
        settledCardId: 'item-a',
        cardActivity: activity({}),
        lastFiredAtMs: null,
        nowMs,
      }),
      { fire: false, reason: 'disabled' },
    )
  })

  it('fires with no supervisor yet — the caller creates it', () => {
    assert.equal(
      decide({
        config: config(),
        board: board([{ cardId: 'item-a', lane: 'running' }], ''),
        settledCardId: 'item-a',
        cardActivity: activity({ 'item-a': {} }),
        lastFiredAtMs: null,
        nowMs,
      }).fire,
      true,
    )
  })
})
