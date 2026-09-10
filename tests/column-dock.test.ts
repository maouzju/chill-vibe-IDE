import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createCard, createColumn, createDefaultState } from '../shared/default-state.ts'
import {
  boardColumnSchema,
  type AppState,
  type BoardColumn,
  type ChatCard,
} from '../shared/schema.ts'
import { ideReducer, selectDockedColumnStatus } from '../src/state.ts'
import { getAutoReadCardIdsForVisiblePanes } from '../src/components/pane-read-state.ts'

const createState = (): AppState => {
  const base = createDefaultState('D:/Git/other-repo', 'en')
  return {
    ...base,
    updatedAt: '2026-09-10T00:00:00.000Z',
    columns: [
      createColumn({ id: 'column-1', workspacePath: 'D:/Git/other-repo' }, 'en'),
      createColumn({ id: 'column-2', workspacePath: 'D:/Git/docs-site' }, 'en'),
      createColumn({ id: 'column-3', workspacePath: 'D:/Git/notes' }, 'en'),
    ],
  }
}

describe('workspace column dock', () => {
  it('dockColumn marks the column docked without changing column order', () => {
    const state = createState()
    const next = ideReducer(state, { type: 'dockColumn', columnId: 'column-2' })

    assert.notEqual(next, state)
    assert.deepEqual(
      next.columns.map((column) => column.id),
      ['column-1', 'column-2', 'column-3'],
    )
    assert.equal(next.columns[1]?.docked, true)
    assert.equal(next.columns[0]?.docked, undefined)
    assert.equal(next.columns[2]?.docked, undefined)
    assert.notEqual(next.updatedAt, state.updatedAt)
  })

  it('dockColumn is a no-op for an already docked column or an unknown column', () => {
    const state = createState()
    const docked = ideReducer(state, { type: 'dockColumn', columnId: 'column-2' })

    assert.equal(ideReducer(docked, { type: 'dockColumn', columnId: 'column-2' }), docked)
    assert.equal(ideReducer(state, { type: 'dockColumn', columnId: 'missing' }), state)
  })

  it('undockColumn restores the column in its original position and drops the flag', () => {
    const state = createState()
    const docked = ideReducer(state, { type: 'dockColumn', columnId: 'column-2' })
    const next = ideReducer(docked, { type: 'undockColumn', columnId: 'column-2' })

    assert.notEqual(next, docked)
    assert.deepEqual(
      next.columns.map((column) => column.id),
      ['column-1', 'column-2', 'column-3'],
    )
    assert.equal(next.columns[1]?.docked, undefined)
    assert.equal('docked' in (next.columns[1] ?? {}), false)
    // Everything else on the column survives the round trip.
    assert.deepEqual(next.columns[1]?.cards, state.columns[1]?.cards)
    assert.deepEqual(next.columns[1]?.layout, state.columns[1]?.layout)
  })

  it('undockColumn is a no-op for a column that is not docked', () => {
    const state = createState()

    assert.equal(ideReducer(state, { type: 'undockColumn', columnId: 'column-1' }), state)
    assert.equal(ideReducer(state, { type: 'undockColumn', columnId: 'missing' }), state)
  })

  it('boardColumnSchema accepts saved columns with and without the docked flag', () => {
    const legacy = createColumn({ id: 'legacy' }, 'en')
    const parsedLegacy = boardColumnSchema.parse(legacy)
    assert.equal(parsedLegacy.docked, undefined)

    const parsedDocked = boardColumnSchema.parse({ ...legacy, docked: true })
    assert.equal(parsedDocked.docked, true)
  })

  it('createColumn only carries the docked flag when explicitly asked', () => {
    assert.equal('docked' in createColumn({}, 'en'), false)
    assert.equal(createColumn({ docked: true }, 'en').docked, true)
  })
})

