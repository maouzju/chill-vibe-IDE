import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  composerFocusRequestEventName,
  composerFocusRetryDelaysMs,
  decideHitTestRepairScope,
  hitTestRepairEscalationWindowMs,
  isComposerFocusEffectivelyVacant,
  shouldRefocusAfterComposerBlur,
  startComposerFocusAttempt,
  type ComposerFocusAttemptDeps,
} from '../src/components/composer-focus'

type FakeEnv = {
  deps: ComposerFocusAttemptDeps
  runFrame: () => void
  runNextTimer: () => number | null
  pendingTimerDelays: () => number[]
  focusCalls: () => number
  cancelledFrames: () => number
  cancelledTimers: () => number
  setActiveElement: (state: 'settled' | 'vacant' | 'elsewhere') => void
}

const createFakeEnv = (options?: {
  focusSucceeds?: boolean
  onExhausted?: () => void
}): FakeEnv => {
  let focusCount = 0
  let cancelledFrameCount = 0
  let cancelledTimerCount = 0
  let activeState: 'settled' | 'vacant' | 'elsewhere' = 'vacant'
  const focusSucceeds = options?.focusSucceeds ?? true

  let frameCallback: (() => void) | null = null
  const timers = new Map<number, { callback: () => void; delayMs: number }>()
  let nextHandle = 1

  const deps: ComposerFocusAttemptDeps = {
    focusTextarea: () => {
      focusCount += 1
      if (focusSucceeds) {
        activeState = 'settled'
      }
      return focusSucceeds
    },
    isFocusSettled: () => activeState === 'settled',
    isFocusVacant: () => activeState === 'vacant',
    requestFrame: (callback) => {
      frameCallback = callback
      return nextHandle++
    },
    cancelFrame: () => {
      cancelledFrameCount += 1
      frameCallback = null
    },
    schedule: (callback, delayMs) => {
      const handle = nextHandle++
      timers.set(handle, { callback, delayMs })
      return handle
    },
    cancel: (handle) => {
      if (timers.delete(handle)) {
        cancelledTimerCount += 1
      }
    },
    onExhausted: options?.onExhausted,
  }

  return {
    deps,
    runFrame: () => {
      const callback = frameCallback
      frameCallback = null
      callback?.()
    },
    runNextTimer: () => {
      const first = [...timers.entries()][0]
      if (!first) {
        return null
      }
      timers.delete(first[0])
      first[1].callback()
      return first[1].delayMs
    },
    pendingTimerDelays: () => [...timers.values()].map((entry) => entry.delayMs),
    focusCalls: () => focusCount,
    cancelledFrames: () => cancelledFrameCount,
    cancelledTimers: () => cancelledTimerCount,
    setActiveElement: (state) => {
      activeState = state
    },
  }
}

test('composer focus attempt focuses on the first frame and stops once focus settles', () => {
  const env = createFakeEnv()
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  assert.equal(env.focusCalls(), 1, 'first frame should issue the focus call')

  // The retry ladder must already be armed independently of the frame, but
  // every later tick sees settled focus and must not focus again.
  let guard = 0
  while (env.runNextTimer() !== null && guard < 10) {
    guard += 1
  }
  assert.equal(env.focusCalls(), 1, 'settled focus must not be re-issued by retries')
})

test('composer focus attempt still focuses via the retry ladder when the frame never fires', () => {
  // backgroundThrottling can stall requestAnimationFrame entirely; the retry
  // ladder must be armed at start, not from inside the frame callback.
  const env = createFakeEnv()
  startComposerFocusAttempt(env.deps)

  assert.ok(
    env.pendingTimerDelays().length > 0,
    'a retry timer must be scheduled at start so a stalled rAF cannot strand the request',
  )

  const delay = env.runNextTimer()
  assert.equal(delay, composerFocusRetryDelaysMs[0])
  assert.equal(env.focusCalls(), 1, 'retry tick should issue the focus when the frame was lost')
})

test('composer focus attempt retries while focus stays vacant and stops after the ladder is exhausted', () => {
  const env = createFakeEnv({ focusSucceeds: false })
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  let guard = 0
  while (env.runNextTimer() !== null && guard < 20) {
    guard += 1
  }

  assert.equal(
    env.focusCalls(),
    1 + composerFocusRetryDelaysMs.length,
    'vacant focus should be retried once per ladder step and then give up',
  )
})

