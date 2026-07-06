// Pane tab strip wheel scrolling, misroute-proof (companion to
// pane-tab-rescue.ts): the strip converts vertical wheel deltas into
// horizontal tab scrolling, but a React onWheel handler only fires when the
// event target bubbles through the strip — and a stale compositor hit-test
// surface can route the wheel to an unrelated subtree, leaving the tab bar
// impossible to scroll at all. The decision core is pure and never looks at
// event.target: pointer geometry plus main-thread layout truth
// (elementFromPoint) decide, exactly like the pointerdown rescue.

import { isPointerWithinRect, type RectLike } from './pane-tab-rescue'

export type TabStripWheelMetrics = {
  rect: RectLike
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

export type TabStripWheelDecision =
  | { kind: 'scroll'; nextScrollLeft: number }
  | { kind: 'none' }

// Scroll only when three independent facts agree: the pointer coordinates
// fall inside the tab bar rect, the strip actually overflows, and layout
// truth confirms nothing else (a dropdown, a dialog) owns that point. The
// layout check is what keeps this from stealing wheel events that belong to a
// genuine overlay above the strip, while still working when the compositor's
// stale hit-test surface misroutes the event target.
export const decideTabStripWheelScroll = (
  point: { x: number; y: number },
  delta: { deltaX: number; deltaY: number },
  strip: TabStripWheelMetrics,
  stripOwnsLayoutHit: () => boolean,
): TabStripWheelDecision => {
  if (!isPointerWithinRect(point, strip.rect)) {
    return { kind: 'none' }
  }

  const maxScrollLeft = strip.scrollWidth - strip.clientWidth
  if (maxScrollLeft <= 1) {
    return { kind: 'none' }
  }

  const dominantDelta =
    Math.abs(delta.deltaX) > Math.abs(delta.deltaY) ? delta.deltaX : delta.deltaY
  if (dominantDelta === 0) {
    return { kind: 'none' }
  }

  if (!stripOwnsLayoutHit()) {
    return { kind: 'none' }
  }

  const nextScrollLeft = Math.min(Math.max(strip.scrollLeft + dominantDelta, 0), maxScrollLeft)
  if (Math.abs(nextScrollLeft - strip.scrollLeft) < 1) {
    return { kind: 'none' }
  }

  return { kind: 'scroll', nextScrollLeft }
}
