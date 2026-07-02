import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const paneViewSourcePath = path.join(process.cwd(), 'src', 'components', 'PaneView.tsx')

test('pane tab activation fallback is timer-based so drag gestures can cancel it', async () => {
  const source = await readFile(paneViewSourcePath, 'utf8')
  const activateTabBlock =
    source.match(/const activateTab = \(tabId: string\) => \{[\s\S]*?\n {2}\}/)?.[0] ?? ''
  const scheduleBlock =
    source.match(/const schedulePointerDownTabActivation = \(tabId: string\) => \{[\s\S]*?\n {2}\}/)?.[0] ?? ''

  assert.ok(activateTabBlock, 'expected PaneView to define activateTab')
  assert.ok(scheduleBlock, 'expected PaneView to define a pointer-down fallback scheduler')
  assert.equal(
    activateTabBlock.includes('requestAnimationFrame'),
    false,
    'tab switching must happen in the input event; a dropped/throttled rAF plus swallowed click can make tabs look dead',
  )
  assert.match(
    scheduleBlock,
    /window\.setTimeout/,
    'pointer-down fallback should be delayed just long enough for drag detection to cancel it',
  )
})

test('clicking the already-active tab still requests composer focus as a recovery gesture', async () => {
  const source = await readFile(paneViewSourcePath, 'utf8')
  const activateTabBlock =
    source.match(/const activateTab = \(tabId: string\) => \{[\s\S]*?\n {2}\}/)?.[0] ?? ''

  assert.ok(activateTabBlock, 'expected PaneView to define activateTab')
  const earlyReturnBranch =
    activateTabBlock.match(/if \(pane\.activeTabId === tabId\) \{[\s\S]*?\n {4}\}/)?.[0] ?? ''
  assert.ok(earlyReturnBranch, 'expected activateTab to keep its already-active early return')
  assert.ok(
    /requestComposerFocus\(tabId\)/.test(earlyReturnBranch),
    'clicking the active tab is the natural focus-recovery gesture when the composer looks dead; it must re-request composer focus instead of no-op (investigation §4.1)',
  )
})

test('tab mousedown must never preventDefault the left button or tab dragging dies', async () => {
  const source = await readFile(paneViewSourcePath, 'utf8')
  const mouseDownBlock =
    source.match(/const handleTabMouseDown = [\s\S]*?\n {2}\}/)?.[0] ?? ''

  assert.ok(mouseDownBlock, 'expected PaneView to define handleTabMouseDown')
  // Starting a drag is part of mousedown's default action in every browser:
  // preventDefault on a left mousedown suppresses dragstart entirely, which
  // silently kills drag-to-split/reorder on these draggable tabs. The button
  // briefly taking native focus is acceptable because activateTab re-requests
  // composer focus and the retry driver moves focus unconditionally.
  assert.ok(
    !/button === 0[\s\S]*?preventDefault\(\)/.test(mouseDownBlock),
    'do not preventDefault left mousedown on draggable pane tabs; it cancels dragstart in all browsers',
  )
  assert.ok(
    /button !== 1[\s\S]*?preventDefault\(\)/.test(mouseDownBlock),
    'middle-click autoscroll suppression must stay in place',
  )
})

test('pane tab activation has a pointer-down fallback and still activates on pointer up for normal clicks', async () => {
  const source = await readFile(paneViewSourcePath, 'utf8')
  const pointerDownBlock =
    source.match(/const handleTabPointerDown = \(tabId: string\) => \(event: PointerEvent<HTMLButtonElement>\) => \{[\s\S]*?\n {2}\}/)?.[0] ?? ''
  const pointerUpBlock =
    source.match(/const handleTabPointerUp = \(tabId: string\) => \(event: PointerEvent<HTMLButtonElement>\) => \{[\s\S]*?\n {2}\}/)?.[0] ?? ''

  assert.ok(pointerDownBlock, 'expected PaneView to define handleTabPointerDown')
  assert.match(
    pointerDownBlock,
    /schedulePointerDownTabActivation\(tabId\)/,
    'pane tabs need a pointerdown fallback because Electron can lose pointerup/click after long-lived streaming hit-test churn',
  )
  assert.match(
    pointerUpBlock,
    /activateTab\(tabId\)/,
    'normal clicks should still activate on pointerup instead of waiting for the fallback timer',
  )
  assert.equal(
    pointerDownBlock.includes('activateTab(tabId)'),
    false,
    'pointerdown must not immediately activate because drag gestures need a chance to cancel focus switching',
  )
})
