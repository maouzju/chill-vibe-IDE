import type { BoardColumn, ChatCard, PaneNode } from '../../shared/schema'
import { getLayoutTabIds } from '../../shared/default-state'
import type { LayoutNode } from '../../shared/schema'
import type { IdeAction } from '../state'

export type SubagentTabSummary = Pick<ChatCard, 'id' | 'title'>

export const findChildCards = (
  columns: readonly BoardColumn[],
  parentCardId: string,
): SubagentTabSummary[] =>
  columns.flatMap((column) =>
    Object.values(column.cards)
      .filter((card) => card.parentCardId === parentCardId)
      .map(({ id, title }) => ({ id, title })),
  )

export const findCardColumnAndPane = (
  columns: readonly BoardColumn[],
  cardId: string,
): { column: BoardColumn; pane: PaneNode } | null => {
  for (const column of columns) {
    const pane = findPaneForTab(column.layout, cardId)
    if (pane) {
      return { column, pane }
    }
  }
  return null
}

export const getSubagentNavigationActions = (
  columns: readonly BoardColumn[],
  cardId: string,
): IdeAction[] => {
  const target = findCardColumnAndPane(columns, cardId)
  if (!target) return []

  const actions: IdeAction[] = []
  if (target.column.docked === true) {
    actions.push({ type: 'undockColumn', columnId: target.column.id })
  }
  actions.push({
    type: 'setActiveTab',
    columnId: target.column.id,
    paneId: target.pane.id,
    tabId: cardId,
  })
  return actions
}

const findPaneForTab = (layout: LayoutNode, tabId: string): PaneNode | null => {
  if (layout.type === 'pane') {
    return layout.tabs.includes(tabId) ? layout : null
  }
  for (const child of layout.children) {
    const pane = findPaneForTab(child, tabId)
    if (pane) return pane
  }
  return null
}

export const sameColumnSourceCards = (
  previous: readonly BoardColumn[],
  next: readonly BoardColumn[],
  columnId: string,
): boolean => {
  const previousColumn = previous.find((column) => column.id === columnId)
  const nextColumn = next.find((column) => column.id === columnId)
  if (!previousColumn || !nextColumn) {
    return previousColumn === nextColumn
  }

  const tabIds = new Set([
    ...getLayoutTabIds(previousColumn.layout),
    ...getLayoutTabIds(nextColumn.layout),
  ])
  const parentIds = new Set<string>()
  for (const tabId of tabIds) {
    const previousCard = previousColumn.cards[tabId]
    const nextCard = nextColumn.cards[tabId]
    if (previousCard) parentIds.add(tabId)
    if (nextCard) parentIds.add(tabId)
    if (previousCard?.parentCardId) parentIds.add(previousCard.parentCardId)
    if (nextCard?.parentCardId) parentIds.add(nextCard.parentCardId)
  }
  if (parentIds.size === 0) {
    return true
  }

  for (const parentId of parentIds) {
    const previousChildren = findChildCards(previous, parentId)
    const nextChildren = findChildCards(next, parentId)
    if (
      previousChildren.length !== nextChildren.length ||
      previousChildren.some((child, index) => {
        const nextChild = nextChildren[index]
        return child.id !== nextChild?.id || child.title !== nextChild.title
      })
    ) {
      return false
    }
  }
  return true
}
