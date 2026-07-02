import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  composerFocusRequestEventName,
  composerFocusRetryDelaysMs,
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

const createFakeEnv = (options?: { focusSucceeds?: boolean }): FakeEnv => {
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
