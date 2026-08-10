import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createAutomationBoardCard,
  createCard,
  createDefaultSettings,
  collectAutomationBoardOwnedCardIds,
  getAutomationBoard,
  resolveRecoveredColumnLayout,
} from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL, DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { AppState, BoardColumn, ChatCard, PaneNode } from '../shared/schema.ts'
import { findPaneInLayout, ideReducer } from '../src/state.ts'
import { automationBoardHasActiveRun } from '../src/components/automation-board-transitions.ts'

const timestamp = '2026-08-11T00:00:00.000Z'

const pane = (id: string, tabs: string[], activeTabId = tabs[0] ?? ''): PaneNode => ({
  type: 'pane',
  id,
  tabs,
  activeTabId,
  tabHistory: tabs,
})

const boardCard = (items: Array<{ cardId: string; lane: 'standby' | 'running' | 'done' }>): ChatCard => ({
  ...createAutomationBoardCard('Board'),
  id: 'board-1',
  automationBoard: {
    items: items.map((item) => ({ ...item, requirement: `req ${item.cardId}` })),
    supervisorCardId: '',
    supervisorExpanded: false,
  },
})

const itemCard = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Item ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const buildState = (
  overrides: { cards?: Record<string, ChatCard>; layout?: BoardColumn['layout'] } = {},
): AppState => {
  const cards: Record<string, ChatCard> =
    overrides.cards ?? {
      'board-1': boardCard([
        { cardId: 'item-a', lane: 'standby' },
        { cardId: 'item-b', lane: 'running' },
      ]),
      'item-a': itemCard('item-a'),
      'item-b': itemCard('item-b', { status: 'streaming', streamId: 'stream-b' }),
      'chat-1': itemCard('chat-1'),
    }

  return {
    version: 1,
    updatedAt: timestamp,
    settings: createDefaultSettings(),
    sessionHistory: [],
    stickyNoteArchive: {},
    automationBoards: {},
    columns: [
      {
        id: 'column-1',
        title: 'Workspace',
        provider: 'codex',
        workspacePath: 'D:/repo/one',
        model: DEFAULT_CODEX_MODEL,
        width: undefined,
        layout: overrides.layout ?? pane('pane-1', ['board-1', 'chat-1'], 'board-1'),
        cards,
      },
    ],
  }
}

const getBoard = (state: AppState) => state.columns[0]!.cards['board-1']!.automationBoard!

describe('automation board card ownership', () => {
  it('claims every item card plus the supervisor', () => {
    const cards = {
      'board-1': {
        ...boardCard([
          { cardId: 'item-a', lane: 'standby' },
          { cardId: 'item-b', lane: 'running' },
        ]),
        automationBoard: {
          items: [
            { cardId: 'item-a', lane: 'standby' as const, requirement: '' },
            { cardId: 'item-b', lane: 'running' as const, requirement: '' },
          ],
          supervisorCardId: 'sup-1',
          supervisorExpanded: false,
        },
      },
      'item-a': itemCard('item-a'),
      'item-b': itemCard('item-b'),
      'sup-1': itemCard('sup-1'),
      'chat-1': itemCard('chat-1'),
    }

    assert.deepEqual(
      [...collectAutomationBoardOwnedCardIds(cards)].sort(),
      ['item-a', 'item-b', 'sup-1'],
    )
  })
})

