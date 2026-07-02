// Pane tab strip rescue for stale-compositor misrouted pointerdowns
// (investigation §3.6/F8): when a click physically lands on a tab button but
// Chromium's stale hit-test surface routes the event elsewhere, the strip has
// no native recovery — the tab can neither be activated nor closed. The
// decision core is pure so the misrouting rules stay behavior-testable.

export type RectLike = {
  left: number
  top: number
  right: number
  bottom: number
}

export type PaneTabRescueTabGeometry = {
  tabId: string
  rect: RectLike
  ownsEventTarget: boolean
  ownsElement: (element: Element) => boolean
  // True only when the element is inside this tab's close control. The close
  // span is pointer-events: none while invisible (inactive, unhovered tabs),
  // so elementFromPoint can only ever resolve to it when it is genuinely
  // interactive — geometry alone must NOT close (a click on an inactive tab's
  // right edge is an activation in native semantics, not a close).
  ownsCloseElement: (element: Element) => boolean
}

export type PaneTabRescueDecision =
  | { kind: 'activate'; tabId: string }
  | { kind: 'close'; tabId: string }
  | { kind: 'none' }

export const isPointerWithinRect = (point: { x: number; y: number }, rect: RectLike) =>
  point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom

// Rescue only when two independent facts agree the pointer belongs to a tab:
// the pointer coordinates fall inside its layout rect AND elementFromPoint
// (main-thread layout truth, immune to the stale compositor surface) resolves
// to a node owned by that same tab. Anything else — normal routing, a genuine
// overlay above the strip, or no layout hit at all — stays hands-off, so the
// rescue can never click through menus or double-fire native activations.
// Close-vs-activate follows the layout hit too, mirroring native semantics.
export const decideMisroutedTabPointerRescue = (
  point: { x: number; y: number },
  tabs: PaneTabRescueTabGeometry[],
  getHitAtPoint: () => Element | null,
): PaneTabRescueDecision => {
  const tab = tabs.find((candidate) => isPointerWithinRect(point, candidate.rect))
  if (!tab) {
    return { kind: 'none' }
  }

  if (tab.ownsEventTarget) {
    return { kind: 'none' }
  }

  const hit = getHitAtPoint()
  if (!hit || !tab.ownsElement(hit)) {
    return { kind: 'none' }
  }

  if (tab.ownsCloseElement(hit)) {
    return { kind: 'close', tabId: tab.tabId }
  }

  return { kind: 'activate', tabId: tab.tabId }
}
