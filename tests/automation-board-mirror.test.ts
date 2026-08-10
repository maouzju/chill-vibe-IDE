import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAutomationBoardCard, createCard } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import {
  automationBoardMirrorEntryLimit,
  automationBoardMirrorEntryMaxChars,
  automationBoardMirrorPreviewMaxChars,
  automationBoardMirrorRequirementMaxChars,
  automationBoardMirrorSchema,
} from '../shared/schema.ts'
import type { BoardColumn, ChatCard, ChatMessage } from '../shared/schema.ts'
import {
  buildAutomationBoardMirror,
  getAutomationBoardMirrorSignature,
} from '../src/components/automation-board-mirror.ts'

const at = (index: number) =>
  new Date(Date.parse('2026-08-11T00:00:00.000Z') + index * 1000).toISOString()

const message = (index: number, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${index}`,
  role: 'assistant',
  content: `line ${index}`,
  createdAt: at(index),
  ...overrides,
})

const itemCard = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Item ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const column = (cards: Record<string, ChatCard>): BoardColumn => ({
  id: 'column-1',
  title: 'Workspace',
  provider: 'codex',
  workspacePath: 'D:/repo/one',
  model: DEFAULT_CODEX_MODEL,
  width: undefined,
  layout: { type: 'pane', id: 'pane-1', tabs: ['board-1'], activeTabId: 'board-1', tabHistory: ['board-1'] },
  cards,
})

const boardCard = (
  items: Array<{ cardId: string; lane: 'standby' | 'running' | 'done'; requirement?: string; startedAt?: string }>,
  supervisorCardId = '',
): ChatCard => ({
  ...createAutomationBoardCard('Board'),
  id: 'board-1',
  automationBoard: {
    items: items.map((item) => ({
      cardId: item.cardId,
      lane: item.lane,
      requirement: item.requirement ?? `req ${item.cardId}`,
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    })),
    supervisorCardId,
    supervisorExpanded: false,
  },
})

const build = (cards: Record<string, ChatCard>) =>
  buildAutomationBoardMirror({
    column: column(cards),
    boardCardId: 'board-1',
    generatedAt: at(0),
  })

describe('buildAutomationBoardMirror', () => {
  it('produces a payload that satisfies the shared schema', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running', startedAt: at(0) }]),
      'item-a': itemCard('item-a', { status: 'streaming', messages: [message(1)] }),
    })

    assert.ok(mirror)
    assert.doesNotThrow(() => automationBoardMirrorSchema.parse(mirror))
  })

  it('carries the original requirement, lane, status, and activity time', () => {
    const mirror = build({
      'board-1': boardCard([
        { cardId: 'item-a', lane: 'running', requirement: '把登录页改成暗色', startedAt: at(0) },
      ]),
      'item-a': itemCard('item-a', {
        status: 'streaming',
        messages: [message(1), message(5, { content: '已改完 3 个文件' })],
      }),
    })

    const item = mirror!.items[0]!
    assert.equal(item.requirement, '把登录页改成暗色')
    assert.equal(item.lane, 'running')
    assert.equal(item.status, 'streaming')
    assert.equal(item.startedAt, at(0))
    // 监工判断"多久没下文"就靠这个。
    assert.equal(item.lastActivityAt, at(5))
    assert.equal(item.lastMessagePreview, '已改完 3 个文件')
  })

  it('skips items whose card is gone instead of throwing', () => {
    const mirror = build({
      'board-1': boardCard([
        { cardId: 'item-a', lane: 'running' },
        { cardId: 'ghost', lane: 'running' },
      ]),
      'item-a': itemCard('item-a'),
    })

    assert.deepEqual(mirror!.items.map((item) => item.cardId), ['item-a'])
  })

  it('returns null for a card that is not a board', () => {
    assert.equal(build({ 'board-1': itemCard('board-1') }), null)
  })

  it('reports the supervisor status', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'done' }], 'sup-1'),
      'item-a': itemCard('item-a'),
      'sup-1': itemCard('sup-1', { status: 'streaming' }),
    })

    assert.equal(mirror!.supervisorCardId, 'sup-1')
    assert.equal(mirror!.supervisorStatus, 'streaming')
  })
})

describe('automation board mirror payload budgets', () => {
  it('caps the requirement length', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running', requirement: 'x'.repeat(9000) }]),
      'item-a': itemCard('item-a'),
    })

    assert.equal(mirror!.items[0]!.requirement.length, automationBoardMirrorRequirementMaxChars)
  })

  it('caps the last message preview', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
      'item-a': itemCard('item-a', { messages: [message(1, { content: 'y'.repeat(9000) })] }),
    })

    assert.equal(mirror!.items[0]!.lastMessagePreview.length, automationBoardMirrorPreviewMaxChars)
  })

  it('caps both the entry count and each entry length', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
      'item-a': itemCard('item-a', {
        messages: Array.from({ length: 60 }, (_, index) =>
          message(index, { content: 'z'.repeat(4000) }),
        ),
      }),
    })

    const entries = mirror!.items[0]!.recentEntries
    assert.equal(entries.length, automationBoardMirrorEntryLimit)
    for (const entry of entries) {
      assert.equal(entry.content.length, automationBoardMirrorEntryMaxChars)
    }
    // 保留的必须是**最近**的那一批，而不是最早的。
    assert.equal(entries.at(-1)?.id, 'm59')
  })

  // 结构化活动的 content 常常是空的，真正的信息在 meta.kind 里；只看 content
  // 会让监工收到一串空条目而不是"这一轮跑了几个命令"。
  it('describes structured activity entries by kind when content is empty', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
      'item-a': itemCard('item-a', {
        messages: [message(1, { content: '', meta: { kind: 'command' } })],
      }),
    })

    assert.deepEqual(
      mirror!.items[0]!.recentEntries.map((entry) => entry.content),
      ['[command]'],
    )
  })

  it('drops entries that carry neither content nor a kind', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
      'item-a': itemCard('item-a', { messages: [message(1, { content: '   ' })] }),
    })

    assert.deepEqual(mirror!.items[0]!.recentEntries, [])
  })
})

describe('getAutomationBoardMirrorSignature', () => {
  const mirrorFor = (cards: Record<string, ChatCard>) => build(cards)!

  it('is stable when nothing meaningful changed', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const first = mirrorFor({ 'board-1': board, 'item-a': itemCard('item-a', { messages: [message(1)] }) })
    const second = mirrorFor({ 'board-1': board, 'item-a': itemCard('item-a', { messages: [message(1)] }) })

    assert.equal(
      getAutomationBoardMirrorSignature(first),
      getAutomationBoardMirrorSignature(second),
    )
  })

  it('changes when an item starts streaming', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const idle = mirrorFor({ 'board-1': board, 'item-a': itemCard('item-a') })
    const busy = mirrorFor({ 'board-1': board, 'item-a': itemCard('item-a', { status: 'streaming' }) })

    assert.notEqual(getAutomationBoardMirrorSignature(idle), getAutomationBoardMirrorSignature(busy))
  })

  it('changes when a new message arrives', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const before = mirrorFor({ 'board-1': board, 'item-a': itemCard('item-a', { messages: [message(1)] }) })
    const after = mirrorFor({
      'board-1': board,
      'item-a': itemCard('item-a', { messages: [message(1), message(2)] }),
    })

    assert.notEqual(
      getAutomationBoardMirrorSignature(before),
      getAutomationBoardMirrorSignature(after),
    )
  })

  it('changes when an item moves lane', () => {
    const before = mirrorFor({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
      'item-a': itemCard('item-a'),
    })
    const after = mirrorFor({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'done' }]),
      'item-a': itemCard('item-a'),
    })

    assert.notEqual(
      getAutomationBoardMirrorSignature(before),
      getAutomationBoardMirrorSignature(after),
    )
  })

  // 反向断言：只有正文内容变化（同一条消息被流式追加）不该刷新签名，否则
  // 每个 delta 都会跨一次 IPC，节流就白做了。
  it('ignores content-only growth inside the newest message', () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const short = mirrorFor({
      'board-1': board,
      'item-a': itemCard('item-a', { messages: [message(1, { content: 'abc' })] }),
    })
    const grown = mirrorFor({
      'board-1': board,
      'item-a': itemCard('item-a', { messages: [message(1, { content: 'abcdef' })] }),
    })

    assert.equal(
      getAutomationBoardMirrorSignature(short),
      getAutomationBoardMirrorSignature(grown),
    )
  })
})