describe('resolveRecoveredColumnLayout', () => {
  // 症状：看板需求卡突然全部变成 tab。
  // 根因：normalizePersistedColumn 的空 layout 兜底把 Object.keys(cards) 整个塞进一个 pane。
  it('never recovers board-owned cards into a pane', () => {
    const cards = {
      'board-1': boardCard([
        { cardId: 'item-a', lane: 'standby' },
        { cardId: 'item-b', lane: 'running' },
      ]),
      'item-a': itemCard('item-a'),
      'item-b': itemCard('item-b'),
      'chat-1': itemCard('chat-1'),
    }

    const recovered = resolveRecoveredColumnLayout(pane('pane-1', []), cards)

    assert.equal(recovered.type, 'pane')
    assert.deepEqual((recovered as PaneNode).tabs.sort(), ['board-1', 'chat-1'])
  })

  it('still recovers genuinely orphaned chat cards', () => {
    const cards = { 'chat-1': itemCard('chat-1'), 'chat-2': itemCard('chat-2') }
    const recovered = resolveRecoveredColumnLayout(pane('pane-1', []), cards)

    assert.deepEqual((recovered as PaneNode).tabs.sort(), ['chat-1', 'chat-2'])
  })

  it('leaves a non-empty layout untouched', () => {
    const layout = pane('pane-1', ['chat-1'])
    assert.equal(resolveRecoveredColumnLayout(layout, { 'chat-1': itemCard('chat-1') }), layout)
  })

  it('leaves an empty layout alone when every card is board-owned', () => {
    const cards = {
      'board-1': boardCard([{ cardId: 'item-a', lane: 'standby' }]),
      'item-a': itemCard('item-a'),
    }
    // board-1 itself is not board-owned, so it is the only recoverable tab.
    const recovered = resolveRecoveredColumnLayout(pane('pane-1', []), cards)
    assert.deepEqual((recovered as PaneNode).tabs, ['board-1'])
  })
})

describe('automationBoardHasActiveRun', () => {
  it('is true when any running-lane item is streaming', () => {
    const state = buildState()
    assert.equal(
      automationBoardHasActiveRun(getBoard(state), state.columns[0]!.cards),
      true,
    )
  })

  it('is false when the streaming card sits in standby', () => {
    const state = buildState({
      cards: {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'standby' }]),
        'item-a': itemCard('item-a', { status: 'streaming', streamId: 's' }),
      },
    })

    assert.equal(automationBoardHasActiveRun(getBoard(state), state.columns[0]!.cards), false)
  })

  it('counts a running-lane item awaiting native background work', () => {
    const state = buildState({
      cards: {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
        'item-a': itemCard('item-a', { backgroundWorkPending: true }),
      },
    })

    assert.equal(automationBoardHasActiveRun(getBoard(state), state.columns[0]!.cards), true)
  })

  it('counts the supervisor while it streams', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'done' }])
    const state = buildState({
      cards: {
        'board-1': { ...board, automationBoard: { ...board.automationBoard!, supervisorCardId: 'sup-1' } },
        'item-a': itemCard('item-a'),
        'sup-1': itemCard('sup-1', { status: 'streaming', streamId: 's' }),
      },
    })

    assert.equal(automationBoardHasActiveRun(getBoard(state), state.columns[0]!.cards), true)
  })

  it('is false for a card with no board', () => {
    assert.equal(automationBoardHasActiveRun(undefined, {}), false)
  })
})

describe('createAutomationBoardItem', () => {
  it('creates an off-layout card with the requirement parked in the draft', () => {
    const state = buildState({
      cards: { 'board-1': boardCard([]) },
      layout: pane('pane-1', ['board-1']),
    })

    const next = ideReducer(state, {
      type: 'createAutomationBoardItem',
      columnId: 'column-1',
      boardCardId: 'board-1',
      lane: 'standby',
      requirement: '把登录页改成暗色',
      cardId: 'new-item',
    })

    const column = next.columns[0]!
    assert.equal(column.cards['new-item']?.draft, '把登录页改成暗色')
    assert.equal(column.cards['new-item']?.messages.length, 0)
    // 关键：新卡片进 cards 但绝不进 pane.tabs。
    assert.deepEqual(findPaneInLayout(column.layout, 'pane-1')?.tabs, ['board-1'])
    assert.deepEqual(getBoard(next).items, [
      { cardId: 'new-item', lane: 'standby', requirement: '把登录页改成暗色', createdAt: getBoard(next).items[0]!.createdAt },
    ])
  })

  it('is inert when the board card does not exist', () => {
    const state = buildState()
    const next = ideReducer(state, {
      type: 'createAutomationBoardItem',
      columnId: 'column-1',
      boardCardId: 'missing',
      lane: 'standby',
      requirement: 'x',
      cardId: 'new-item',
    })

    assert.equal(next, state)
  })
})

