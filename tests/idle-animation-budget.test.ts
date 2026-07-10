import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

// Idle cards must not run unbounded compositor-layer animations: the
// completion "breathe" glow paints on inset:0 pseudo-element layers covering
// the whole card (composer included), and an infinite loop on idle cards is
// the main long-session aging stimulus behind stale hit-test surfaces
// (docs/specs/composer-focus-loss/investigation.md §2.2, fix F7). Finite
// iteration counts keep the unread affordance while ending the stimulus.

const indexCssPromise = readFile(path.join(process.cwd(), 'src', 'index.css'), 'utf8')

const completeUnreadAnimationDeclarations = (css: string) => {
  const declarations: string[] = []
  const blockPattern = /\.card-shell\.is-complete-unread[^{]*\{([^}]*)\}/g
  for (const match of css.matchAll(blockPattern)) {
    const body = match[1] ?? ''
    for (const line of body.split(';')) {
      if (/^\s*animation\s*:/.test(line)) {
        declarations.push(line.trim())
      }
    }
  }
  return declarations
}

test('the complete-unread breathe glow animates a bounded number of times, never infinitely', async () => {
  const css = await indexCssPromise
  const declarations = completeUnreadAnimationDeclarations(css)

  assert.ok(
    declarations.length >= 2,
    `expected the ::before halo and ::after border breathe declarations, found: ${JSON.stringify(declarations)}`,
  )

  for (const declaration of declarations) {
    assert.ok(
      !/\binfinite\b/.test(declaration),
      `idle completion glow must not loop forever (investigation §2.2/F7): ${declaration}`,
    )
    assert.ok(
      /\b\d+\b/.test(declaration) || /animation:\s*none/.test(declaration),
      `expected an explicit finite iteration count (or none): ${declaration}`,
    )
  }
})

test('the static unread affordance survives after the animation budget runs out', async () => {
  const css = await indexCssPromise
  // With fill-mode none the keyframe values stop applying entirely once the
  // bounded cycles end, so the visible glow MUST exist as static declarations
  // (matching the 0% frame): a bare opacity: 1 on pseudo-elements that only
  // paint via keyframes would leave the card with no unread affordance at all
  // (adversarial review finding on F7).
  const beforeBlock = css.match(/\.card-shell\.is-complete-unread::before\s*\{[^}]*\}/)?.[0] ?? ''
  const afterBlock = css.match(/\.card-shell\.is-complete-unread::after\s*\{[^}]*\}/)?.[0] ?? ''

  assert.match(beforeBlock, /opacity:\s*1/)
  assert.match(
    beforeBlock,
    /box-shadow:[^;]*var\(--completion-glow-border\)/,
    'the halo needs a static resting box-shadow equal to the 0% keyframe',
  )
  assert.match(afterBlock, /opacity:\s*1/)
  assert.match(
    afterBlock,
    /border-color:\s*var\(--completion-glow-border\)/,
    'the border needs a static resting border-color equal to the 0% keyframe',
  )
})

test('only the focused streaming card may run the full-card breathe animation', async () => {
  const css = await indexCssPromise
  const backgroundStreamingBlock =
    css.match(/\.card-shell\.is-streaming::after\s*\{[^}]*\}/)?.[0] ?? ''
  const focusedStreamingBlock =
    css.match(/\.card-shell\.is-streaming:focus-within::after\s*\{[^}]*\}/)?.[0] ?? ''

  assert.match(
    backgroundStreamingBlock,
    /border-color:\s*var\(--stream-border\)/,
    'background streaming cards still need a visible static border',
  )
  assert.doesNotMatch(
    backgroundStreamingBlock,
    /\binfinite\b/,
    'multiple background streaming panes must not repaint full-card box shadows forever',
  )
  assert.match(
    focusedStreamingBlock,
    /animation:\s*card-streaming-border-breathe\b[^;]*\binfinite\b/,
    'the focused composer may keep one live streaming breathe animation',
  )
})