test('composer focus attempt yields when another real element takes focus after the first try', () => {
  const env = createFakeEnv()
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  assert.equal(env.focusCalls(), 1)

  // The user clicked something else (or a dialog opened) inside the retry
  // window: focus is neither on the textarea nor vacant. Never steal it back.
  env.setActiveElement('elsewhere')
  let guard = 0
  while (env.runNextTimer() !== null && guard < 10) {
    guard += 1
  }
  assert.equal(env.focusCalls(), 1, 'focus owned by another element must not be stolen')
})

test('composer focus attempt issues the first try even when focus starts on another element', () => {
  // Clicking a tab can leave focus on the tab button; the explicit focus
  // request must still move it to the composer on the first attempt.
  const env = createFakeEnv()
  env.setActiveElement('elsewhere')
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  assert.equal(env.focusCalls(), 1, 'the first attempt is the request itself and must run unconditionally')
})

test('composer focus attempt cancel clears the pending frame and timers', () => {
  const env = createFakeEnv()
  const cancel = startComposerFocusAttempt(env.deps)

  cancel()
  assert.ok(env.cancelledFrames() >= 1, 'cancel must release the pending frame')
  assert.ok(env.cancelledTimers() >= 1, 'cancel must release the armed retry timer')

  env.runFrame()
  assert.equal(env.focusCalls(), 0, 'a cancelled attempt must not focus')
})

test('composer focus request event name matches the app-wide custom event convention', () => {
  assert.match(composerFocusRequestEventName, /^chill-vibe:/)
})

// ── F9: exhaustion reporting (investigation §6 second tier) ────────────────

test('composer focus attempt reports exhaustion once when the ladder ends with focus still vacant', () => {
  let exhausted = 0
  const env = createFakeEnv({ focusSucceeds: false, onExhausted: () => (exhausted += 1) })
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  let guard = 0
  while (env.runNextTimer() !== null && guard < 20) {
    guard += 1
  }

  assert.equal(exhausted, 1, 'a fully failed ladder with vacant focus is the stuck-pane signature and must be reported')
})

test('composer focus attempt does not report exhaustion when focus settles', () => {
  let exhausted = 0
  const env = createFakeEnv({ onExhausted: () => (exhausted += 1) })
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  let guard = 0
  while (env.runNextTimer() !== null && guard < 20) {
    guard += 1
  }

  assert.equal(exhausted, 0)
})

test('composer focus attempt does not report exhaustion when another element owns focus', () => {
  let exhausted = 0
  const env = createFakeEnv({ focusSucceeds: false, onExhausted: () => (exhausted += 1) })
  startComposerFocusAttempt(env.deps)

  env.runFrame()
  env.setActiveElement('elsewhere')
  let guard = 0
  while (env.runNextTimer() !== null && guard < 20) {
    guard += 1
  }

  assert.equal(exhausted, 0, 'focus deliberately placed elsewhere is not a failure and must not escalate')
})

test('a cancelled composer focus attempt never reports exhaustion', () => {
  let exhausted = 0
  const env = createFakeEnv({ focusSucceeds: false, onExhausted: () => (exhausted += 1) })
  const cancel = startComposerFocusAttempt(env.deps)

  env.runFrame()
  cancel()
  let guard = 0
  while (env.runNextTimer() !== null && guard < 20) {
    guard += 1
  }

  assert.equal(exhausted, 0)
})

// ── F9: hit-test repair scope escalation ───────────────────────────────────

test('repair scope inside the throttle window is skipped', () => {
  assert.equal(decideHitTestRepairScope(2000, 1000, 1500, 5000), 'skip')
})

test('a repeated repair shortly after the last one escalates to the pane panel', () => {
  // The card-level rebuild ran recently and the surface is still misrouting:
  // card scope demonstrably did not clear it, so widen to the pane panel.
  assert.equal(decideHitTestRepairScope(4000, 1000, 1500, 5000), 'card-and-panel')
})

test('a long-quiet card repairs at card level only', () => {
  assert.equal(decideHitTestRepairScope(60_000, 1000, 1500, 5000), 'card')
})

test('the first-ever repair stays at card level', () => {
  assert.equal(decideHitTestRepairScope(100_000, 0, 1500, 5000), 'card')
})

test('the escalation window is meaningfully wider than the repair throttle', () => {
  assert.ok(hitTestRepairEscalationWindowMs > 1500)
})

// ── F9: effective vacancy (own pane chrome does not block retries) ─────────

const chromeElement = { __chrome: true } as unknown as Element
const foreignElement = { __foreign: true } as unknown as Element
const bodyElement = { __body: true } as unknown as Element