describe('setAutomationBoardItemLane', () => {
  it('moves an item between lanes and keeps the card untouched', () => {
    const state = buildState()
    const before = state.columns[0]!.cards['item-a']!

    const next = ideReducer(state, {
      type: 'setAutomationBoardItemLane',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-a',
      lane: 'running',
    })

    assert.equal(getBoard(next).items.find((item) => item.cardId === 'item-a')?.lane, 'running')
    assert.equal(next.columns[0]!.cards['item-a'], before)
  })

  it('reorders within a lane at the requested index', () => {
    const state = buildState({
      cards: {
        'board-1': boardCard([
          { cardId: 'item-a', lane: 'running' },
          { cardId: 'item-b', lane: 'running' },
          { cardId: 'item-c', lane: 'running' },
        ]),
        'item-a': itemCard('item-a'),
        'item-b': itemCard('item-b'),
        'item-c': itemCard('item-c'),
      },
      layout: pane('pane-1', ['board-1']),
    })

    const next = ideReducer(state, {
      type: 'setAutomationBoardItemLane',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-c',
      lane: 'running',
      index: 0,
    })

    assert.deepEqual(
      getBoard(next).items.filter((item) => item.lane === 'running').map((item) => item.cardId),
      ['item-c', 'item-a', 'item-b'],
    )
  })

  it('is inert for an unknown item', () => {
    const state = buildState()
    assert.equal(
      ideReducer(state, {
        type: 'setAutomationBoardItemLane',
        columnId: 'column-1',
        boardCardId: 'board-1',
        cardId: 'nope',
        lane: 'done',
      }),
      state,
    )
  })
})

describe('moveAutomationBoardItemToPane — atomic pop-out', () => {
  it('inserts the tab and drops the board item in one commit', () => {
    const state = buildState()
    const cardBefore = state.columns[0]!.cards['item-b']!

    const next = ideReducer(state, {
      type: 'moveAutomationBoardItemToPane',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-b',
      paneId: 'pane-1',
      index: 1,
    })

    const column = next.columns[0]!
    assert.deepEqual(findPaneInLayout(column.layout, 'pane-1')?.tabs, ['board-1', 'item-b', 'chat-1'])
    assert.deepEqual(getBoard(next).items.map((item) => item.cardId), ['item-a'])
    // 无缝的硬性要求：卡片对象身份不变，会话与在飞的流一起活着。
    assert.equal(column.cards['item-b'], cardBefore)
    assert.equal(column.cards['item-b']?.streamId, 'stream-b')
    assert.equal(column.cards['item-b']?.status, 'streaming')
  })

  it('activates the popped-out tab', () => {
    const next = ideReducer(buildState(), {
      type: 'moveAutomationBoardItemToPane',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-b',
      paneId: 'pane-1',
    })

    assert.equal(findPaneInLayout(next.columns[0]!.layout, 'pane-1')?.activeTabId, 'item-b')
  })

  // pitfall 237：两步式搬运里过期的一端会让"删了没写/写了没删"落地。
  it('changes nothing when the target pane is stale', () => {
    const state = buildState()
    assert.equal(
      ideReducer(state, {
        type: 'moveAutomationBoardItemToPane',
        columnId: 'column-1',
        boardCardId: 'board-1',
        cardId: 'item-b',
        paneId: 'pane-gone',
      }),
      state,
    )
  })

  it('changes nothing when the item is not on the board', () => {
    const state = buildState()
    assert.equal(
      ideReducer(state, {
        type: 'moveAutomationBoardItemToPane',
        columnId: 'column-1',
        boardCardId: 'board-1',
        cardId: 'chat-1',
        paneId: 'pane-1',
      }),
      state,
    )
  })

  it('does not archive the card into session history', () => {
    const next = ideReducer(buildState(), {
      type: 'moveAutomationBoardItemToPane',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-b',
      paneId: 'pane-1',
    })

    assert.deepEqual(next.sessionHistory, [])
  })
})

