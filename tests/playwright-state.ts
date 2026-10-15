import { createPane, getOrderedColumnTabIds } from '../shared/default-state.ts'
import { listModelUpgradeKeys } from '../shared/models.ts'
import { appStateSchema, type AppState, type BoardColumn, type ChatCard, type LayoutNode } from '../shared/schema.ts'

type ColumnFixture = Omit<BoardColumn, 'cards' | 'layout'> & {
  cards?: Record<string, ChatCard> | ChatCard[]
  layout?: LayoutNode
}

type StateFixture = Partial<Omit<AppState, 'columns'>> & {
  columns?: ColumnFixture[]
}

const normalizeColumn = (column: ColumnFixture): BoardColumn => {
  const cards = Array.isArray(column.cards)
    ? Object.fromEntries(column.cards.map((card) => [card.id, card]))
    : (column.cards ?? {})

  const layout =
    column.layout ??
    createPane(
      Array.isArray(column.cards) ? column.cards.map((card) => card.id) : Object.keys(cards),
      Array.isArray(column.cards) ? column.cards[0]?.id ?? '' : Object.keys(cards)[0] ?? '',
      `${column.id}-pane`,
    )

  return {
    ...column,
    cards,
    layout,
  }
}

// 夹具默认视为「已看过默认模型换代提示」：否则缺字段会被当成老存档，在每条用例里弹窗盖住点击。
// 要测弹窗本身的用例显式传 acknowledgedModelUpgrades: []。
export const createPlaywrightState = (state: StateFixture): AppState =>
  appStateSchema.parse({
    ...state,
    settings: { acknowledgedModelUpgrades: listModelUpgradeKeys(), ...(state.settings ?? {}) },
    sessionHistory: state.sessionHistory ?? [],
    columns: Array.isArray(state.columns) ? state.columns.map(normalizeColumn) : [],
  })

export const getColumnCardIds = (state: AppState, columnIndex = 0) => {
  const column = state.columns[columnIndex]
  return column ? getOrderedColumnTabIds(column) : []
}
