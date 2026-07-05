import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  decideMisroutedTabPointerRescue,
  isPointerWithinRect,
  type PaneTabRescueTabGeometry,
} from '../src/components/pane-tab-rescue'

type RectLike = { left: number; top: number; right: number; bottom: number }

const rect = (left: number, top: number, right: number, bottom: number): RectLike => ({
  left,
  top,
  right,
  bottom,
})

const fakeElement = (label: string): Element => ({ __label: label }) as unknown as Element

const makeTab = (
  tabId: string,
  tabRect: RectLike,
  options?: {
    ownsEventTarget?: boolean
    ownedElements?: Element[]
    ownedCloseElements?: Element[]
  },
): PaneTabRescueTabGeometry => {
  const owned = new Set(options?.ownedElements ?? [])
  const ownedClose = new Set(options?.ownedCloseElements ?? [])
  return {
    tabId,
    rect: tabRect,
    ownsEventTarget: options?.ownsEventTarget ?? false,
    ownsElement: (element) => owned.has(element) || ownedClose.has(element),
    ownsCloseElement: (element) => ownedClose.has(element),
  }
}

test('pointer outside every tab rect never rescues', () => {
  const decision = decideMisroutedTabPointerRescue(
    { x: 500, y: 500 },
    [makeTab('a', rect(0, 0, 100, 30))],
    () => fakeElement('anything'),
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('normally-routed pointerdown (target already owned by the tab) is left to native handlers', () => {
  const decision = decideMisroutedTabPointerRescue(
    { x: 50, y: 15 },
    [makeTab('a', rect(0, 0, 100, 30), { ownsEventTarget: true })],
    () => {
      throw new Error('layout truth must not be queried on the normal path')
    },
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('misrouted pointerdown with layout truth confirming the tab activates it', () => {
  const hit = fakeElement('tab-a-label')
  const decision = decideMisroutedTabPointerRescue(
    { x: 50, y: 15 },
    [makeTab('a', rect(0, 0, 100, 30), { ownedElements: [hit] })],
    () => hit,
  )
  assert.deepEqual(decision, { kind: 'activate', tabId: 'a' })
})

test('misrouted pointerdown whose layout hit is the interactive close control closes the tab', () => {
  const closeIcon = fakeElement('tab-a-close-icon')
  const decision = decideMisroutedTabPointerRescue(
    { x: 92, y: 15 },
    [makeTab('a', rect(0, 0, 100, 30), { ownedCloseElements: [closeIcon] })],
    () => closeIcon,
  )
  assert.deepEqual(decision, { kind: 'close', tabId: 'a' })
})

test('a click on an inactive tab\'s close placeholder region activates instead of closing', () => {
  // The close span on inactive, unhovered tabs is opacity: 0 +
  // pointer-events: none but still occupies layout space. elementFromPoint
  // therefore resolves to the button itself — native semantics for that click
  // are "activate", and rescuing it as "close" would destroy a session the
  // user was trying to open.
  const buttonBody = fakeElement('tab-a-button')
  const decision = decideMisroutedTabPointerRescue(
    { x: 92, y: 15 },
    [makeTab('a', rect(0, 0, 100, 30), { ownedElements: [buttonBody] })],
    () => buttonBody,
  )
  assert.deepEqual(decision, { kind: 'activate', tabId: 'a' })
})

test('a real overlay above the tab (layout hit not owned by it) blocks the rescue', () => {
  const menu = fakeElement('context-menu-item')
  const decision = decideMisroutedTabPointerRescue(
    { x: 50, y: 15 },
    [makeTab('a', rect(0, 0, 100, 30))],
    () => menu,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('a null layout hit keeps the conservative no-action path', () => {
  const decision = decideMisroutedTabPointerRescue(
    { x: 50, y: 15 },
    [makeTab('a', rect(0, 0, 100, 30))],
    () => null,
  )
  assert.deepEqual(decision, { kind: 'none' })
})

test('the pointer picks the tab whose rect contains it among several', () => {
  const hitB = fakeElement('tab-b-label')
  const decision = decideMisroutedTabPointerRescue(
    { x: 150, y: 15 },
    [
      makeTab('a', rect(0, 0, 100, 30), { ownedElements: [fakeElement('tab-a')] }),
      makeTab('b', rect(100, 0, 200, 30), { ownedElements: [hitB] }),
    ],
    () => hitB,
  )
  assert.deepEqual(decision, { kind: 'activate', tabId: 'b' })
})

test('isPointerWithinRect matches inclusive rect edges', () => {
  const r = rect(10, 10, 20, 20)
  assert.equal(isPointerWithinRect({ x: 10, y: 10 }, r), true)
  assert.equal(isPointerWithinRect({ x: 20, y: 20 }, r), true)
  assert.equal(isPointerWithinRect({ x: 15, y: 15 }, r), true)
  assert.equal(isPointerWithinRect({ x: 9, y: 15 }, r), false)
  assert.equal(isPointerWithinRect({ x: 15, y: 21 }, r), false)
})

// ── PaneView wiring assertions ──────────────────────────────────────────────
// The decision core above is behavior-tested; these pin the wiring that cannot
// run under node:test without a DOM: the document-capture listener, the
// data-tab-id enumeration hooks, the phantom-activation coordinate guards, and
// the pane-activation coupling the adversarial review demanded.

const paneViewSourcePromise = readFile(
  path.join(process.cwd(), 'src', 'components', 'PaneView.tsx'),
  'utf8',
)

test('PaneView wires the misrouted tab rescue on document pointerdown capture', async () => {
  const source = await paneViewSourcePromise
  assert.match(source, /decideMisroutedTabPointerRescue\(point, tabs/)
  assert.match(
    source,
    /document\.addEventListener\('pointerdown', handleMisroutedTabPointerDown, true\)/,
  )
})

test('PaneView tab buttons expose data-pane-tab-id for rescue enumeration', async () => {
  const source = await paneViewSourcePromise
  assert.match(source, /data-pane-tab-id=\{tabId\}/)
})

test('rescued tab actions also activate the pane so global shortcuts target it', async () => {
  const source = await paneViewSourcePromise
  const start = source.indexOf('tabRescueActionsRef.current = {')
  assert.ok(start >= 0, 'expected the rescue actions wiring assignment to exist')
  const wiringBlock = source.slice(start, start + 600)
  const activationCount = wiringBlock.match(/onActivatePane\(pane\.id\)/g)?.length ?? 0
  assert.equal(
    activationCount,
    2,
    'both rescued activate and rescued close must activate the pane first; otherwise Ctrl+W etc. keep targeting the previously active pane',
  )
})

test('tab pointerdown fallback activation is guarded by pointer coordinates', async () => {
  const source = await paneViewSourcePromise
  const pointerDownHandler = source.slice(
    source.indexOf('const handleTabPointerDown'),
    source.indexOf('const handleTabPointerMove'),
  )
  assert.match(
    pointerDownHandler,
    /isPointerWithinRect/,
    'handleTabPointerDown must reject pointerdowns whose coordinates fall outside the tab rect (phantom activation guard, investigation §3.5)',
  )
  assert.ok(
    pointerDownHandler.indexOf('suppressNextTabClickRef.current = null') <
      pointerDownHandler.indexOf('isPointerWithinRect'),
    'the stale-suppress reset must run before the coordinate guard so a rejected pointerdown cannot strand a stale suppress that eats the next legitimate click',
  )
})

test('tab click and aux-click paths carry the same phantom coordinate guard (keyboard clicks exempt)', async () => {
  const source = await paneViewSourcePromise
  const clickHandler = source.slice(
    source.indexOf('const handleTabClick'),
    source.indexOf('const handleTabMouseDown'),
  )
  assert.match(
    clickHandler,
    /event\.detail > 0[\s\S]{0,120}isPointerWithinRect/,
    'pointer-driven clicks need the coordinate check while keyboard-synthesized clicks (detail 0) must pass',
  )
  const auxHandler = source.slice(
    source.indexOf('const handleTabAuxClick'),
    source.indexOf('const handleContentDrop'),
  )
  assert.match(
    auxHandler,
    /isPointerWithinRect/,
    'middle-click close is destructive and must not act on phantom-routed events',
  )
})

test('requestComposerFocus delegates the closure-miss decision instead of swallowing the bump', async () => {
  const source = await paneViewSourcePromise
  const requestBlock = source.slice(
    source.indexOf('const requestComposerFocus'),
    source.indexOf('// Keep the document-capture tab rescue'),
  )
  // A rescue/add firing in the one-frame window after a new tab mounts hands a
  // tabId the previous render's cards map lacks. Dereferencing it must not
  // throw AND — the forensic deadlock fix — must NOT drop the bump: a
  // closure-miss still needs to bump so the mounted composer starts its ladder.
  // The decision lives in the pure decideComposerFocusRequest, not an inline
  // `!card` early-return that silently swallowed the request.
  assert.match(
    requestBlock,
    /decideComposerFocusRequest\(/,
    'requestComposerFocus must route through decideComposerFocusRequest so a closure-miss still bumps rather than being swallowed',
  )
  assert.doesNotMatch(
    requestBlock,
    /if \(!card \|\| !cardUsesComposer\(card\)\) \{\s*return/,
    'the old early-return that dropped the focus bump on a closure-miss must be gone (new-tab focus deadlock)',
  )
})