describe('moveTabToAutomationBoard — atomic absorb', () => {
  it('removes the tab and appends the board item in one commit', () => {
    const state = buildState()
    const cardBefore = state.columns[0]!.cards['chat-1']!

    const next = ideReducer(state, {
      type: 'moveTabToAutomationBoard',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'chat-1',
      boardCardId: 'board-1',
      lane: 'running',
    })

    const column = next.columns[0]!
    assert.deepEqual(findPaneInLayout(column.layout, 'pane-1')?.tabs, ['board-1'])
    assert.equal(getBoard(next).items.find((item) => item.cardId === 'chat-1')?.lane, 'running')
    assert.equal(column.cards['chat-1'], cardBefore)
  })

  it('captures the requirement from the draft when there is no history', () => {
    const state = buildState({
      cards: {
        'board-1': boardCard([]),
        'chat-1': itemCard('chat-1', { draft: '起草发布说明', messages: [] }),
      },
      layout: pane('pane-1', ['board-1', 'chat-1']),
    })

    const next = ideReducer(state, {
      type: 'moveTabToAutomationBoard',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'chat-1',
      boardCardId: 'board-1',
      lane: 'standby',
    })

    assert.equal(getBoard(next).items[0]?.requirement, '起草发布说明')
  })

  it('captures the requirement from the first user message when history exists', () => {
    const state = buildState({
      cards: {
        'board-1': boardCard([]),
        'chat-1': itemCard('chat-1', {
          draft: '后来又写的草稿',
          messages: [
            { id: 'm1', role: 'user', content: '最初的需求', createdAt: timestamp },
            { id: 'm2', role: 'assistant', content: '好', createdAt: timestamp },
          ],
        }),
      },
      layout: pane('pane-1', ['board-1', 'chat-1']),
    })

    const next = ideReducer(state, {
      type: 'moveTabToAutomationBoard',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'chat-1',
      boardCardId: 'board-1',
      lane: 'standby',
    })

    assert.equal(getBoard(next).items[0]?.requirement, '最初的需求')
  })

  it('refuses to absorb the board card into itself', () => {
    const state = buildState()
    assert.equal(
      ideReducer(state, {
        type: 'moveTabToAutomationBoard',
        columnId: 'column-1',
        paneId: 'pane-1',
        tabId: 'board-1',
        boardCardId: 'board-1',
        lane: 'standby',
      }),
      state,
    )
  })

  it('changes nothing when the source pane is stale', () => {
    const state = buildState()
    assert.equal(
      ideReducer(state, {
        type: 'moveTabToAutomationBoard',
        columnId: 'column-1',
        paneId: 'pane-gone',
        tabId: 'chat-1',
        boardCardId: 'board-1',
        lane: 'standby',
      }),
      state,
    )
  })

  it('changes nothing when the target board card is not a board', () => {
    const state = buildState()
    assert.equal(
      ideReducer(state, {
        type: 'moveTabToAutomationBoard',
        columnId: 'column-1',
        paneId: 'pane-1',
        tabId: 'chat-1',
        boardCardId: 'item-a',
        lane: 'standby',
      }),
      state,
    )
  })

  it('does not archive the absorbed card into session history', () => {
    const next = ideReducer(buildState(), {
      type: 'moveTabToAutomationBoard',
      columnId: 'column-1',
      paneId: 'pane-1',
      tabId: 'chat-1',
      boardCardId: 'board-1',
      lane: 'standby',
    })

    assert.deepEqual(next.sessionHistory, [])
  })
})

describe('removeAutomationBoardItem', () => {
  it('drops the item and deletes the card', () => {
    const next = ideReducer(buildState(), {
      type: 'removeAutomationBoardItem',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-a',
      deleteCard: true,
    })

    assert.deepEqual(getBoard(next).items.map((item) => item.cardId), ['item-b'])
    assert.equal(next.columns[0]!.cards['item-a'], undefined)
  })

  it('can drop the item while keeping the card', () => {
    const next = ideReducer(buildState(), {
      type: 'removeAutomationBoardItem',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-a',
      deleteCard: false,
    })

    assert.equal(getBoard(next).items.length, 1)
    assert.ok(next.columns[0]!.cards['item-a'])
  })
})

describe('stampAutomationBoardItem', () => {
  it('records the started timestamp', () => {
    const next = ideReducer(buildState(), {
      type: 'stampAutomationBoardItem',
      columnId: 'column-1',
      boardCardId: 'board-1',
      cardId: 'item-a',
      patch: { startedAt: timestamp },
    })

    assert.equal(getBoard(next).items.find((item) => item.cardId === 'item-a')?.startedAt, timestamp)
  })
})

