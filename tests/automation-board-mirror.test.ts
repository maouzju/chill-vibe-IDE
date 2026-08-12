import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAutomationBoardCard, createCard } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL, GIT_TOOL_MODEL } from '../shared/models.ts'
import {
  workspaceMirrorEntryLimit,
  workspaceMirrorEntryMaxChars,
  workspaceMirrorPreviewMaxChars,
  workspaceMirrorRequirementMaxChars,
  workspaceSessionMirrorSchema,
} from '../shared/schema.ts'
import type { AutomationBoardLane, BoardColumn, ChatCard, ChatMessage, LayoutNode } from '../shared/schema.ts'
import {
  buildWorkspaceSessionMirror,
  getWorkspaceSessionMirrorSignature,
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

const chatCard = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Item ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const defaultLayout: LayoutNode = {
  type: 'pane',
  id: 'pane-1',
  tabs: ['board-1', 'chat-1'],
  activeTabId: 'board-1',
  tabHistory: ['board-1'],
}

const column = (cards: Record<string, ChatCard>, layout: LayoutNode = defaultLayout): BoardColumn => ({
  id: 'column-1',
  title: 'Workspace',
  provider: 'codex',
  workspacePath: 'D:/repo/one',
  model: DEFAULT_CODEX_MODEL,
  width: undefined,
  layout,
  cards,
})

const boardCard = (
  items: Array<{
    cardId: string
    lane: AutomationBoardLane
    requirement?: string
    startedAt?: string
  }>,
  id = 'board-1',
): ChatCard => ({
  ...createAutomationBoardCard('Board'),
  id,
  automationBoard: {
    items: items.map((item) => ({
      cardId: item.cardId,
      lane: item.lane,
      requirement: item.requirement ?? `req ${item.cardId}`,
      templateId: '',
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    })),
  },
})

const build = (cards: Record<string, ChatCard>, layout?: LayoutNode) =>
  buildWorkspaceSessionMirror({ column: column(cards, layout), generatedAt: at(0) })

const sessionOf = (cards: Record<string, ChatCard>, cardId: string) =>
  build(cards)!.sessions.find((session) => session.cardId === cardId)!

describe('buildWorkspaceSessionMirror', () => {
  it('produces a payload that satisfies the shared schema', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running', startedAt: at(0) }]),
      'item-a': chatCard('item-a', { status: 'streaming', messages: [message(1)] }),
      'chat-1': chatCard('chat-1'),
    })

    assert.ok(mirror)
    assert.doesNotThrow(() => workspaceSessionMirrorSchema.parse(mirror))
  })

  // 超管权限的语义是"操作这个工作区的其他会话"，不限于看板项 —— 普通 tab
  // 会话必须同样可见，否则 MCP 侧根本看不到它们。
  it('lists plain tab sessions and board items side by side', () => {
    const cards = {
      'board-1': boardCard([{ cardId: 'item-a', lane: 'running', startedAt: at(3) }]),
      'item-a': chatCard('item-a'),
      'chat-1': chatCard('chat-1'),
    }

    const tab = sessionOf(cards, 'chat-1')
    assert.equal(tab.isTab, true)
    assert.equal(tab.board, undefined)

    const item = sessionOf(cards, 'item-a')
    assert.equal(item.isTab, false)
    assert.equal(item.board?.boardCardId, 'board-1')
    assert.equal(item.board?.lane, 'running')
    assert.equal(item.board?.startedAt, at(3))
  })

  it('excludes tool cards, the board container card included', () => {
    const mirror = build({
      'board-1': boardCard([{ cardId: 'item-a', lane: 'standby' }]),
      'item-a': chatCard('item-a'),
      'chat-1': chatCard('chat-1'),
      'git-1': chatCard('git-1', { model: GIT_TOOL_MODEL }),
    })

    assert.deepEqual(
      mirror!.sessions.map((session) => session.cardId).sort(),
      ['chat-1', 'item-a'],
    )
    // 看板卡本身不是会话，但 MCP 需要知道"换道会落到哪张看板"。
    assert.deepEqual(mirror!.boardCardIds, ['board-1'])
  })

  it('carries the original requirement, status, and activity time', () => {
    const cards = {
      'board-1': boardCard([
        { cardId: 'item-a', lane: 'running', requirement: '把登录页改成暗色', startedAt: at(0) },
      ]),
      'item-a': chatCard('item-a', {
        status: 'streaming',
        messages: [message(1), message(5, { content: '已改完 3 个文件' })],
      }),
    }

    const session = sessionOf(cards, 'item-a')
    assert.equal(session.board?.requirement, '把登录页改成暗色')
    assert.equal(session.status, 'streaming')
    // 监工判断"多久没下文"就靠这个。
    assert.equal(session.lastActivityAt, at(5))
    assert.equal(session.lastMessagePreview, '已改完 3 个文件')
  })

  it('skips board items whose card is gone instead of throwing', () => {
    const mirror = build({
      'board-1': boardCard([
        { cardId: 'item-a', lane: 'running' },
        { cardId: 'ghost', lane: 'running' },
      ]),
      'item-a': chatCard('item-a'),
    })

    assert.deepEqual(mirror!.sessions.map((session) => session.cardId), ['item-a'])
  })

  it('returns null when the column has neither a session nor a board', () => {
    assert.equal(build({ 'git-1': chatCard('git-1', { model: GIT_TOOL_MODEL }) }), null)
  })
})

