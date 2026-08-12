import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { createAutomationBoardCard, createCard } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { ChatCard } from '../shared/schema.ts'
import { resolveTabAbsorbTarget } from '../src/components/pane-tab-board-absorb.ts'

const paneViewSourcePath = path.join(process.cwd(), 'src', 'components', 'PaneView.tsx')

const boardCard = (id: string): ChatCard => ({
  ...createAutomationBoardCard('Board'),
  id,
  automationBoard: { items: [] },
})

const chatCard = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Chat ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const cardsOf = (...cards: ChatCard[]): Record<string, ChatCard> =>
  Object.fromEntries(cards.map((card) => [card.id, card]))

describe('resolveTabAbsorbTarget — putting a tab back into a board without dragging', () => {
  // 用户场景：把看板项（典型是监工）「拖出为独立 tab」之后想放回去。拖拽要求
  // 落点当场可见，而拖出那一刻看板就被切成非活动 tab 了；这条出口不依赖落点。
  it('picks the board in the same pane', () => {
    assert.deepEqual(
      resolveTabAbsorbTarget({
        tabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
        columnTabIds: ['board-1', 'chat-1'],
        cards: cardsOf(boardCard('board-1'), chatCard('chat-1')),
      }),
      { boardCardId: 'board-1', lane: 'standby' },
    )
  })

  it('falls back to a board elsewhere in the same column', () => {
    assert.deepEqual(
      resolveTabAbsorbTarget({
        tabId: 'chat-1',
        paneTabIds: ['chat-1'],
        columnTabIds: ['chat-1', 'board-1'],
        cards: cardsOf(boardCard('board-1'), chatCard('chat-1')),
      }),
      { boardCardId: 'board-1', lane: 'standby' },
    )
  })

  it('prefers the board sharing the pane over one further away', () => {
    assert.deepEqual(
      resolveTabAbsorbTarget({
        tabId: 'chat-1',
        paneTabIds: ['chat-1', 'board-2'],
        columnTabIds: ['board-1', 'chat-1', 'board-2'],
        cards: cardsOf(boardCard('board-1'), boardCard('board-2'), chatCard('chat-1')),
      }),
      { boardCardId: 'board-2', lane: 'standby' },
    )
  })

  /**
   * 泳道是按卡片当下的状态选的，为的是**零副作用**：v2 的泳道自带语义，
   * standby/done 会打断正在流的会话，running 在空闲卡上会自动补一条"继续"。
   * 正在跑的进 running（transition 表给出 interrupt:false + send:'none'），
   * 空闲的进 standby（没在流所以不会 interrupt，send 同样是 'none'）。
   */
  it('sends a streaming card to the running lane so nothing gets interrupted', () => {
    assert.deepEqual(
      resolveTabAbsorbTarget({
        tabId: 'chat-1',
        paneTabIds: ['board-1', 'chat-1'],
        columnTabIds: ['board-1', 'chat-1'],
        cards: cardsOf(
          boardCard('board-1'),
          chatCard('chat-1', { status: 'streaming', streamId: 'stream-1' }),
        ),
      }),
      { boardCardId: 'board-1', lane: 'running' },
    )
  })

  it('refuses to absorb a board into a board', () => {
    assert.equal(
      resolveTabAbsorbTarget({
        tabId: 'board-2',
        paneTabIds: ['board-1', 'board-2'],
        columnTabIds: ['board-1', 'board-2'],
        cards: cardsOf(boardCard('board-1'), boardCard('board-2')),
      }),
      null,
    )
  })

  it('has no target when the column holds no board at all', () => {
    assert.equal(
      resolveTabAbsorbTarget({
        tabId: 'chat-1',
        paneTabIds: ['chat-1', 'chat-2'],
        columnTabIds: ['chat-1', 'chat-2'],
        cards: cardsOf(chatCard('chat-1'), chatCard('chat-2')),
      }),
      null,
    )
  })

  it('has no target for a tab whose card is gone', () => {
    assert.equal(
      resolveTabAbsorbTarget({
        tabId: 'gone-1',
        paneTabIds: ['board-1'],
        columnTabIds: ['board-1'],
        cards: cardsOf(boardCard('board-1')),
      }),
      null,
    )
  })
})

describe('PaneView offers the absorb action in the tab context menu', () => {
  it('wires a context-menu entry that routes through absorbTab', async () => {
    const source = await readFile(paneViewSourcePath, 'utf8')

    assert.match(
      source,
      /resolveTabAbsorbTarget/,
      'the tab context menu needs a drag-free way back into the board',
    )
    assert.match(
      source,
      /absorbIntoBoard/,
      'the menu action has to be exposed as its own entry so it can be disabled when the column has no board',
    )
    assert.match(
      source,
      /automationBoardActions\?\.absorbTab\(/,
      'the absorb must go through the existing board action, not a bespoke dispatch',
    )
  })
})