describe('ensureAutomationBoardSupervisor', () => {
  it('creates an off-layout supervisor card once', () => {
    const first = ideReducer(buildState(), {
      type: 'ensureAutomationBoardSupervisor',
      columnId: 'column-1',
      boardCardId: 'board-1',
      provider: 'claude',
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      cardId: 'sup-1',
    })

    assert.equal(getBoard(first).supervisorCardId, 'sup-1')
    assert.equal(first.columns[0]!.cards['sup-1']?.provider, 'claude')
    assert.deepEqual(findPaneInLayout(first.columns[0]!.layout, 'pane-1')?.tabs, ['board-1', 'chat-1'])

    const second = ideReducer(first, {
      type: 'ensureAutomationBoardSupervisor',
      columnId: 'column-1',
      boardCardId: 'board-1',
      provider: 'claude',
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      cardId: 'sup-2',
    })

    assert.equal(getBoard(second).supervisorCardId, 'sup-1')
    assert.equal(second.columns[0]!.cards['sup-2'], undefined)
  })

  it('retargets the supervisor model on an existing supervisor', () => {
    const first = ideReducer(buildState(), {
      type: 'ensureAutomationBoardSupervisor',
      columnId: 'column-1',
      boardCardId: 'board-1',
      provider: 'claude',
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      cardId: 'sup-1',
    })

    const retargeted = ideReducer(first, {
      type: 'ensureAutomationBoardSupervisor',
      columnId: 'column-1',
      boardCardId: 'board-1',
      provider: 'codex',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      cardId: 'sup-2',
    })

    assert.equal(retargeted.columns[0]!.cards['sup-1']?.provider, 'codex')
    assert.equal(retargeted.columns[0]!.cards['sup-1']?.model, 'gpt-5.6-terra')
  })
})

describe('automation board workspace state', () => {
  it('saves, renames, and removes templates per workspace', () => {
    const saved = ideReducer(buildState(), {
      type: 'saveAutomationBoardTemplate',
      workspacePath: 'D:/repo/one',
      template: {
        id: 'tpl-1',
        name: '发布检查',
        requirement: '检查发布前的改动',
        provider: 'codex',
        model: DEFAULT_CODEX_MODEL,
        reasoningEffort: 'max',
        thinkingEnabled: true,
        planMode: false,
        wakeTimerActive: false,
        repeatLoopActive: false,
      },
    })

    assert.equal(saved.automationBoards['D:/repo/one']?.templates.length, 1)

    const renamed = ideReducer(saved, {
      type: 'renameAutomationBoardTemplate',
      workspacePath: 'D:/repo/one',
      templateId: 'tpl-1',
      name: '发布前检查',
    })
    assert.equal(renamed.automationBoards['D:/repo/one']?.templates[0]?.name, '发布前检查')

    const removed = ideReducer(renamed, {
      type: 'removeAutomationBoardTemplate',
      workspacePath: 'D:/repo/one',
      templateId: 'tpl-1',
    })
    assert.deepEqual(removed.automationBoards['D:/repo/one']?.templates, [])
  })

  it('replaces a template saved under an existing id instead of duplicating it', () => {
    const template = {
      id: 'tpl-1',
      name: 'A',
      requirement: 'x',
      provider: 'codex' as const,
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: 'max',
      thinkingEnabled: true,
      planMode: false,
      wakeTimerActive: false,
      repeatLoopActive: false,
    }

    const once = ideReducer(buildState(), {
      type: 'saveAutomationBoardTemplate',
      workspacePath: 'D:/repo/one',
      template,
    })
    const twice = ideReducer(once, {
      type: 'saveAutomationBoardTemplate',
      workspacePath: 'D:/repo/one',
      template: { ...template, name: 'B' },
    })

    assert.equal(twice.automationBoards['D:/repo/one']?.templates.length, 1)
    assert.equal(twice.automationBoards['D:/repo/one']?.templates[0]?.name, 'B')
  })

  it('patches the auto trigger config and seeds defaults for a new workspace', () => {
    const next = ideReducer(buildState(), {
      type: 'updateAutomationBoardAutoTrigger',
      workspacePath: 'D:/repo/one',
      patch: { enabled: true, model: 'claude-opus-5' },
    })

    const config = next.automationBoards['D:/repo/one']?.autoTrigger
    assert.equal(config?.enabled, true)
    assert.equal(config?.model, 'claude-opus-5')
    // 未指定的字段必须落在 schema 默认值上，而不是变成 undefined。
    assert.equal(config?.kind, 'last-item-settled')
    assert.ok((config?.requirement ?? '').includes('鞭策'))
  })

  it('keeps other workspaces untouched', () => {
    const next = ideReducer(buildState(), {
      type: 'updateAutomationBoardAutoTrigger',
      workspacePath: 'D:/repo/two',
      patch: { enabled: true },
    })

    assert.equal(next.automationBoards['D:/repo/one'], undefined)
    assert.deepEqual(Object.keys(next.automationBoards), ['D:/repo/two'])
    assert.equal(next.automationBoards['D:/repo/two']?.autoTrigger.enabled, true)
  })
})