// 症状: 把一列收进顶栏，重启应用后它又回到看板上，顶栏 chip 消失。
// 根因: server/state-store.ts 的 normalizePersistedColumn 逐字段重建 BoardColumn，
//       width 抄了、docked 没抄 —— reducer 与 schema 的测试全绿也照样丢。
// 为什么测到 loadState 这一层: 只测 reducer / schema 证明不了字段能活过一次存取，
//       这一族 bug（usageTotals 等）每次都是从逐字段 normalizer 漏出去的。
describe('docked columns survive persistence', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-dock-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  })

  it('keeps the docked flag across a save and load round trip', async () => {
    const { saveState, loadState } = await import('../server/state-store.ts')
    const state = createState()
    const docked = ideReducer(state, { type: 'dockColumn', columnId: 'column-3' })
    assert.equal(docked.columns[2]?.docked, true)

    await saveState(docked)
    const loaded = await loadState()

    assert.equal(loaded.columns[2]?.docked, true)
    // 未停靠的列不能凭空长出这个键，否则旧存档的形状就被改了。
    assert.equal('docked' in (loaded.columns[0] ?? {}), false)
    assert.equal('docked' in (loaded.columns[1] ?? {}), false)
  })
})

describe('docked column status badge', () => {
  const columnWith = (cards: Array<Partial<ChatCard>>): BoardColumn => {
    const base = createColumn({ id: 'c', workspacePath: 'D:/Git/other-repo' }, 'en')
    return {
      ...base,
      cards: Object.fromEntries(
        cards.map((patch, index) => {
          const card = {
            ...createCard(`card-${index}`, undefined, 'codex', undefined, undefined, 'en'),
            ...patch,
          }
          return [card.id, card]
        }),
      ),
    }
  }

  it('reports running when any card is streaming', () => {
    const status = selectDockedColumnStatus(
      columnWith([{ status: 'idle' }, { status: 'streaming' }]),
    )
    assert.equal(status.running, true)
  })

  it('is not running when every card is idle or errored', () => {
    const status = selectDockedColumnStatus(columnWith([{ status: 'idle' }, { status: 'error' }]))
    assert.equal(status.running, false)
  })

  it('reports a new result when an idle card is unread', () => {
    const status = selectDockedColumnStatus(columnWith([{ status: 'idle', unread: true }]))
    assert.equal(status.hasNewResult, true)
  })

  it('treats a completion glow as a new result too', () => {
    const status = selectDockedColumnStatus(
      columnWith([{ status: 'idle', unread: false, completionGlow: true }]),
    )
    assert.equal(status.hasNewResult, true)
  })

  // A column can be both: one card still streaming while an earlier one already
  // finished unread. The chip must be able to show both affordances at once.
  it('reports running and a new result independently', () => {
    const status = selectDockedColumnStatus(
      columnWith([{ status: 'streaming' }, { status: 'idle', unread: true }]),
    )
    assert.equal(status.running, true)
    assert.equal(status.hasNewResult, true)
  })

  it('reports neither for an empty or fully-read column', () => {
    assert.deepEqual(selectDockedColumnStatus(columnWith([])), {
      running: false,
      hasNewResult: false,
    })
    assert.deepEqual(selectDockedColumnStatus(columnWith([{ status: 'idle', unread: false }])), {
      running: false,
      hasNewResult: false,
    })
  })
})

describe('docked columns are not auto-marked read', () => {
  // 症状: 收起的列跑完后蓝点立刻消失，用户永远看不到"有新结果"。
  // 根因: 自动已读把每个 pane 的活动 tab 当成"用户正看着"，但停靠列根本没渲染。
  // 这里锁死判据本身：停靠列必须当作不可见处理（boardVisible=false）。
  it('a docked column layout must be treated as not visible', () => {
    const column = createColumn({ id: 'c', workspacePath: 'D:/Git/other-repo', docked: true }, 'en')
    const cardId = Object.keys(column.cards)[0] ?? ''
    assert.ok(cardId, 'fixture should have a card')

    const cards = { [cardId]: { id: cardId, unread: true } }

    // 看板可见时会自动已读 —— 这正是停靠列必须避开的行为。
    assert.deepEqual(getAutoReadCardIdsForVisiblePanes(column.layout, cards, true), [cardId])
    // 停靠列按不可见处理后，未读得以保留。
    assert.deepEqual(getAutoReadCardIdsForVisiblePanes(column.layout, cards, false), [])
    // 收起状态下派生出的"有新结果"必须仍然为真。
    assert.equal(
      selectDockedColumnStatus({
        cards: { [cardId]: { ...column.cards[cardId]!, unread: true } },
      }).hasNewResult,
      true,
    )
  })
})
