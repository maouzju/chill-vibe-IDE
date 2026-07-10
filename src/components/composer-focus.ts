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

// Guard phase after focus settles (dump 2026-07-08T04-05: seven presses land
// on the textarea, focus settles each time — no exhaustion — yet ends on
// <body>). Whatever steals it fires no blur (unmount/remount and disable both
// do that), so blur-driven rescues stay deaf. The guard re-checks on these
// delays and pulls vacant focus back, capped so a hostile steal loop cannot
// fight forever; the reclaim count is the forensic signature of the silent
// steal.
export const composerFocusGuardDelaysMs = [300, 800, 1600]
export const composerFocusGuardMaxReclaims = 5

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
  // Opt-in guard phase: after focus settles, keep observing on these delays
  // and reclaim focus that goes vacant again. Omitted = legacy behavior.
  guardDelaysMs?: number[]
  // Fired on every guard reclaim — the count proves focus was silently stolen.
  onGuardReclaim?: () => void
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
  let guardTimerHandle: number | null = null
  let guardEntered = false
  let guardReclaims = 0

  const guardDelays = deps.guardDelaysMs ?? []

  const armGuard = (index: number) => {
    if (cancelled || index >= guardDelays.length) {
      guardTimerHandle = null
      return
    }
    guardTimerHandle = deps.schedule(() => {
      guardTimerHandle = null
      if (cancelled) {
        return
      }
      if (deps.isFocusSettled()) {
        armGuard(index + 1)
        return
      }
      if (deps.isFocusVacant()) {
        if (guardReclaims >= composerFocusGuardMaxReclaims) {
          return
        }
        guardReclaims += 1
        deps.focusTextarea()
        deps.onGuardReclaim?.()
        // Restart the guard window: focus was just stolen once, so it is the
        // most likely moment for it to be stolen again.
        armGuard(0)
        return
      }
      // A real element owns focus: the user moved on. Never fight that.
    }, guardDelays[index]!)
  }

  const enterGuard = () => {
    if (guardEntered || cancelled || guardDelays.length === 0) {
      return
    }
    guardEntered = true
    armGuard(0)
  }

  const shouldStop = () => {
    if (cancelled) {
      return true
    }
    if (deps.isFocusSettled()) {
      enterGuard()
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
      if (!cancelled) {
        if (deps.isFocusSettled()) {
          enterGuard()
        } else if (deps.isFocusVacant()) {
          deps.onExhausted?.()
        }
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
    if (guardTimerHandle !== null) {
      deps.cancel(guardTimerHandle)
      guardTimerHandle = null
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

// Forensic dump 2026-07-06T03-24-57: a pane holds several streaming session
// tabs; clicking a DIFFERENT tab to switch away lands focus on that tab's
// button, which sits in this pane's own .pane-tab-bar. The blur-reclaim then
// saw "own pane chrome ⇒ vacant" and yanked focus back into the still-active
// card's composer — the tab switch never took, so new sessions were unclickable.
// A tab button that would switch AWAY from the card holding the composer is a
// deliberate departure, not the composer-focus gesture. Only the card's own
// tab button and non-tab chrome (the "+" add button, tab-bar whitespace) may be
// treated as retryable vacancy.
export const isOwnPaneChromeReclaimable = (input: {
  focusIsInOwnPaneTabBar: boolean
  focusIsOnTabButton: boolean
  focusIsOnThisCardsTab: boolean
}): boolean => {
  if (!input.focusIsInOwnPaneTabBar) {
    return false
  }
  // Non-tab chrome (add button, strip whitespace) is always the focus gesture.
  if (!input.focusIsOnTabButton) {
    return true
  }
  // A tab button only counts as the focus gesture when it is THIS card's own
  // tab; any other tab button is a switch-away the user asked for.
  return input.focusIsOnThisCardsTab
}

// DOM adapter for isOwnPaneChromeReclaimable, shared by the three blur/verify
// reclaim closures in ChatCard. `element` is the current activeElement; `pane`
// is the .pane-view that owns this card's composer. The blur-reclaim only runs
// for the active card, so the pane's own `.pane-tab.is-active` button IS this
// card's tab — a non-active tab button in the same strip is the switch-away.
export const isReclaimableOwnPaneChrome = (
  element: Element,
  pane: Element | null,
): boolean => {
  if (pane === null || element.closest('.pane-view') !== pane) {
    return false
  }
  const tabBar = element.closest('.pane-tab-bar')
  if (tabBar === null) {
    return false
  }
  const tabButton = element.closest('.pane-tab')
  return isOwnPaneChromeReclaimable({
    focusIsInOwnPaneTabBar: true,
    focusIsOnTabButton: tabButton !== null,
    focusIsOnThisCardsTab: tabButton !== null && tabButton.classList.contains('is-active'),
  })
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

// Dump 2026-07-10T04-23-45 closed the remaining blur-reclaim gap: focusout
// fired from React's commit/removal path, the old textarea became disconnected,
// and the existing handler returned before it could focus the replacement
// composer mounted in the same pane. Only arm that replacement handoff for the
// exact stuck signature. Window-level focus loss (IME/system popup), a real
// destination, an inactive card, or an outside-pointer departure must never be
// fought.
export const shouldPreserveComposerFocusAfterVacantFocusOut = (state: {
  targetIsComposerTextarea: boolean
  cardIsActive: boolean
  cardUsesComposer: boolean
  blurCausedByPointerOutsideComposer: boolean
  documentStillFocused: boolean
  focusWentNowhere: boolean
}): boolean =>
  state.targetIsComposerTextarea &&
  state.cardIsActive &&
  state.cardUsesComposer &&
  !state.blurCausedByPointerOutsideComposer &&
  state.documentStillFocused &&
  state.focusWentNowhere

// React may mount the replacement composer just after the focusout/removal
// commit. Try once on the next frame and once shortly after; both attempts are
// idempotent and still re-check that focus remains vacant.
export const composerBlurFollowUpDelayMs = 80

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
  // Whether the event target sits anywhere inside the composer scope (the
  // textarea node OR a composer child like div.composer-input-row / a padding
  // overlay). classifyComposerPointerRouting returns 'expected' for such a
  // target, so the misroute rescue never fires for it — leaving a blind spot
  // when native focus also fails (dump 2026-07-07T08-30: focus stuck on <body>,
  // IME dead, all counters 0). Defaults to the targetIsTextarea value so older
  // callers keep their exact behavior. A press inside the rect whose target is
  // outside the composer is a genuine misroute the routing rescue owns.
  targetInsideComposer?: boolean
  isPrimaryButton: boolean
}): TextareaPressVerifyAction => {
  if (!input.pressInsideTextareaRect) {
    return 'cancel'
  }
  if (!input.isPrimaryButton) {
    return 'none'
  }
  const targetInsideComposer = input.targetInsideComposer ?? input.targetIsTextarea
  // Native click-to-focus provably fails even when the press lands squarely
  // inside the composer; arm the idempotent verify ladder whenever the target
  // is the textarea itself or any composer child. Only a target genuinely
  // outside the composer is left to the misroute repair+refocus path.
  return input.targetIsTextarea || targetInsideComposer ? 'arm' : 'none'
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