test('effective vacancy: null and body are vacant', () => {
  assert.equal(isComposerFocusEffectivelyVacant(null, bodyElement, () => false), true)
  assert.equal(isComposerFocusEffectivelyVacant(bodyElement, bodyElement, () => false), true)
})

test('effective vacancy: focus resting on this pane\'s own chrome is vacant (the tab click IS the focus request)', () => {
  assert.equal(
    isComposerFocusEffectivelyVacant(chromeElement, bodyElement, (element) => element === chromeElement),
    true,
  )
})

test('effective vacancy: focus on any other element is not vacant', () => {
  assert.equal(
    isComposerFocusEffectivelyVacant(foreignElement, bodyElement, (element) => element === chromeElement),
    false,
  )
})

const chatCardSourcePath = path.join(process.cwd(), 'src', 'components', 'ChatCard.tsx')
const paneViewSourcePath = path.join(process.cwd(), 'src', 'components', 'PaneView.tsx')
const appSourcePath = path.join(process.cwd(), 'src', 'App.tsx')

test('composerFocusRequest effect drives the shared verify+retry helper instead of a bare one-shot rAF', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  const effectBlock =
    source.match(/if \(!usesPaneChrome \|\| isToolCard \|\| composerFocusRequest === 0\) \{[\s\S]*?\n {2}\}, \[card\.id, composerFocusRequest/)?.[0] ?? ''

  assert.ok(effectBlock, 'expected the composerFocusRequest focus effect to exist')
  assert.ok(
    /startComposerFocusAttempt/.test(effectBlock),
    'tab-switch focus must verify activeElement and retry; a lost rAF otherwise strands the composer unfocused (investigation §4.2)',
  )
})

test('ChatCard escalates repeated or dead-end repairs to the pane panel (F9)', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  assert.match(
    source,
    /decideHitTestRepairScope/,
    'repair scope must be decided by the shared escalation helper',
  )
  assert.match(
    source,
    /closest\('\.pane-tab-panel'\)/,
    'panel-level escalation must target the pane-tab-panel ancestor',
  )
  assert.match(
    source,
    /markComposerRescueUnhandled\(textarea, event\)[\s\S]{0,600}escalateToPanel/,
    'the unhandled rescue dead end must escalate to a panel-level repair instead of silently returning',
  )
})

test('ChatCard focus effect reports exhaustion into a panel repair plus one follow-up attempt (F9)', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  const effectBlock =
    source.match(/if \(!usesPaneChrome \|\| isToolCard \|\| composerFocusRequest === 0\) \{[\s\S]*?\n {2}\}, \[card\.id, composerFocusRequest/)?.[0] ?? ''

  assert.ok(effectBlock, 'expected the composerFocusRequest focus effect to exist')
  assert.match(effectBlock, /onExhausted/, 'the ladder dead end must not stay silent')
  assert.match(
    effectBlock,
    /composerFocusExhaustedCount/,
    'exhaustion needs an observability counter like the other rescue dead ends',
  )
  assert.match(
    effectBlock,
    /isComposerFocusEffectivelyVacant/,
    'vacancy must treat this pane\'s own chrome as retryable (tab clicks park focus on the tab button)',
  )
})

test('the pane panel carries the transient hit-test repair CSS hook', async () => {
  const css = await readFile(path.join(process.cwd(), 'src', 'index.css'), 'utf8')
  assert.match(
    css,
    /\.pane-tab-panel\.is-hit-test-repair\s*\{[^}]*translateZ\(0\)/,
    'panel-level escalation needs the same transient translateZ(0) layer rebuild as the card shell',
  )
})

test('pointerdown rescue restores focus for misrouted-to-composer clicks too', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  const rescueBlock =
    source.match(/const handleDocumentPointerDownCapture = [\s\S]*?\r?\n {4}\}\r?\n/)?.[0] ?? ''

  assert.ok(rescueBlock, 'expected handleDocumentPointerDownCapture to exist')
  assert.ok(
    /routing === 'misrouted-to-textarea' \|\| routing === 'misrouted-to-composer'\) \{[\s\S]{0,500}?focus\(\{ preventScroll: true \}\)[\s\S]{0,80}?return/.test(rescueBlock),
    'a stale-routed click inside the textarea rect must regain focus even when layout resolves to a composer sibling (investigation §3.2)',
  )
})

