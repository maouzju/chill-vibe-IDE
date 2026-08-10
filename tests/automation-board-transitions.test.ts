import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCard } from '../shared/default-state.ts'
import type { AutomationBoardLane, ChatCard } from '../shared/schema.ts'
import {
  automationBoardItemMessageWindow,
  getAutomationBoardLaneCardIds,
  hasAutomationBoardHistory,
  resolveAutomationBoardTransition,
  type AutomationBoardLocation,
} from '../src/components/automation-board-transitions.ts'

const lane = (value: AutomationBoardLane): AutomationBoardLocation => ({ kind: 'lane', lane: value })
const tab: AutomationBoardLocation = { kind: 'tab' }

const decide = (
  from: AutomationBoardLocation,
  to: AutomationBoardLocation,
  overrides: { isStreaming?: boolean; hasHistory?: boolean } = {},
) =>
  resolveAutomationBoardTransition({
    from,
    to,
    isStreaming: overrides.isStreaming ?? false,
    hasHistory: overrides.hasHistory ?? false,
  })

describe('automation board transitions — popping out to a tab', () => {
  // 这是"无缝"的定义：把需求拖成独立 tab 只是换个展现容器，
  // 卡片对象、会话、正在飞的流一个字节都不能动。
  it('never interrupts, sends, or clears the queue, whatever the source lane', () => {
    for (const source of [lane('standby'), lane('running'), lane('done')]) {
      for (const isStreaming of [false, true]) {
        for (const hasHistory of [false, true]) {
          const effects = decide(source, tab, { isStreaming, hasHistory })

          assert.deepEqual(
            effects,
            { interrupt: false, queue: 'keep', send: 'none', stamp: 'none' },
            `popping out from ${JSON.stringify(source)} (streaming=${isStreaming}, history=${hasHistory}) must be side-effect free`,
          )
        }
      }
    }
  })
})

describe('automation board transitions — entering the running lane', () => {
  it('sends the original requirement for a card that never ran', () => {
    assert.deepEqual(decide(lane('standby'), lane('running')), {
      interrupt: false,
      queue: 'keep',
      send: 'requirement',
      stamp: 'started',
    })
  })

  it('sends an empty continuation for a card that already has history', () => {
    assert.deepEqual(decide(lane('standby'), lane('running'), { hasHistory: true }), {
      interrupt: false,
      queue: 'keep',
      send: 'continue',
      stamp: 'started',
    })
  })

  // 幂等：正在跑的卡拖进执行中只是换位置，绝不能再发一遍需求。
  it('does not re-send for a card that is already streaming', () => {
    assert.deepEqual(decide(tab, lane('running'), { isStreaming: true, hasHistory: true }), {
      interrupt: false,
      queue: 'keep',
      send: 'none',
      stamp: 'started',
    })
  })

  it('sends the requirement when a fresh tab is dropped into running', () => {
    assert.equal(decide(tab, lane('running')).send, 'requirement')
  })
})

describe('automation board transitions — standby and done interrupt', () => {
  it('interrupts a streaming card entering standby but keeps the queue', () => {
    assert.deepEqual(decide(lane('running'), lane('standby'), { isStreaming: true, hasHistory: true }), {
      interrupt: true,
      queue: 'keep',
      send: 'none',
      stamp: 'none',
    })
  })

  it('does not interrupt an idle card entering standby', () => {
    assert.equal(decide(lane('running'), lane('standby')).interrupt, false)
  })

  it('interrupts and stamps completion when entering done', () => {
    assert.deepEqual(decide(lane('running'), lane('done'), { isStreaming: true }), {
      interrupt: true,
      queue: 'keep',
      send: 'none',
      stamp: 'completed',
    })
  })

  it('interrupts a streaming tab dropped straight into done', () => {
    assert.equal(decide(tab, lane('done'), { isStreaming: true }).interrupt, true)
  })
})

