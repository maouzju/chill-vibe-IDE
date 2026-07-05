// Composer focus plumbing shared by ChatCard (verify+retry focus attempts)
// and App/PaneView (cross-tree focus requests for keyboard tab shortcuts).
// See docs/specs/composer-focus-loss/investigation.md §4.2/§4.3.

export const composerFocusRetryDelaysMs = [50, 150, 400]

export const composerFocusRequestEventName = 'chill-vibe:composer-focus-request'

export type ComposerFocusRequestDetail = {
  paneId: string
}

export const dispatchComposerFocusRequest = (paneId: string) => {
  window.dispatchEvent(
    new CustomEvent<ComposerFocusRequestDetail>(composerFocusRequestEventName, {
      detail: { paneId },
    }),
  )
}

// A composer-focus request carries only a counter, never a tabId. When the
// rescue/add path hands a tabId whose card is not yet in this render's cards
// map (the one-frame window after a new tab mounts), the request must STILL be
// emitted so the freshly-mounted card can start its retry ladder from the bump.
// Dropping it there is the forensic new-tab deadlock: focus never leaves <body>,
// and because it never entered the composer there is no blur to wake the
// blur-reclaim self-heal either. Suppress the bump only when the card is present
// AND is a genuine tool card with no composer — never for the transient miss.
export type ComposerFocusRequestDecision = 'bump' | 'suppress'

export const decideComposerFocusRequest = (input: {
  cardPresent: boolean
  cardUsesComposer: boolean
}): ComposerFocusRequestDecision =>
  !input.cardPresent || input.cardUsesComposer ? 'bump' : 'suppress'

export type ComposerFocusAttemptDeps = {
  focusTextarea: () => boolean
  isFocusSettled: () => boolean
  isFocusVacant: () => boolean
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  schedule: (callback: () => void, delayMs: number) => number
  cancel: (handle: number) => void
  // Fired once when the whole ladder ran and focus is still vacant — the
  // stuck-pane signature (every focus() call was issued but none landed).
  // Never fired when focus settled, moved to a real element, or on cancel.
  onExhausted?: () => void
}

// A composer focus request must survive a dropped requestAnimationFrame
// (backgroundThrottling stalls frames entirely) and a focus call that lands
// while the textarea is momentarily unfocusable — but it must never wrestle
// focus away from an element the user deliberately moved to. The rules:
//   - the first attempt is the request itself and runs unconditionally;
//   - a retry only fires while focus is vacant (body/null) after our attempt;
//   - focus settling on the textarea, or any other real element taking it,
//     ends the attempt immediately.
export const startComposerFocusAttempt = (deps: ComposerFocusAttemptDeps): (() => void) => {
  let cancelled = false
  let attempted = false
  let timerHandle: number | null = null

  const shouldStop = () => {
    if (cancelled || deps.isFocusSettled()) {
      return true
    }
    return attempted && !deps.isFocusVacant()
  }

  const runAttempt = () => {
    if (shouldStop()) {
      return
    }
    deps.focusTextarea()
    attempted = true
  }

  const armRetry = (index: number) => {
    if (index >= composerFocusRetryDelaysMs.length) {
      timerHandle = null
      if (!cancelled && !deps.isFocusSettled() && deps.isFocusVacant()) {
        deps.onExhausted?.()
      }
      return
    }
    timerHandle = deps.schedule(() => {
      timerHandle = null
      if (shouldStop()) {
        return
      }
      deps.focusTextarea()
      attempted = true
      armRetry(index + 1)
    }, composerFocusRetryDelaysMs[index]!)
  }

  const frameHandle = deps.requestFrame(runAttempt)
  // The retry ladder is armed independently of the frame so a stalled rAF
  // cannot strand the request.
  armRetry(0)

  return () => {
    cancelled = true
    deps.cancelFrame(frameHandle)
    if (timerHandle !== null) {
      deps.cancel(timerHandle)
      timerHandle = null
    }
  }
}

// Focus parked on the pane's own chrome (tab button, "+" button) is not a
// deliberate user placement — clicking those IS the composer-focus gesture
// (investigation §4.1), so retries may run over it. Chrome belonging to any
// other pane stays off-limits: the user moved on.
export const isComposerFocusEffectivelyVacant = (
  activeElement: Element | null,
  bodyElement: Element | null,
  isOwnPaneChrome: (element: Element) => boolean,
) => {
  if (activeElement === null || activeElement === bodyElement) {
    return true
  }
  return isOwnPaneChrome(activeElement)
}

