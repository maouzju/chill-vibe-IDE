import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { ChatCard } from '../shared/schema.ts'
import {
  collectAutomationBoardRunningCardIds,
  resolveNextAutomationBoardRunningCardId,
} from '../src/components/automation-board-view.ts'
import type { AutomationBoardItemView } from '../src/components/automation-board-view.ts'

const itemView = (id: string, overrides: Partial<ChatCard> = {}): AutomationBoardItemView => ({
  item: { cardId: id, lane: 'running', requirement: `需求 ${id}`, templateId: '' },
  card: { ...createCard(`Item ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL), id, ...overrides },
  laneIndex: 0,
  aboveCardId: undefined,
  aboveTitle: undefined,
})

describe('collectAutomationBoardRunningCardIds', () => {
  it('counts only the items whose card is actually streaming', () => {
    const running = collectAutomationBoardRunningCardIds([
      itemView('a', { status: 'streaming', streamId: 's1' }),
      itemView('b'),
      itemView('c', { status: 'error' }),
      itemView('d', { backgroundWorkPending: true }),
      itemView('e', { status: 'streaming', streamId: 's2' }),
    ])

    assert.deepEqual(running, ['a', 'e'])
  })

  it('keeps lane order so the locator walks top to bottom', () => {
    const running = collectAutomationBoardRunningCardIds([
      itemView('z', { status: 'streaming', streamId: 's1' }),
      itemView('y', { status: 'streaming', streamId: 's2' }),
    ])

    assert.deepEqual(running, ['z', 'y'])
  })

  it('returns an empty list when nothing runs', () => {
    assert.deepEqual(collectAutomationBoardRunningCardIds([itemView('a'), itemView('b')]), [])
  })
})

describe('resolveNextAutomationBoardRunningCardId', () => {
  it('starts at the first running item', () => {
    assert.equal(resolveNextAutomationBoardRunningCardId(['a', 'b', 'c'], null), 'a')
  })

  it('advances one item per click', () => {
    assert.equal(resolveNextAutomationBoardRunningCardId(['a', 'b', 'c'], 'a'), 'b')
    assert.equal(resolveNextAutomationBoardRunningCardId(['a', 'b', 'c'], 'b'), 'c')
  })

  it('wraps around at the end so the cycle never dead-ends', () => {
    assert.equal(resolveNextAutomationBoardRunningCardId(['a', 'b', 'c'], 'c'), 'a')
  })

  // 定位游标记的是上一次跳到的卡片，而那张卡可能在两次点击之间跑完了。
  // 这时从头开始，而不是把游标当成"没有下一个"。
  it('restarts when the remembered item finished between clicks', () => {
    assert.equal(resolveNextAutomationBoardRunningCardId(['b', 'c'], 'a'), 'b')
  })

  it('returns null when nothing is running', () => {
    assert.equal(resolveNextAutomationBoardRunningCardId([], 'a'), null)
    assert.equal(resolveNextAutomationBoardRunningCardId([], null), null)
  })
})
