import type { DragEvent } from 'react'

export type Placement = 'before' | 'after'

export type DragPayload =
  | {
      type: 'column'
      columnId: string
    }
  | {
      type: 'file-tree-entry'
      workspacePath: string
      relativePath: string
      isDirectory: boolean
    }
  | {
      type: 'tab'
      columnId: string
      paneId: string
      tabId: string
    }

const dragMime = 'application/x-chill-vibe'
let activeDragPayload: DragPayload | null = null

export const writeDragPayload = <T extends HTMLElement>(
  event: DragEvent<T>,
  payload: DragPayload,
) => {
  activeDragPayload = payload
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(dragMime, JSON.stringify(payload))
  event.dataTransfer.setData('text/plain', JSON.stringify(payload))
}

export const readDragPayload = <T extends HTMLElement>(event: DragEvent<T>) => {
  if (activeDragPayload) {
    return activeDragPayload
  }

  const raw = event.dataTransfer.getData(dragMime) || event.dataTransfer.getData('text/plain')

  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload>

    if (parsed.type === 'column' && typeof parsed.columnId === 'string') {
      return {
        type: 'column',
        columnId: parsed.columnId,
      } satisfies DragPayload
    }

    if (
      parsed.type === 'file-tree-entry' &&
      typeof parsed.workspacePath === 'string' &&
      typeof parsed.relativePath === 'string' &&
      typeof parsed.isDirectory === 'boolean'
    ) {
      return {
        type: 'file-tree-entry',
        workspacePath: parsed.workspacePath,
        relativePath: parsed.relativePath,
        isDirectory: parsed.isDirectory,
      } satisfies DragPayload
    }

    if (
      parsed.type === 'tab' &&
      typeof parsed.columnId === 'string' &&
      typeof parsed.paneId === 'string' &&
      typeof parsed.tabId === 'string'
    ) {
      return {
        type: 'tab',
        columnId: parsed.columnId,
        paneId: parsed.paneId,
        tabId: parsed.tabId,
      } satisfies DragPayload
    }
  } catch {
    return null
  }

  return null
}

export const clearDragPayload = () => {
  activeDragPayload = null
}
