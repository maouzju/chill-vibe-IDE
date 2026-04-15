import { createPane, getOrderedColumnTabIds } from '../shared/default-state.ts'
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

export const createPlaywrightState = (state: StateFixture): AppState =>
  appStateSchema.parse({
    ...state,
    settings: state.settings ?? {},
    sessionHistory: state.sessionHistory ?? [],
    columns: Array.isArray(state.columns) ? state.columns.map(normalizeColumn) : [],
  })

export const getColumnCardIds = (state: AppState, columnIndex = 0) => {
  const column = state.columns[columnIndex]
  return column ? getOrderedColumnTabIds(column) : []
}