test('rescue ignore list is confirmed against layout truth, not just the stale event target', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  assert.ok(
    /shouldSkipComposerRescueForIgnoredSurface/.test(source),
    'stale events can falsely name a long-lived ignored surface as target; only skip rescue when elementFromPoint confirms it (investigation §3.4)',
  )
})

test('unhandled rescue dead-ends are observable', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  assert.ok(
    /composerRescueUnhandledCount/.test(source),
    'the unrelated/no-heal dead end must leave a diagnostic trace (investigation §3.8)',
  )
})

test('keyboard tab shortcuts request composer focus like pointer activation does', async () => {
  const appSource = await readFile(appSourcePath, 'utf8')
  const shortcutBlock = appSource.match(/const handleShortcut = [\s\S]*?window\.addEventListener\('keydown', handleShortcut\)/)?.[0] ?? ''
  assert.ok(shortcutBlock, 'expected the global tab shortcut handler to exist')
  assert.ok(
    /dispatchComposerFocusRequest/.test(shortcutBlock),
    'Ctrl+T / Ctrl+Tab bypass the pane composerFocusRequest counter unless they dispatch the focus request event (investigation §4.3)',
  )

  const paneSource = await readFile(paneViewSourcePath, 'utf8')
  assert.ok(
    /composerFocusRequestEventName/.test(paneSource),
    'PaneView must listen for the app-level composer focus request event and bump its counter',
  )
})

test('a composer blur that drops focus to a vacant spot on the active card must request refocus', () => {
  // The forensic dump of the "locked in the input but nothing works" freeze
  // showed pointer clicks landing on the textarea (agree=true) while
  // document.activeElement was <body>: native focus never stuck. The retry
  // ladder only runs on structural actions (tab switch/add), so this
  // click-then-focus-fell-to-body path had no rescue. This gate is that rescue.
  assert.equal(
    shouldRefocusAfterComposerBlur({
      focusBecameVacant: true,
      cardHoldsFocus: true,
      blurCausedByPointerOutsideComposer: false,
    }),
    true,
    'focus falling to body/own-chrome while the active card still owns the composer is the stuck signature',
  )
})

test('a deliberate blur to a real element elsewhere must never be wrestled back', () => {
  assert.equal(
    shouldRefocusAfterComposerBlur({
      focusBecameVacant: false,
      cardHoldsFocus: true,
      blurCausedByPointerOutsideComposer: false,
    }),
    false,
    'the user moving focus to another real element is intentional — refocusing would trap them',
  )
})

test('an inactive/collapsed/tool card never reclaims composer focus on blur', () => {
  assert.equal(
    shouldRefocusAfterComposerBlur({
      focusBecameVacant: true,
      cardHoldsFocus: false,
      blurCausedByPointerOutsideComposer: false,
    }),
    false,
    'only a card that should hold the composer may reclaim focus; otherwise leave it vacant',
  )
})

test('a blur caused by pressing the pointer outside the composer (text selection) must never reclaim focus', () => {
  // Regression (v0.17.7): dragging to select conversation text starts with a
  // pointerdown on a non-focusable message node — the textarea blurs and focus
  // falls to <body>, which looks identical to the stuck signature. Reclaiming
  // focus there moves the document selection into the textarea and kills the
  // drag-selection mid-gesture. A pointer press outside the composer is a
  // deliberate departure even when the landing spot is not focusable.
  assert.equal(
    shouldRefocusAfterComposerBlur({
      focusBecameVacant: true,
      cardHoldsFocus: true,
      blurCausedByPointerOutsideComposer: true,
    }),
    false,
    'vacant focus caused by a pointer press outside the composer is a deliberate move, not the stuck signature',
  )
})

test('ChatCard blur rescue consults the outside-pointer signal so drag-selection is never interrupted', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  const blurBlock = source.match(/const handleComposerBlur = [\s\S]*?\n {2}\}, \[/)?.[0] ?? ''
  assert.ok(blurBlock, 'expected handleComposerBlur to exist')
  assert.match(
    blurBlock,
    /blurCausedByPointerOutsideComposer/,
    'the blur rescue must read the recent outside-composer pointerdown signal before reclaiming focus',
  )
})

test('ChatCard wires the textarea onBlur to the vacant-focus refocus rescue', async () => {
  const source = await readFile(chatCardSourcePath, 'utf8')
  assert.ok(
    /shouldRefocusAfterComposerBlur/.test(source),
    'the textarea onBlur must consult shouldRefocusAfterComposerBlur so a focus drop to body is rescued',
  )
})