// The retry ladder above is request-driven: it only runs when a structural
// action (tab switch/add, keyboard shortcut) bumps composerFocusRequest. That
// leaves a gap the forensic dump caught red-handed — the user clicks the
// textarea, the click lands (agree=true), yet native focus falls to <body>
// with no structural action to wake the ladder, so the composer looks dead.
// This gate closes it: on textarea blur, if focus went vacant (body/own
// chrome) while this card should still own the composer, request refocus. A
// blur to any real element elsewhere is a deliberate move and must be left
// alone — refocusing there would trap the user in the input.
//
// A pointer press outside the composer is also a deliberate move even though
// it leaves focus vacant (message text is not focusable): reclaiming there
// moves the document selection into the textarea and kills a drag-selection
// of conversation text mid-gesture. Vacancy only counts as the stuck
// signature when no outside press explains it.
export const shouldRefocusAfterComposerBlur = (state: {
  focusBecameVacant: boolean
  cardHoldsFocus: boolean
  blurCausedByPointerOutsideComposer: boolean
}): boolean =>
  state.focusBecameVacant && state.cardHoldsFocus && !state.blurCausedByPointerOutsideComposer

// The blur fired by an outside press follows the pointerdown within the same
// gesture (a handful of ms); the window only needs to absorb event-loop lag.
export const composerBlurOutsidePressWindowMs = 500

// Forensic dump 2026-07-05T14-58-02 (v0.17.10): a pointerdown lands ON the
// textarea (agree=true, disabled=false), yet native click-to-focus never
// lands — activeElement stays <body>. That press sits in the blind spot of
// every rescue above: the capture handler trusted "native focus handles the
// normal case", no blur ever fires (focus never entered the composer), and no
// structural action bumps the request counter — all three counters read 0.
// So a primary press that directly hits the textarea must arm the verify
// ladder itself. A press outside the rect is the departure gesture (often a
// drag-selection start) and must disarm a pending verification instead, or a
// late retry would reclaim focus mid-drag. A press inside the rect that names
// another element is the misroute case, which already repairs and refocuses.
export type TextareaPressVerifyAction = 'arm' | 'cancel' | 'none'

export const decideTextareaPressFocusVerification = (input: {
  pressInsideTextareaRect: boolean
  targetIsTextarea: boolean
  isPrimaryButton: boolean
}): TextareaPressVerifyAction => {
  if (!input.pressInsideTextareaRect) {
    return 'cancel'
  }
  if (!input.isPrimaryButton) {
    return 'none'
  }
  return input.targetIsTextarea ? 'arm' : 'none'
}

// A card-level layer rebuild that ran recently and demonstrably did not stop
// the misrouting is the signal to widen the rebuild to the pane panel — the
// lightweight equivalent of the tab switch that historically cleared stale
// compositor surfaces (investigation §3.5/F9).
export const hitTestRepairEscalationWindowMs = 5000

export type HitTestRepairScope = 'skip' | 'card' | 'card-and-panel'

export const decideHitTestRepairScope = (
  nowMs: number,
  lastRepairAtMs: number,
  throttleMs: number,
  escalationWindowMs: number,
): HitTestRepairScope => {
  const elapsed = nowMs - lastRepairAtMs
  if (elapsed < throttleMs) {
    return 'skip'
  }
  if (elapsed < escalationWindowMs) {
    return 'card-and-panel'
  }
  return 'card'
}

// A stale-routed event can falsely name a long-lived ignored surface (menu,
// dialog, tool panel) as its target even though nothing covers the pointer.
// Only skip rescue when layout truth confirms an ignored surface really owns
// the pointer position; a null hit keeps the old conservative skip. The hit
// is resolved lazily so the common not-ignored path never pays for it.
export const shouldSkipComposerRescueForIgnoredSurface = (
  targetIsIgnored: boolean,
  getHitAtPoint: () => Element | null,
  isIgnoredSurface: (element: Element) => boolean,
) => {
  if (!targetIsIgnored) {
    return false
  }
  const hit = getHitAtPoint()
  if (!hit) {
    return true
  }
  return isIgnoredSurface(hit)
}