describe('workspace session mirror payload budgets', () => {
  it('caps the requirement length', () => {
    const session = sessionOf(
      {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'running', requirement: 'x'.repeat(9000) }]),
        'item-a': chatCard('item-a'),
      },
      'item-a',
    )

    assert.equal(session.board?.requirement.length, workspaceMirrorRequirementMaxChars)
  })

  it('caps the last message preview', () => {
    const session = sessionOf(
      {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
        'item-a': chatCard('item-a', { messages: [message(1, { content: 'y'.repeat(9000) })] }),
      },
      'item-a',
    )

    assert.equal(session.lastMessagePreview.length, workspaceMirrorPreviewMaxChars)
  })

  it('caps both the entry count and each entry length', () => {
    const session = sessionOf(
      {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
        'item-a': chatCard('item-a', {
          messages: Array.from({ length: 60 }, (_, index) =>
            message(index, { content: 'z'.repeat(4000) }),
          ),
        }),
      },
      'item-a',
    )

    assert.equal(session.recentEntries.length, workspaceMirrorEntryLimit)
    for (const entry of session.recentEntries) {
      assert.equal(entry.content.length, workspaceMirrorEntryMaxChars)
    }
    // 保留的必须是**最近**的那一批，而不是最早的。
    assert.equal(session.recentEntries.at(-1)?.id, 'm59')
  })

  // 结构化活动的 content 常常是空的，真正的信息在 meta.kind 里；只看 content
  // 会让超管会话收到一串空条目而不是"这一轮跑了几个命令"。
  it('describes structured activity entries by kind when content is empty', () => {
    const session = sessionOf(
      {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
        'item-a': chatCard('item-a', {
          messages: [message(1, { content: '', meta: { kind: 'command' } })],
        }),
      },
      'item-a',
    )

    assert.deepEqual(session.recentEntries.map((entry) => entry.content), ['[command]'])
  })

  it('drops entries that carry neither content nor a kind', () => {
    const session = sessionOf(
      {
        'board-1': boardCard([{ cardId: 'item-a', lane: 'running' }]),
        'item-a': chatCard('item-a', { messages: [message(1, { content: '   ' })] }),
      },
      'item-a',
    )

    assert.deepEqual(session.recentEntries, [])
  })
})

describe('getWorkspaceSessionMirrorSignature', () => {
  // pitfall 257：两个快照只允许在被测字段上不同。所有共享输入都必须是**同一个
  // 对象身份**，否则签名会因为无关字段（随机 id、新建的 board blob）而变化，
  // 一个根本看不见新数据的签名照样全绿。
  const base = () => {
    const board = boardCard([{ cardId: 'item-a', lane: 'running' }])
    const item = chatCard('item-a', { messages: [message(1)] })
    const chat = chatCard('chat-1')
    return { board, item, chat, cards: { 'board-1': board, 'item-a': item, 'chat-1': chat } }
  }

  const signatureFor = (cards: Record<string, ChatCard>, layout?: LayoutNode) =>
    getWorkspaceSessionMirrorSignature(build(cards, layout)!)

  it('is stable when nothing meaningful changed', () => {
    const { cards } = base()
    assert.equal(signatureFor(cards), signatureFor({ ...cards }))
  })

  it('changes when a session starts streaming', () => {
    const { item, cards } = base()
    assert.notEqual(
      signatureFor(cards),
      signatureFor({ ...cards, 'item-a': { ...item, status: 'streaming' } }),
    )
  })

  it('changes when a new message arrives', () => {
    const { item, cards } = base()
    assert.notEqual(
      signatureFor(cards),
      signatureFor({ ...cards, 'item-a': { ...item, messages: [message(1), message(2)] } }),
    )
  })

  it('changes when a board item moves lane', () => {
    const { cards } = base()
    assert.notEqual(
      signatureFor(cards),
      signatureFor({ ...cards, 'board-1': boardCard([{ cardId: 'item-a', lane: 'done' }]) }),
    )
  })

  it('changes when a session becomes a tab', () => {
    const { cards } = base()
    assert.notEqual(
      signatureFor(cards),
      signatureFor(cards, {
        type: 'pane',
        id: 'pane-1',
        tabs: ['board-1', 'chat-1', 'item-a'],
        activeTabId: 'board-1',
        tabHistory: ['board-1'],
      }),
    )
  })

  // 反向断言：只有正文内容变化（同一条消息被流式追加）不该刷新签名，否则
  // 每个 delta 都会跨一次 IPC，节流就白做了（pitfall 258）。
  it('ignores content-only growth inside the newest message', () => {
    const { item, cards } = base()
    const short = { ...cards, 'item-a': { ...item, messages: [message(1, { content: 'abc' })] } }
    const grown = { ...cards, 'item-a': { ...item, messages: [message(1, { content: 'abcdef' })] } }

    assert.equal(signatureFor(short), signatureFor(grown))
  })
})
