import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAutomationBoardCard, createCard } from '../shared/default-state.ts'
import type { AutomationBoardLane, ChatCard } from '../shared/schema.ts'
import {
  automationBoardItemMessageWindow,
  getAutomationBoardLaneCardIds,
  hasAutomationBoardHistory,
  resolveAutomationBoardTransition,
  resolveWakeTimerNeighbourIds,
  type AutomationBoardLocation,
} from '../src/components/automation-board-transitions.ts'
import { runAutomationBoardStandbyBatch } from '../src/components/automation-board-host.ts'

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

describe('automation board standby batch', () => {
  it('runs every captured standby item once and preserves lane order', () => {
    const moved: string[] = []
    const captured = ['item-a', 'item-b', 'item-c']

    runAutomationBoardStandbyBatch(captured, (cardId) => moved.push(cardId))

    assert.deepEqual(moved, captured)
  })
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
      { cardId: 'a', lane: 'running' as const, requirement: 'A', templateId: '' },
      { cardId: 'b', lane: 'standby' as const, requirement: 'B', templateId: '' },
      { cardId: 'c', lane: 'running' as const, requirement: 'C', templateId: '' },
      { cardId: 'd', lane: 'done' as const, requirement: 'D', templateId: '' },
    ],
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

describe('resolveWakeTimerNeighbourIds', () => {
  // 必须是真正的看板卡：`resolveWakeTimerNeighbourIds` 只认 model 对得上的 blob。
  const board = (items: Array<{ cardId: string; lane: AutomationBoardLane }>): ChatCard => ({
    ...createAutomationBoardCard('Board'),
    id: 'board-1',
    automationBoard: {
      items: items.map((item) => ({ ...item, requirement: '', templateId: '' })),
    },
  })

  const cards = (): Record<string, ChatCard> => ({
    'board-1': board([
      { cardId: 'item-a', lane: 'running' },
      { cardId: 'item-b', lane: 'standby' },
      { cardId: 'item-c', lane: 'running' },
    ]),
  })

  it('uses the pane tab order for an ordinary tab', () => {
    assert.deepEqual(
      resolveWakeTimerNeighbourIds({
        cardId: 'chat-1',
        paneTabIds: ['chat-0', 'chat-1', 'chat-2'],
        cards: cards(),
      }),
      ['chat-0', 'chat-1', 'chat-2'],
    )
  })

  // "左侧 tab" 在看板语境下就是"上方需求"：同泳道内它上面那一项。
  it('uses the lane order for a board item', () => {
    assert.deepEqual(
      resolveWakeTimerNeighbourIds({ cardId: 'item-c', paneTabIds: ['board-1'], cards: cards() }),
      ['item-a', 'item-c'],
    )
  })

  it('does not leak items from another lane into the sequence', () => {
    assert.deepEqual(
      resolveWakeTimerNeighbourIds({ cardId: 'item-b', paneTabIds: undefined, cards: cards() }),
      ['item-b'],
    )
  })

  // 切走模型的旧卡还留着 blob（刻意保留以便切回），但它不该再决定唤醒目标。
  it('ignores a stale blob on a card that is no longer a board', () => {
    const stale: ChatCard = {
      ...createCard('Was a board'),
      id: 'board-1',
      automationBoard: {
        items: [
          { cardId: 'item-a', lane: 'running', requirement: '', templateId: '' },
          { cardId: 'item-c', lane: 'running', requirement: '', templateId: '' },
        ],
      },
    }

    assert.deepEqual(
      resolveWakeTimerNeighbourIds({ cardId: 'item-c', paneTabIds: undefined, cards: { 'board-1': stale } }),
      [],
    )
  })

  it('returns an empty sequence for a card that is neither a tab nor an item', () => {
    assert.deepEqual(
      resolveWakeTimerNeighbourIds({ cardId: 'sup-1', paneTabIds: ['board-1'], cards: cards() }),
      [],
    )
  })

  it('prefers the pane order when a card somehow appears in both', () => {
    assert.deepEqual(
      resolveWakeTimerNeighbourIds({
        cardId: 'item-a',
        paneTabIds: ['board-1', 'item-a'],
        cards: cards(),
      }),
      ['board-1', 'item-a'],
    )
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
