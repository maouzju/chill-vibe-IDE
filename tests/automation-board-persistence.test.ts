import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  createAutomationBoardCard,
  createCard,
  createDefaultSettings,
  createDefaultState,
  createPane,
  getAutomationBoard,
} from '../shared/default-state.ts'
import { AUTOMATIONBOARD_TOOL_MODEL, DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { ChatCard } from '../shared/schema.ts'

const timestamp = '2026-08-11T00:00:00.000Z'

describe('automation board persistence', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-board-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  const buildStateWithBoard = () => {
    const state = createDefaultState('D:/board-workspace')
    const column = state.columns[0]!
    const board = { ...createAutomationBoardCard('看板'), id: 'board-1' }
    const itemA: ChatCard = {
      ...createCard('Item A', undefined, 'codex', DEFAULT_CODEX_MODEL),
      id: 'item-a',
      draft: '把登录页改成暗色',
    }
    const itemB: ChatCard = {
      ...createCard('Item B', undefined, 'codex', DEFAULT_CODEX_MODEL),
      id: 'item-b',
      messages: [{ id: 'm1', role: 'assistant', content: '干完了', createdAt: timestamp }],
    }

    board.automationBoard = {
      items: [
        { cardId: 'item-a', lane: 'standby', requirement: '把登录页改成暗色', createdAt: timestamp },
        { cardId: 'item-b', lane: 'done', requirement: '升级依赖', completedAt: timestamp },
      ],
      supervisorCardId: 'sup-1',
      supervisorExpanded: true,
    }

    const supervisor: ChatCard = {
      ...createCard('监工', undefined, 'claude', 'claude-opus-5'),
      id: 'sup-1',
    }

    column.workspacePath = 'D:/board-workspace'
    column.cards = { 'board-1': board, 'item-a': itemA, 'item-b': itemB, 'sup-1': supervisor }
    // 关键：只有看板卡进 tabs，三张被拥有的卡刻意不在 layout 里。
    column.layout = createPane(['board-1'], 'board-1', 'pane-1')

    state.automationBoards = {
      'D:/board-workspace': {
        templates: [
          {
            id: 'tpl-1',
            name: '发布前检查',
            requirement: '检查发布前的改动',
            provider: 'codex',
            model: DEFAULT_CODEX_MODEL,
            reasoningEffort: 'max',
            thinkingEnabled: true,
            planMode: false,
            wakeTimerActive: false,
            repeatLoopActive: false,
          },
        ],
        autoTrigger: {
          enabled: true,
          kind: 'last-item-settled',
          provider: 'claude',
          model: 'claude-opus-5',
          reasoningEffort: 'max',
          requirement: '检查每个原始需求',
          minIntervalMinutes: 3,
        },
      },
    }

    return state
  }

  it('round-trips a board, its off-layout cards, and its workspace config', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    await saveState(buildStateWithBoard())

    const loaded = await loadState()
    const column = loaded.columns[0]!

    // 被拥有的卡片必须还在 cards 里…
    assert.ok(column.cards['item-a'])
    assert.ok(column.cards['item-b'])
    assert.ok(column.cards['sup-1'])
    // …但绝不能被塞进 tab 栏。
    assert.deepEqual(column.layout.type === 'pane' ? column.layout.tabs : [], ['board-1'])

    const board = getAutomationBoard(column.cards['board-1'])
    assert.deepEqual(board?.items.map((item) => [item.cardId, item.lane, item.requirement]), [
      ['item-a', 'standby', '把登录页改成暗色'],
      ['item-b', 'done', '升级依赖'],
    ])
    assert.equal(board?.supervisorCardId, 'sup-1')
    assert.equal(board?.supervisorExpanded, true)
    assert.equal(board?.items[1]?.completedAt, timestamp)

    const workspace = loaded.automationBoards['D:/board-workspace']
    assert.equal(workspace?.templates[0]?.name, '发布前检查')
    assert.equal(workspace?.autoTrigger.enabled, true)
    assert.equal(workspace?.autoTrigger.minIntervalMinutes, 3)
  })

  // pitfall 5：新增持久化字段后，旧存档必须照常加载并补上默认值。
  it('loads a legacy save that predates every automation-board field', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const legacy = {
      settings: createDefaultSettings(),
      version: 1,
      updatedAt: timestamp,
      sessionHistory: [],
      stickyNoteArchive: {},
      columns: [
        {
          id: 'column-1',
          title: 'Workspace',
          provider: 'codex',
          workspacePath: 'D:/legacy',
          model: DEFAULT_CODEX_MODEL,
          layout: { type: 'pane', id: 'pane-1', tabs: ['card-1'], activeTabId: 'card-1' },
          cards: {
            'card-1': {
              id: 'card-1',
              title: 'Chat',
              status: 'idle',
              provider: 'codex',
              model: DEFAULT_CODEX_MODEL,
              messages: [],
            },
          },
        },
      ],
    }

    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(legacy), 'utf8')

    const loaded = await loadState()
    // 先证明加载的确实是这份旧存档：`loadState` 在夹具不合法时会静默回落到
    // 一份全新的默认状态，那样下面两条断言会因为错误的原因通过。
    assert.equal(loaded.columns[0]?.workspacePath, 'D:/legacy')
    assert.ok(loaded.columns[0]?.cards['card-1'])
    assert.deepEqual(loaded.automationBoards, {})
    assert.equal(loaded.columns[0]?.cards['card-1']?.automationBoard, undefined)
  })

  it('repairs a board whose items reference cards that no longer exist', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const persisted = {
      settings: createDefaultSettings(),
      version: 1,
      updatedAt: timestamp,
      sessionHistory: [],
      stickyNoteArchive: {},
      automationBoards: {},
      columns: [
        {
          id: 'column-1',
          title: 'Workspace',
          provider: 'codex',
          workspacePath: 'D:/orphans',
          model: DEFAULT_CODEX_MODEL,
          layout: { type: 'pane', id: 'pane-1', tabs: ['board-1'], activeTabId: 'board-1' },
          cards: {
            'board-1': {
              id: 'board-1',
              title: 'Board',
              status: 'idle',
              provider: 'codex',
              model: AUTOMATIONBOARD_TOOL_MODEL,
              messages: [],
              automationBoard: {
                items: [
                  { cardId: 'alive', lane: 'running', requirement: 'still here' },
                  { cardId: 'gone', lane: 'running', requirement: 'deleted card' },
                  // 重复条目与坏 lane 都必须被修掉而不是让整列加载失败。
                  { cardId: 'alive', lane: 'done', requirement: 'dupe' },
                  { cardId: '', lane: 'running', requirement: 'no id' },
                  { cardId: 'alive2', lane: 'nonsense', requirement: 'bad lane' },
                ],
                supervisorCardId: '',
                supervisorExpanded: false,
              },
            },
            alive: {
              id: 'alive',
              title: 'Alive',
              status: 'idle',
              provider: 'codex',
              model: DEFAULT_CODEX_MODEL,
              messages: [],
            },
            alive2: {
              id: 'alive2',
              title: 'Alive 2',
              status: 'idle',
              provider: 'codex',
              model: DEFAULT_CODEX_MODEL,
              messages: [],
            },
          },
        },
      ],
    }

    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(persisted), 'utf8')

    const loaded = await loadState()
    const board = getAutomationBoard(loaded.columns[0]?.cards['board-1'])

    assert.ok(board)
    assert.deepEqual(
      board.items.map((item) => [item.cardId, item.lane]),
      [
        ['alive', 'running'],
        // 'gone' 的卡片不在了，但条目保留无害；重复与空 id 必须被剔除，
        // 坏 lane 归一到 standby。
        ['gone', 'running'],
        ['alive2', 'standby'],
      ],
    )
  })

  it('drops a board blob persisted on a card that is not a board', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const persisted = {
      settings: createDefaultSettings(),
      version: 1,
      updatedAt: timestamp,
      sessionHistory: [],
      stickyNoteArchive: {},
      automationBoards: {},
      columns: [
        {
          id: 'column-1',
          title: 'Workspace',
          provider: 'codex',
          workspacePath: 'D:/stale-blob',
          model: DEFAULT_CODEX_MODEL,
          layout: { type: 'pane', id: 'pane-1', tabs: ['chat-1'], activeTabId: 'chat-1' },
          cards: {
            'chat-1': {
              id: 'chat-1',
              title: 'Chat',
              status: 'idle',
              provider: 'codex',
              model: DEFAULT_CODEX_MODEL,
              messages: [],
              automationBoard: {
                items: [{ cardId: 'ghost', lane: 'running', requirement: 'x' }],
                supervisorCardId: '',
                supervisorExpanded: false,
              },
            },
          },
        },
      ],
    }

    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(persisted), 'utf8')

    const loaded = await loadState()
    assert.equal(loaded.columns[0]?.cards['chat-1']?.automationBoard, undefined)
  })

  it('ignores a malformed per-workspace automation board entry instead of failing the load', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const persisted = {
      settings: createDefaultSettings(),
      version: 1,
      updatedAt: timestamp,
      sessionHistory: [],
      stickyNoteArchive: {},
      automationBoards: {
        'D:/good': { templates: [], autoTrigger: { enabled: true } },
        'D:/bad': { templates: 'not an array' },
      },
      columns: [
        {
          id: 'column-1',
          title: 'Workspace',
          provider: 'codex',
          workspacePath: 'D:/good',
          model: DEFAULT_CODEX_MODEL,
          layout: { type: 'pane', id: 'pane-1', tabs: ['chat-1'], activeTabId: 'chat-1' },
          cards: {
            'chat-1': {
              id: 'chat-1',
              title: 'Chat',
              status: 'idle',
              provider: 'codex',
              model: DEFAULT_CODEX_MODEL,
              messages: [],
            },
          },
        },
      ],
    }

    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(persisted), 'utf8')

    const loaded = await loadState()
    assert.equal(loaded.automationBoards['D:/good']?.autoTrigger.enabled, true)
    // 缺省字段被 schema 补齐。
    assert.equal(loaded.automationBoards['D:/good']?.autoTrigger.kind, 'last-item-settled')
    assert.equal(loaded.automationBoards['D:/bad'], undefined)
  })
})
