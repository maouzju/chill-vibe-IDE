import { expect, test } from '@playwright/test'

// Real-behavior smoke for the stuck-pane forensics capture path: the hotkey
// must walk the live DOM and emit a parseable snapshot. In the browser there
// is no desktop bridge, so the runtime falls back to logging the JSON to the
// console — which is exactly what this spec intercepts.
test('Ctrl+Shift+F9 captures a parseable stuck-pane forensics snapshot', async ({ page }) => {
  const consoleLines: string[] = []
  page.on('console', (message) => consoleLines.push(message.text()))

  await page.goto('http://localhost:5173')
  await page.waitForLoadState('domcontentloaded')
  // Give the app root effect a beat to install the hotkey listener.
  await page.waitForTimeout(500)

  await page.keyboard.press('Control+Shift+F9')

  await expect
    .poll(() => consoleLines.some((line) => line.includes('[forensics] snapshot')), {
      timeout: 5_000,
    })
    .toBe(true)

  const line = consoleLines.find((entry) => entry.includes('[forensics] snapshot'))
  expect(line).toBeTruthy()

  const jsonStart = line!.indexOf('{')
  expect(jsonStart).toBeGreaterThan(-1)
  const snapshot = JSON.parse(line!.slice(jsonStart)) as {
    schema: string
    reason: string
    activeElementPath: string
    hitGrid: unknown[]
    pointerLedger: unknown[]
    panes: unknown[]
  }

  expect(snapshot.schema).toBe('chill-vibe.stuck-pane-forensics.v1')
  expect(snapshot.reason).toBe('hotkey')
  expect(typeof snapshot.activeElementPath).toBe('string')
  expect(snapshot.hitGrid.length).toBe(12 * 8)
  expect(Array.isArray(snapshot.pointerLedger)).toBe(true)
  expect(Array.isArray(snapshot.panes)).toBe(true)
})

test('pointerdown activity lands in the forensics ledger with routing agreement', async ({
  page,
}) => {
  const consoleLines: string[] = []
  page.on('console', (message) => consoleLines.push(message.text()))

  await page.goto('http://localhost:5173')
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(500)

  // A couple of real clicks somewhere harmless (the page body).
  await page.mouse.click(200, 400)
  await page.mouse.click(300, 400)

  await page.keyboard.press('Control+Shift+F9')

  await expect
    .poll(() => consoleLines.some((line) => line.includes('[forensics] snapshot')), {
      timeout: 5_000,
    })
    .toBe(true)

  const line = consoleLines.find((entry) => entry.includes('[forensics] snapshot'))!
  const snapshot = JSON.parse(line.slice(line.indexOf('{'))) as {
    pointerLedger: Array<{ targetPath: string; hitPath: string; agree: boolean }>
  }

  expect(snapshot.pointerLedger.length).toBeGreaterThanOrEqual(2)
  for (const entry of snapshot.pointerLedger) {
    expect(typeof entry.targetPath).toBe('string')
    expect(typeof entry.hitPath).toBe('string')
    // Healthy routing in a healthy renderer: event target and layout truth
    // must agree. A false here in production IS the misroute smoking gun.
    expect(entry.agree).toBe(true)
  }
})
