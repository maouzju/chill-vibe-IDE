// Board-level wheel capture routing. The board intercepts vertical wheel
// events in the capture phase to drive card transcript / app-shell scrolling;
// this module decides whether a given wheel event should be handled by the
// board, forwarded to the app scroll host, or left to the element under the
// pointer. Kept DOM-agnostic (structural element interface + injectable style
// resolver) so the routing rules stay unit-testable without a browser.

export const overflowScrollablePattern = /(auto|scroll|overlay)/

export interface BoardWheelElement {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scrollWidth: number
  clientWidth: number
  parentElement: BoardWheelElement | null
  classList: { contains(token: string): boolean }
  closest(selectors: string): unknown
  querySelector(selectors: string): unknown
}

export type WheelStyleResolver = (node: BoardWheelElement) => { overflowY: string }

const defaultStyleResolver: WheelStyleResolver = (node) =>
  getComputedStyle(node as unknown as Element)

const isWheelElement = (value: unknown): value is BoardWheelElement => {
  if (typeof HTMLElement !== 'undefined') {
    return value instanceof HTMLElement
  }

  return (
    typeof value === 'object' &&
    value !== null &&
    'classList' in value &&
    'scrollWidth' in value &&
    'scrollHeight' in value
  )
}

export function canConsumeVerticalWheel(
  node: BoardWheelElement,
  deltaY: number,
  resolveStyle: WheelStyleResolver = defaultStyleResolver,
) {
  const style = resolveStyle(node)
  if (!overflowScrollablePattern.test(style.overflowY)) {
    return false
  }

  const maxScrollTop = node.scrollHeight - node.clientHeight
  if (maxScrollTop <= 1) {
    return false
  }

  if (deltaY < 0) {
    return node.scrollTop > 1
  }

  if (deltaY > 0) {
    return node.scrollTop < maxScrollTop - 1
  }

  return false
}

export function getVerticalScrollLimit(node: BoardWheelElement) {
  return node.scrollHeight - node.clientHeight
}

export function isCardVerticalScrollRegion(
  node: BoardWheelElement,
  resolveStyle: WheelStyleResolver = defaultStyleResolver,
) {
  if (!node.closest('.card-shell')) {
    return false
  }

  const style = resolveStyle(node)
  if (!overflowScrollablePattern.test(style.overflowY)) {
    return false
  }

  return getVerticalScrollLimit(node) > 1
}

// The pane tab strip converts vertical wheel deltas into horizontal tab
// scrolling (PaneView handles that in the bubble phase). While the strip is
// horizontally overflowing, the board capture handler must not claim the same
// wheel event, or vertical page scrolling fights the tab scroll whenever the
// app shell itself is scrollable (e.g. a very short window).
function resolveHorizontalWheelStrip(node: BoardWheelElement): BoardWheelElement | null {
  if (node.classList.contains('pane-tab-strip')) {
    return node
  }

  if (node.classList.contains('pane-tab-bar')) {
    const strip = node.querySelector('.pane-tab-strip')
    return isWheelElement(strip) ? strip : null
  }

  return null
}

export function consumesHorizontalWheel(node: BoardWheelElement) {
  const strip = resolveHorizontalWheelStrip(node)
  return strip !== null && strip.scrollWidth - strip.clientWidth > 1
}

export function getBoardWheelPath(
  target: unknown,
  board: BoardWheelElement,
  composedPath: readonly unknown[] | null,
) {
  if (composedPath && composedPath.length > 0) {
    const path: BoardWheelElement[] = []

    for (const entry of composedPath) {
      if (!isWheelElement(entry)) {
        continue
      }
      if (entry === board) {
        break
      }
      path.push(entry)
    }

    if (path.length > 0) {
      return path
    }
  }

  const path: BoardWheelElement[] = []
  let current = isWheelElement(target) ? target : null

  while (current && current !== board) {
    path.push(current)
    current = current.parentElement
  }

  return path
}

export function getBoardWheelDisposition(
  target: unknown,
  board: BoardWheelElement,
  deltaY: number,
  composedPath: readonly unknown[] | null = null,
  resolveStyle: WheelStyleResolver = defaultStyleResolver,
) {
  const path = getBoardWheelPath(target, board, composedPath)

  for (const current of path) {
    if (consumesHorizontalWheel(current)) {
      return { type: 'pass' } as const
    }

    if (isCardVerticalScrollRegion(current, resolveStyle)) {
      if (deltaY > 0) {
        if (canConsumeVerticalWheel(current, deltaY, resolveStyle)) {
          return { type: 'scroll-card', node: current } as const
        }

        return { type: 'trap' } as const
      }

      return { type: 'pass' } as const
    }

    if (canConsumeVerticalWheel(current, deltaY, resolveStyle)) {
      return { type: 'pass' } as const
    }
  }

  return { type: 'forward' } as const
}