describe('turning an existing card into a board', () => {
  // 空态工具栅格与模型选择器都只是"改这张卡的 model"，不会新建卡片。若切换
  // 到看板模型时不顺手建出 automationBoard，卡片会变成一张什么都不渲染的空壳。
  it('seeds the board blob when a chat card switches to the board model', () => {
    const state = buildState({
      cards: { 'chat-1': itemCard('chat-1') },
      layout: pane('pane-1', ['chat-1']),
    })

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'chat-1',
      provider: 'codex',
      model: AUTOMATIONBOARD_TOOL_MODEL,
    })

    assert.deepEqual(next.columns[0]!.cards['chat-1']?.automationBoard, {
      items: [],
      supervisorCardId: '',
      supervisorExpanded: false,
    })
  })

  it('keeps an existing board intact when the model is re-selected', () => {
    const state = buildState()
    const before = getBoard(state)

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'board-1',
      provider: 'codex',
      model: AUTOMATIONBOARD_TOOL_MODEL,
    })

    assert.deepEqual(next.columns[0]!.cards['board-1']?.automationBoard?.items, before.items)
  })

  // 切走时保留 blob 是刻意的：一次误点必须可逆。真正的把关在读取侧 ——
  // `getAutomationBoard` 只在卡片确实是看板时才认这个 blob。
  it('keeps the blob when switching away so switching back restores the board', () => {
    const state = buildState()

    const away = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'board-1',
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL,
    })

    assert.ok(away.columns[0]!.cards['board-1']?.automationBoard)
    // 但此刻它不再作数。
    assert.equal(getAutomationBoard(away.columns[0]!.cards['board-1']), undefined)
    assert.deepEqual([...collectAutomationBoardOwnedCardIds(away.columns[0]!.cards)], [])

    const back = ideReducer(away, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'board-1',
      provider: 'codex',
      model: AUTOMATIONBOARD_TOOL_MODEL,
    })

    assert.deepEqual(
      getAutomationBoard(back.columns[0]!.cards['board-1'])?.items.map((item) => item.cardId),
      ['item-a', 'item-b'],
    )
  })

  // 切走之后那些项卡片成为真正的孤儿；下次加载必须把它们恢复成 tab，
  // 否则用户既看不见也删不掉。
  it('lets orphaned items be recovered as tabs once the board is no longer a board', () => {
    const away = ideReducer(buildState(), {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'board-1',
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL,
    })

    const recovered = resolveRecoveredColumnLayout(
      pane('pane-1', []),
      away.columns[0]!.cards,
    ) as PaneNode

    assert.deepEqual(recovered.tabs.sort(), ['board-1', 'chat-1', 'item-a', 'item-b'])
  })

  it('does not put a board blob on an ordinary chat card', () => {
    const state = buildState({
      cards: { 'chat-1': itemCard('chat-1') },
      layout: pane('pane-1', ['chat-1']),
    })

    const next = ideReducer(state, {
      type: 'selectCardModel',
      columnId: 'column-1',
      cardId: 'chat-1',
      provider: 'claude',
      model: 'claude-opus-5',
    })

    assert.equal(next.columns[0]!.cards['chat-1']?.automationBoard, undefined)
  })
})

describe('board card model identity', () => {
  it('createAutomationBoardCard is a tool card with an empty board', () => {
    const card = createAutomationBoardCard()

    assert.equal(card.model, AUTOMATIONBOARD_TOOL_MODEL)
    assert.deepEqual(card.automationBoard, {
      items: [],
      supervisorCardId: '',
      supervisorExpanded: false,
    })
  })
})
