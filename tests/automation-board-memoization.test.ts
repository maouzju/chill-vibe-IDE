import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAutomationBoardCard, createCard, createDefaultSettings } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { createDefaultAutomationBoardAutoTrigger } from '../shared/schema.ts'
import type { BoardColumn, ChatCard, PaneNode } from '../shared/schema.ts'
import { arePaneViewPropsEqual } from '../src/components/layout-memoization.ts'

const settings = createDefaultSettings()

const itemCard = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Item ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const boardCard = (
  items: Array<{ cardId: string; lane: 'standby' | 'running' | 'done' }>,
  supervisorCardId = '',
): ChatCard => ({
  ...createAutomationBoardCard('Board'),
  id: 'board-1',
  automationBoard: {
    items: items.map((item) => ({ ...item, requirement: `req ${item.cardId}` })),
    supervisorCardId,
    supervisorExpanded: false,
  },
})

/**
 * Every prop except `column.cards` is a SHARED object identity across the two
 * snapshots. Without that, a fresh `pane`/`providers` object would make
 * `arePaneViewPropsEqual` return false for the wrong reason and the "re-renders"
 * assertions below would pass against a comparator that cannot actually see
 * board item cards (AGENTS.md pitfall 248: prove the test fails on the broken
 * implementation, not on incidental identity churn).
 */
const makeSnapshotPair = (
  paneOverrides: Partial<PaneNode>,
  cardsBefore: Record<string, ChatCard>,
  cardsAfter: Record<string, ChatCard>,
) => {
  const pane: PaneNode = {
    type: 'pane',
    id: 'pane-1',
    tabs: ['board-1'],
    activeTabId: 'board-1',
    tabHistory: ['board-1'],
    ...paneOverrides,
  }

  const shared = {
    pane,
    providers: {},
    language: settings.language,
    systemPrompt: settings.systemPrompt,
    crossProviderSkillReuseEnabled: true,
    musicAlbumCoverEnabled: false,
    weatherCity: '',
    gitAgentModel: '',
    brainstormRequestModel: '',
    availableQuickToolModels: [] as string[],
    autoUrgeEnabled: false,
    autoUrgeMessage: '',
    autoUrgeSuccessKeyword: '',
    globalUrgeActive: false,
    globalUrgeProfileId: '',
  }

  const column = (cards: Record<string, ChatCard>): BoardColumn => ({
    id: 'column-1',
    title: 'Workspace',
    provider: 'codex',
    workspacePath: 'D:/repo/one',
    model: DEFAULT_CODEX_MODEL,
    width: undefined,
    layout: pane,
    cards,
  })

  return {
    before: { ...shared, column: column(cardsBefore) },
    after: { ...shared, column: column(cardsAfter) },
    shared,
    column,
  }
}

describe('PaneView memoization sees automation board item cards', () => {
  // 症状：看板项在流式输出时，看板界面纹丝不动（不活跃的看板 tab 也不变橙）。
  // 根因：项卡片刻意不在 pane.tabs 里，而记忆化只比较 tabs 里的卡片引用 +
  //   column.id，所以 column.cards 里项卡片的变化对它完全不可见。
  it('re-renders when a running item card gains a message', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const { before, after } = makeSnapshotPair(
      {},
      { 'board-1': board, 'item-a': itemCard('item-a') },
      {
        'board-1': board,
        'item-a': itemCard('item-a', {
          messages: [
            { id: 'm1', role: 'assistant', content: 'working', createdAt: '2026-08-11T00:00:00.000Z' },
          ],
        }),
      },
    )

    assert.equal(arePaneViewPropsEqual(before, after), false)
  })

  it('re-renders when an item card starts streaming', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const { before, after } = makeSnapshotPair(
      {},
      { 'board-1': board, 'item-a': itemCard('item-a') },
      { 'board-1': board, 'item-a': itemCard('item-a', { status: 'streaming', streamId: 's1' }) },
    )

    assert.equal(arePaneViewPropsEqual(before, after), false)
  })

  // 不活跃的看板 tab 也必须能变橙，所以这条检查不能只在 active tab 上跑。
  it('re-renders for an item change even when the board tab is inactive', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const chat = itemCard('chat-1')
    const { before, after } = makeSnapshotPair(
      { tabs: ['board-1', 'chat-1'], activeTabId: 'chat-1', tabHistory: ['board-1', 'chat-1'] },
      { 'board-1': board, 'item-a': itemCard('item-a'), 'chat-1': chat },
      {
        'board-1': board,
        'item-a': itemCard('item-a', { status: 'streaming', streamId: 's1' }),
        'chat-1': chat,
      },
    )

    assert.equal(arePaneViewPropsEqual(before, after), false)
  })

  it('re-renders when the supervisor card changes', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'done' }], 'sup-1')
    const item = itemCard('item-a')
    const { before, after } = makeSnapshotPair(
      {},
      { 'board-1': board, 'item-a': item, 'sup-1': itemCard('sup-1') },
      {
        'board-1': board,
        'item-a': item,
        'sup-1': itemCard('sup-1', { status: 'streaming', streamId: 's1' }),
      },
    )

    assert.equal(arePaneViewPropsEqual(before, after), false)
  })

  it('stays memoized when nothing the board depends on changed', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const item = itemCard('item-a')
    const { before, after } = makeSnapshotPair(
      {},
      { 'board-1': board, 'item-a': item },
      { 'board-1': board, 'item-a': item },
    )

    assert.equal(arePaneViewPropsEqual(before, after), true)
  })

  // 关键的反向断言：不能退化成"整列比较"，否则同列里任何一张无关卡片的
  // delta 都会重渲染每个 pane（pitfall 187 的放大路径）。
  it('stays memoized when an unrelated off-layout card changes', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const item = itemCard('item-a')
    const { before, after } = makeSnapshotPair(
      {},
      { 'board-1': board, 'item-a': item, other: itemCard('other') },
      { 'board-1': board, 'item-a': item, other: itemCard('other', { status: 'streaming', streamId: 's1' }) },
    )

    assert.equal(arePaneViewPropsEqual(before, after), true)
  })

  it('re-renders when the board workspace state object changes', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const item = itemCard('item-a')
    const cards = { 'board-1': board, 'item-a': item }
    const { before } = makeSnapshotPair({}, cards, cards)
    const workspace = { templates: [], autoTrigger: createDefaultAutomationBoardAutoTrigger() }

    const withWorkspace = { ...before, automationBoardWorkspace: workspace }

    // A new object identity is how App signals "templates or the trigger config
    // changed"; the same identity must stay memoized.
    assert.equal(
      arePaneViewPropsEqual(withWorkspace, { ...before, automationBoardWorkspace: { ...workspace } }),
      false,
    )
    assert.equal(
      arePaneViewPropsEqual(withWorkspace, { ...before, automationBoardWorkspace: workspace }),
      true,
    )
  })
})
