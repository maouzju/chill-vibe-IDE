import type { LayoutNode } from '../../shared/schema'

import { findPaneForTab } from '../state'

type ReadStateCard = {
  id: string
  unread: boolean
}

const collectActiveTabIds = (layout: LayoutNode): string[] => {
  if (layout.type === 'pane') {
    return layout.activeTabId ? [layout.activeTabId] : []
  }

  return layout.children.flatMap((child) => collectActiveTabIds(child))
}

export const shouldMarkCardUnreadOnStreamDone = (
  layout: LayoutNode,
  cardId: string,
  boardVisible: boolean,
) => {
  if (!boardVisible) {
    return true
  }

  const pane = findPaneForTab(layout, cardId)
  return pane?.activeTabId !== cardId
}

export const getAutoReadCardId = (
  activeCard: ReadStateCard | undefined,
  activeTabMounted: boolean,
): string | null => {
  if (!activeTabMounted || !activeCard?.unread) {
    return null
  }

  return activeCard.id
}

export const getAutoReadCardIdsForVisiblePanes = (
  layout: LayoutNode,
  cards: Record<string, ReadStateCard | undefined>,
  boardVisible: boolean,
): string[] => {
  if (!boardVisible) {
    return []
  }

  const unreadCardIds = new Set<string>()

  for (const activeTabId of collectActiveTabIds(layout)) {
    const activeCard = cards[activeTabId]
    if (activeCard?.unread) {
      unreadCardIds.add(activeCard.id)
    }
  }

  return [...unreadCardIds]
}
