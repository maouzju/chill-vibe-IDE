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

// While a native drag is in flight, Chromium keeps firing drag/dragover
// somewhere in the document about every 350ms even when the pointer is
// still. Silence longer than this means the drag session is really dead
// (a lost dragend/drop — pitfall 132), not just hovering a non-drop area.
const dragActivityStaleMs = 800
let lastDragActivityAt = Number.NEGATIVE_INFINITY

export const markDragActivity = (now: number) => {
  lastDragActivityAt = now
}

const handleDocumentDragActivity = () => {
  markDragActivity(Date.now())
}

let dragActivityTrackingAttached = false

const attachDragActivityTracking = () => {
  if (dragActivityTrackingAttached || typeof document === 'undefined') {
    return
  }

  // Document-level capture so activity is seen even when stale hit-testing
  // misroutes the event target (pitfall 129B) or the pointer sits over
  // chrome that has no drop handlers of its own.
  document.addEventListener('drag', handleDocumentDragActivity, true)
  document.addEventListener('dragover', handleDocumentDragActivity, true)
  dragActivityTrackingAttached = true
}

const detachDragActivityTracking = () => {
  if (!dragActivityTrackingAttached || typeof document === 'undefined') {
    return
  }

  document.removeEventListener('drag', handleDocumentDragActivity, true)
  document.removeEventListener('dragover', handleDocumentDragActivity, true)
  dragActivityTrackingAttached = false
}

export const peekDragPayload = () => activeDragPayload

/**
 * Drop-hint watchdogs must not kill the payload of a drag that is still in
 * flight — during a native drag, dragover handlers cannot read dataTransfer,
 * so a cleared payload silently disables every remaining drop target.
 * Returns true when no payload remains (already gone or released here).
 */
export const releaseDragPayloadIfStale = (now: number): boolean => {
  if (activeDragPayload === null) {
    return true
  }

  if (now - lastDragActivityAt < dragActivityStaleMs) {
    return false
  }

  clearDragPayload()
  return true
}

export const writeDragPayload = <T extends HTMLElement>(
  event: DragEvent<T>,
  payload: DragPayload,
) => {
  activeDragPayload = payload
  markDragActivity(Date.now())
  attachDragActivityTracking()
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
  detachDragActivityTracking()
}
