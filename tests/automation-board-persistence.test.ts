import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  automationBoardSupervisorTemplateId,
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
        {
          cardId: 'item-a',
          lane: 'standby',
          requirement: '把登录页改成暗色',
          templateId: '',
          createdAt: timestamp,
        },
        {
          cardId: 'item-b',
          lane: 'done',
          requirement: '升级依赖',
          templateId: automationBoardSupervisorTemplateId,
          completedAt: timestamp,
        },
      ],
    }

    const admin: ChatCard = {
      ...createCard('监工', undefined, 'claude', 'claude-opus-5'),
      id: 'sup-1',
      adminAccess: true,
    }

    column.workspacePath = 'D:/board-workspace'
    column.cards = { 'board-1': board, 'item-a': itemA, 'item-b': itemB, 'sup-1': admin }
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
            adminAccess: false,
            builtIn: false,
            trigger: {
              enabled: true,
              kind: 'last-item-settled',
              lane: 'running',
              minIntervalMinutes: 3,
            },
            instanceCardId: 'item-b',
            wakeTimerActive: false,
            repeatLoopActive: false,
          },
        ],
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
    // v2：看板项记住自己是哪个模板生出来的，这是防自触发的唯一依据。
    assert.equal(board?.items[0]?.templateId, '')
    assert.equal(board?.items[1]?.templateId, automationBoardSupervisorTemplateId)
    assert.equal(board?.items[1]?.completedAt, timestamp)
    // 超管权限是卡片字段，不再是看板上的一个 supervisorCardId 指针。
    assert.equal(column.cards['sup-1']?.adminAccess, true)

    const workspace = loaded.automationBoards['D:/board-workspace']
    assert.equal(workspace?.templates[0]?.name, '发布前检查')
    assert.equal(workspace?.templates[0]?.trigger.enabled, true)
    assert.equal(workspace?.templates[0]?.trigger.minIntervalMinutes, 3)
    assert.equal(workspace?.templates[0]?.instanceCardId, 'item-b')
    // 已经有 templates 数组且没有待迁移的 autoTrigger：不再补种内置模板。
    assert.equal(workspace?.templates.length, 1)
  })

  // `normalizePersistedAutomationBoard` 手抄字段（`return { items }`），任何新增的
  // 看板 blob 字段都会被它静默剥掉 —— 症状是"拖完宽度，重启又变回均分"。
  it('round-trips the lane widths the user dragged', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = buildStateWithBoard()
    const board = state.columns[0]!.cards['board-1']!
    board.automationBoard = {
      ...board.automationBoard!,
      laneWidths: { standby: 500, running: 350, done: 350 },
    }

    await saveState(state)
    const loaded = await loadState()

    assert.deepEqual(getAutomationBoard(loaded.columns[0]!.cards['board-1'])?.laneWidths, {
      standby: 500,
      running: 350,
      done: 350,
    })
  })

  // 同一个手抄坑：症状是"待命输入区选的模型和思考深度，重启又变回列默认"。
  it('round-trips the composer defaults the user picked', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = buildStateWithBoard()
    const board = state.columns[0]!.cards['board-1']!
    board.automationBoard = {
      ...board.automationBoard!,
      composeDefaults: {
        provider: 'claude',
        model: 'claude-opus-4-8',
        reasoningEffort: 'high',
        thinkingEnabled: false,
        planMode: true,
        adminAccess: true,
      },
    }

    await saveState(state)
    const loaded = await loadState()

    assert.deepEqual(getAutomationBoard(loaded.columns[0]!.cards['board-1'])?.composeDefaults, {
      provider: 'claude',
      model: 'claude-opus-4-8',
      reasoningEffort: 'high',
      thinkingEnabled: false,
      planMode: true,
      adminAccess: true,
    })
  })

  it('drops lane widths that would render a lane invisible', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = buildStateWithBoard()
    const board = state.columns[0]!.cards['board-1']!
    board.automationBoard = {
      ...board.automationBoard!,
      // 手改过的存档 / 旧版本写坏的值：0 会让那条泳道彻底消失且没有任何 UI
      // 能把它拖回来，只能整组丢弃回默认。
      laneWidths: { standby: 0, running: 350, done: 350 },
    } as never

    await saveState(state)
    const loaded = await loadState()

    assert.equal(getAutomationBoard(loaded.columns[0]!.cards['board-1'])?.laneWidths, undefined)
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

  // 症状：打开看板后新建的每张卡都是看板空壳，重启也治不好。
  // 根因：看板模型漏出了工具模型白名单，被当成真模型写进 settings.requestModels /
  //   lastModel / column.model（见 shared/models.ts TOOL_CARD_MODELS）。修了写入侧
  //   还不够 —— 已经写脏的存档必须在读档时洗掉，否则用户装了新版依旧坏。
  it('heals a save whose remembered models were poisoned by the board model', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const persisted = {
      settings: {
        ...createDefaultSettings(),
        requestModels: { codex: AUTOMATIONBOARD_TOOL_MODEL, claude: AUTOMATIONBOARD_TOOL_MODEL },
        lastModel: { provider: 'codex', model: AUTOMATIONBOARD_TOOL_MODEL },
      },
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
          workspacePath: 'D:/poisoned',
          model: AUTOMATIONBOARD_TOOL_MODEL,
          layout: { type: 'pane', id: 'pane-1', tabs: ['chat-1'], activeTabId: 'chat-1' },
          cards: {
            // model 字段缺失的卡会拿 column.model 兜底 —— 列被污染时它也会
            // 变成一张看板空壳，所以这张卡就是本用例的探针。
            'chat-1': { id: 'chat-1', title: 'Chat', status: 'idle', provider: 'codex', messages: [] },
          },
        },
      ],
    }

    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(persisted), 'utf8')

    const loaded = await loadState()
    assert.equal(loaded.settings.requestModels.codex, DEFAULT_CODEX_MODEL)
    assert.notEqual(loaded.settings.requestModels.claude, AUTOMATIONBOARD_TOOL_MODEL)
    assert.notEqual(loaded.settings.lastModel?.model, AUTOMATIONBOARD_TOOL_MODEL)
    assert.equal(loaded.columns[0]?.model, DEFAULT_CODEX_MODEL)
    assert.notEqual(loaded.columns[0]?.cards['chat-1']?.model, AUTOMATIONBOARD_TOOL_MODEL)
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
        'D:/good': { templates: [] },
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
    // 用户可能自己删掉了内置模板：已有 templates 数组（哪怕为空）且没有待迁移的
    // autoTrigger 时不再补种，否则每次加载都种回来。
    assert.deepEqual(loaded.automationBoards['D:/good']?.templates, [])
    assert.equal(loaded.automationBoards['D:/bad'], undefined)
  })

  // v2 迁移：v1 的工作区级 autoTrigger 折进内置监工模板，supervisor 指针丢弃。
  it('migrates a legacy autoTrigger into the built-in supervisor template', async () => {
    const { loadState } = await import('../server/state-store.ts')
    const persisted = {
      settings: createDefaultSettings(),
      version: 1,
      updatedAt: timestamp,
      sessionHistory: [],
      stickyNoteArchive: {},
      automationBoards: {
        'D:/legacy-trigger': {
          templates: [
            {
              id: 'tpl-user',
              name: '用户模板',
              requirement: '跑一遍回归',
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
            reasoningEffort: 'high',
            requirement: 'X',
            minIntervalMinutes: 7,
          },
        },
        // 从没见过模板的工作区：补种一份内置监工模板。
        'D:/fresh': {},
      },
      columns: [
        {
          id: 'column-1',
          title: 'Workspace',
          provider: 'codex',
          workspacePath: 'D:/legacy-trigger',
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
                items: [{ cardId: 'item-a', lane: 'running', requirement: 'still here' }],
                supervisorCardId: 'sup-1',
                supervisorExpanded: true,
              },
            },
            'item-a': {
              id: 'item-a',
              title: 'Item A',
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
    // supervisor 指针整个消失，item 拿到默认 templateId。
    assert.deepEqual(Object.keys(board), ['items'])
    assert.equal(board.items[0]?.templateId, '')

    const migrated = loaded.automationBoards['D:/legacy-trigger']
    assert.ok(migrated)
    assert.equal('autoTrigger' in migrated, false, 'autoTrigger 绝不再写回')

    // 补种的内置模板放数组开头，用户自己的模板保序跟在后面。
    assert.deepEqual(migrated.templates.map((template) => template.id), [
      automationBoardSupervisorTemplateId,
      'tpl-user',
    ])

    const supervisor = migrated.templates[0]!
    assert.equal(supervisor.builtIn, true)
    assert.equal(supervisor.adminAccess, true)
    assert.equal(supervisor.trigger.enabled, true)
    assert.equal(supervisor.trigger.minIntervalMinutes, 7)
    assert.equal(supervisor.requirement, 'X')
    assert.equal(supervisor.provider, 'claude')
    assert.equal(supervisor.model, 'claude-opus-5')
    assert.equal(supervisor.reasoningEffort, 'high')

    // 没有 templates 字段的工作区 entry = 首次出现，补种默认模板（触发器关着）。
    const fresh = loaded.automationBoards['D:/fresh']
    assert.equal(fresh?.templates.length, 1)
    assert.equal(fresh?.templates[0]?.id, automationBoardSupervisorTemplateId)
    assert.equal(fresh?.templates[0]?.trigger.enabled, false)
  })

  // 迁移只发生一次：把迁移过的结果再存回去、再读出来，不能又种一份内置模板，
  // 也不能把已被用户改过的 trigger 重置回去。
  it('does not re-seed or re-migrate on the next load', async () => {
    const { loadState, saveState } = await import('../server/state-store.ts')
    const state = createDefaultState('D:/idempotent')
    state.automationBoards = {
      'D:/idempotent': { templates: [] },
    }

    await saveState(state)
    const once = await loadState()
    assert.deepEqual(once.automationBoards['D:/idempotent']?.templates, [])

    await saveState(once)
    const twice = await loadState()
    assert.deepEqual(twice.automationBoards['D:/idempotent']?.templates, [])
  })
  // FR13：工作区级的看板存档也是手抄字段的重灾区 —— 它不落盘的话，关掉看板 tab
  // 就等于把整块编排扔了，而这正是本需求要修的东西。
  it('round-trips the workspace-level board arrangement', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')

    const state = buildStateWithBoard()
    state.automationBoards['D:/board-workspace']!.board = {
      items: [
        {
          cardId: 'item-a',
          lane: 'running',
          requirement: '把登录页改成暗色',
          templateId: '',
          startedAt: timestamp,
        },
      ],
      laneWidths: { standby: 1.4, running: 0.8, done: 0.8 },
    }

    await saveState(state)
    const workspace = (await loadState()).automationBoards['D:/board-workspace']

    assert.deepEqual(
      workspace?.board?.items.map((item) => [item.cardId, item.lane]),
      [['item-a', 'running']],
    )
    assert.equal(workspace?.board?.items[0]?.startedAt, timestamp)
    assert.deepEqual(workspace?.board?.laneWidths, { standby: 1.4, running: 0.8, done: 0.8 })
  })

  // 把一个模板实例拖出看板时，血缘盖章在卡片的 `automationBoardTemplateId` 上；
  // `normalizePersistedCard` 是手抄白名单，漏掉它就等于每存一次盘剥一次血缘，
  // 重启后拖回看板的项 templateId 变空串，触发器的防自触发守卫随之失效。
  it('round-trips the template lineage stamped onto a popped-out card', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')

    const state = buildStateWithBoard()
    const column = state.columns[0]!
    column.cards['item-b'] = {
      ...column.cards['item-b']!,
      automationBoardTemplateId: 'tpl-1',
    }

    await saveState(state)
    const loaded = await loadState()

    assert.equal(loaded.columns[0]!.cards['item-b']?.automationBoardTemplateId, 'tpl-1')
  })
})
