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
