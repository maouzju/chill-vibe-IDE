/**
 * 一次性复现脚本（不进测试清单）：把"建看板 → 加项 → 存盘 → 重新加载"这条链
 * 在 Node 层跑通，用来判断用户报的"退出重进就清空"到底断在 reducer/存储层
 * 还是更上面的渲染/IPC 层。
 *
 * 用法：CHILL_VIBE_DATA_DIR=<临时目录> node --import tsx scripts/repro-automation-board-persistence.ts
 */

import { ideReducer } from '../src/state.js'
import { createDefaultState } from '../shared/default-state.js'
import { AUTOMATIONBOARD_TOOL_MODEL } from '../shared/models.js'
import { loadState, saveState } from '../server/state-store.js'
import type { AppState } from '../shared/schema.js'

const dump = (label: string, state: AppState) => {
  const column = state.columns[0]!
  const cards = Object.entries(column.cards)
  const board = cards.find(([, card]) => card.model === AUTOMATIONBOARD_TOOL_MODEL)
  console.log(`\n=== ${label} ===`)
  console.log('  columns:', state.columns.length, '| workspacePath:', JSON.stringify(column.workspacePath))
  console.log('  cards:', cards.map(([id, c]) => `${id.slice(0, 8)}:${c.model}`).join(', '))
  console.log('  board card:', board ? board[0].slice(0, 8) : 'MISSING')
  console.log('  board items:', board ? JSON.stringify(board[1].automationBoard?.items?.map((i) => ({ cardId: i.cardId.slice(0, 8), lane: i.lane, req: i.requirement }))) : 'n/a')
  console.log('  automationBoards keys:', Object.keys(state.automationBoards ?? {}))
  const layout = JSON.stringify(column.layout)
  console.log('  layout:', layout.length > 300 ? layout.slice(0, 300) + '…' : layout)
}

const main = async () => {
  let state = createDefaultState()
  const column = state.columns[0]!
  // 看板的工作区级数据按 workspacePath 索引，空路径会走另一条分支。
  state = ideReducer(state, {
    type: 'updateColumn',
    columnId: column.id,
    patch: { workspacePath: 'D:\\Git\\chill-vibe' },
  } as never)

  const seedCardId = Object.keys(state.columns[0]!.cards)[0]!

  // 1. 把第一张卡切成自动化看板（= 空态工具栅格 / 模型选择器那条真实路径）
  state = ideReducer(state, {
    type: 'selectCardModel',
    columnId: column.id,
    cardId: seedCardId,
    provider: 'codex',
    model: AUTOMATIONBOARD_TOOL_MODEL,
  })
  dump('1. after selectCardModel -> board', state)

  // 2. 往待命道加一个需求项
  state = ideReducer(state, {
    type: 'createAutomationBoardItem',
    columnId: column.id,
    boardCardId: seedCardId,
    lane: 'standby',
    requirement: '复现用需求：把持久化修好',
  })
  dump('2. after createAutomationBoardItem', state)

  // 3. 存盘
  const saved = await saveState(state)
  dump('3. after saveState (returned)', saved)

  // 4. 重新加载（= 退出重进）
  const reloaded = await loadState()
  dump('4. after loadState (restart)', reloaded)

  const boardEntry = Object.entries(reloaded.columns[0]?.cards ?? {}).find(
    ([, card]) => card.model === AUTOMATIONBOARD_TOOL_MODEL,
  )
  const items = boardEntry?.[1].automationBoard?.items ?? []

  console.log('\n=== VERDICT ===')
  console.log('  board card survived:', Boolean(boardEntry))
  console.log('  items survived:', items.length)
  process.exitCode = boardEntry && items.length === 1 ? 0 : 1
}

void main()