describe('automation board transitions — same-lane reorder', () => {
  it('is inert for every lane', () => {
    for (const value of ['standby', 'running', 'done'] as const) {
      assert.deepEqual(
        decide(lane(value), lane(value), { isStreaming: true, hasHistory: true }),
        { interrupt: false, queue: 'keep', send: 'none', stamp: 'none' },
        `reordering inside ${value} must not touch the run`,
      )
    }
  })
})

describe('automation board transitions — tab to tab', () => {
  it('is inert', () => {
    assert.deepEqual(decide(tab, tab, { isStreaming: true }), {
      interrupt: false,
      queue: 'keep',
      send: 'none',
      stamp: 'none',
    })
  })
})

describe('hasAutomationBoardHistory', () => {
  const withMessages = (roles: Array<ChatCard['messages'][number]['role']>): ChatCard => ({
    ...createCard('history probe'),
    messages: roles.map((role, index) => ({
      id: `m${index}`,
      role,
      content: 'text',
      createdAt: '2026-08-11T00:00:00.000Z',
    })),
  })

  it('is false for a brand-new card', () => {
    assert.equal(hasAutomationBoardHistory(createCard('fresh')), false)
  })

  it('is false when undefined', () => {
    assert.equal(hasAutomationBoardHistory(undefined), false)
  })

  it('is true once a user or assistant message exists', () => {
    assert.equal(hasAutomationBoardHistory(withMessages(['user'])), true)
    assert.equal(hasAutomationBoardHistory(withMessages(['user', 'assistant'])), true)
  })

  // 只有 system 消息（例如启动期的提示气泡）不算"跑过"，
  // 否则空续传会被发给一个从没收到需求的会话。
  it('is false when only system messages exist', () => {
    assert.equal(hasAutomationBoardHistory(withMessages(['system', 'system'])), false)
  })

  it('is true when a resumable native session exists even with no messages', () => {
    assert.equal(
      hasAutomationBoardHistory({ ...createCard('resumable'), sessionId: 'abc-123' }),
      true,
    )
  })
})

describe('getAutomationBoardLaneCardIds', () => {
  const board = {
    items: [
      { cardId: 'a', lane: 'running' as const, requirement: 'A' },
      { cardId: 'b', lane: 'standby' as const, requirement: 'B' },
      { cardId: 'c', lane: 'running' as const, requirement: 'C' },
      { cardId: 'd', lane: 'done' as const, requirement: 'D' },
    ],
    supervisorCardId: '',
    supervisorExpanded: false,
  }

  // 这个有序列表直接喂给 armWakeTimerBatch 的 paneTabIds 参数：
  // "上方需求"就是数组里的前一项，唤醒判定函数因此一个字符都不用改。
  it('preserves board order within a lane', () => {
    assert.deepEqual(getAutomationBoardLaneCardIds(board, 'running'), ['a', 'c'])
    assert.deepEqual(getAutomationBoardLaneCardIds(board, 'standby'), ['b'])
    assert.deepEqual(getAutomationBoardLaneCardIds(board, 'done'), ['d'])
  })

  it('returns an empty list for a missing board', () => {
    assert.deepEqual(getAutomationBoardLaneCardIds(undefined, 'running'), [])
  })
})

describe('automationBoardItemMessageWindow', () => {
  const entries = Array.from({ length: 20 }, (_, index) => index)

  it('keeps only the newest entries and reports how many were hidden', () => {
    const result = automationBoardItemMessageWindow(entries, 6)

    assert.deepEqual(result.visible, [14, 15, 16, 17, 18, 19])
    assert.equal(result.hiddenCount, 14)
  })

  it('hides nothing when the list already fits', () => {
    const result = automationBoardItemMessageWindow([1, 2], 6)

    assert.deepEqual(result.visible, [1, 2])
    assert.equal(result.hiddenCount, 0)
  })

  it('never returns a negative hidden count', () => {
    assert.equal(automationBoardItemMessageWindow([], 6).hiddenCount, 0)
  })
})
