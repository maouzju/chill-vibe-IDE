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

// ─── Global infinite-animation budget ────────────────────────────────────────
// Every other assertion in this file is a per-selector allowlist: it proves the
// selectors we already burned ourselves on stayed static. That shape is blind by
// construction — adding `animation: x 2s infinite` to a *new* selector keeps CI
// green while re-arming pitfalls 216/218 (AGENTS.md), where accumulated infinite
// paint work across mounted-but-inactive panes drove `BrowserWindow
// unresponsive` with an empty JS stack after ~30 minutes of multi-stream use.
// The test below inverts that: it enumerates *all* infinite animations in
// src/index.css and requires the set to equal this allowlist exactly.

interface InfiniteAnimationException {
  /** Exact selector key as produced by `infiniteAnimationSelectors()`. */
  readonly selector: string
  /** Why this one is allowed to loop forever. Required — no silent entries. */
  readonly reason: string
}

const INFINITE_ANIMATION_ALLOWLIST: readonly InfiniteAnimationException[] = [
  // ── bounce-dot (streaming / command-running dots) ──
  // These four are the *scoped* survivors of the pitfall 218 cleanup. The dots
  // themselves are static at the base selector (`.streaming-dots span`,
  // `.structured-command-running-dots span`); motion is re-attached only through
  // a visibility-gated ancestor, so N background panes contribute 0 animated
  // elements. Do NOT hoist these declarations onto the base selectors.
  {
    selector: '.pane-tab-panel.is-active:not([hidden]) .streaming-dots span',
    reason:
      'Gated to the single visible active tab panel: `.is-active:not([hidden])` never matches the mounted-but-hidden panes that accumulated the pitfall 218 compositor budget.',
  },
  {
    selector: '.pane-tab-panel.is-active:not([hidden]) .structured-command-running-dots span',
    reason:
      'Same visibility gate as the streaming dots, for the structured-command running indicator.',
  },
  {
    selector: '.pane-content > .card-shell .streaming-dots span',
    reason:
      'Untabbed pane layout: a direct `.pane-content` child card is the pane, so it is always on screen — there is no hidden sibling stack to multiply the animation across.',
  },
  {
    selector: '.pane-content > .card-shell .structured-command-running-dots span',
    reason:
      'Untabbed pane layout counterpart for the structured-command running indicator.',
  },

  // ── Automation board lane header ──
  // Same treatment as the bounce dots above: the base
  // `.automation-board-lane-running-dot` is static, and the pulse is re-attached
  // only through a visibility-gated ancestor. A board left running overnight in a
  // background pane must contribute zero animated elements.
  {
    selector: '.pane-tab-panel.is-active:not([hidden]) .automation-board-lane-running-dot',
    reason:
      'Gated to the visible active tab panel, so mounted-but-hidden boards do not accumulate compositor work while their lanes run.',
  },
  {
    selector: '.pane-content > .card-shell .automation-board-lane-running-dot',
    reason:
      'Untabbed pane layout counterpart: a direct `.pane-content` child card is the pane, so it is always on screen.',
  },

  // ── Weather card ambience ──
  // Legacy decorative motion, kept because it only mounts while the weather card
  // itself is rendered (one opt-in card, not per-pane chrome) and because the
  // keyframes were already moved onto transform/opacity — see
  // tests/weather-card-performance.test.ts. These are the ceiling, not a
  // precedent: new long-lived chrome must not copy this pattern.
  {
    selector: '.weather-ambient-rain',
    reason: 'Weather card ambience: full-window rain layer, transform-only keyframes.',
  },
  {
    selector: '.weather-sun-rays',
    reason: 'Weather card ambience: sun ray rotation, transform-only keyframes.',
  },
  {
    selector: '.weather-sun-rays--slow',
    reason: 'Weather card ambience: slow counter-rotating sun ray layer.',
  },
  {
    selector: '.weather-stars::before',
    reason: 'Weather card ambience: night sky twinkle, opacity-only keyframes.',
  },
  {
    selector: '.weather-stars::after',
    reason: 'Weather card ambience: second twinkle layer sharing the same keyframes.',
  },
  {
    selector: '.weather-cloud',
    reason: 'Weather card ambience: cloud drift, transform-only keyframes.',
  },
  {
    selector: '.weather-rain-streak',
    reason: 'Weather card ambience: in-card rain streaks, transform/opacity keyframes.',
  },
  {
    selector: '.weather-rain-streak::after',
    reason: 'Weather card ambience: rain splash paired with the streak animation.',
  },
  {
    selector: '.weather-snow-dot',
    reason: 'Weather card ambience: snowfall drift, transform/opacity keyframes.',
  },
  {
    selector: '.weather-fog-layer--back',
    reason: 'Weather card ambience: back fog layer drift.',
  },
  {
    selector: '.weather-fog-layer--mid',
    reason: 'Weather card ambience: mid fog layer drift.',
  },
  {
    selector: '.weather-fog-layer--front',
    reason: 'Weather card ambience: front fog layer drift.',
  },
  {
    selector: '.weather-lightning',
    reason: 'Weather card ambience: storm flash overlay.',
  },
  {
    selector: '.weather-lightning::before',
    reason: 'Weather card ambience: lightning bolt paired with the flash overlay.',
  },
]

/** Drops `/* … *\/` comments so commented-out CSS never counts as a declaration. */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Splits on `separator` while ignoring separators nested inside `(…)`. */
const splitTopLevel = (input: string, separator: string) => {
  const parts: string[] = []
  let depth = 0
  let buffer = ''
  for (const char of input) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === separator && depth === 0) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += char
  }
  parts.push(buffer)
  return parts
}

const findBlockEnd = (input: string, openBraceIndex: number) => {
  let depth = 0
  for (let index = openBraceIndex; index < input.length; index += 1) {
    if (input[index] === '{') depth += 1
    else if (input[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

interface StyleRule {
  /** Enclosing at-rule preludes, outermost first (e.g. `@media (min-width: 900px)`). */
  readonly conditions: readonly string[]
  /** Raw selector list, whitespace-collapsed. */
  readonly prelude: string
  readonly body: string
}

/**
 * Collects every style rule, descending through conditional at-rules (`@media`,
 * `@supports`, `@layer`) and skipping `@keyframes` bodies — percentage stops are
 * not selectors and never carry an `animation` shorthand.
 */
const collectStyleRules = (
  css: string,
  conditions: readonly string[],
  collected: StyleRule[],
) => {
  let cursor = 0
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor)
    if (open === -1) break
    const close = findBlockEnd(css, open)
    if (close === -1) break

    const prelude = css.slice(cursor, open).trim().replace(/\s+/g, ' ')
    const body = css.slice(open + 1, close)

    if (prelude.startsWith('@')) {
      const atName = (prelude.slice(1).split(/[\s({]/, 1)[0] ?? '').toLowerCase()
      // `@keyframes` / `@-webkit-keyframes` bodies are not style rules.
      if (!atName.endsWith('keyframes')) {
        collectStyleRules(body, [...conditions, prelude], collected)
      }
    } else if (prelude) {
      collected.push({ conditions, prelude, body })
    }

    cursor = close + 1
  }
}

const ANIMATION_PROPERTIES = new Set(['animation', 'animation-iteration-count'])

/**
 * Returns one key per (selector × infinite animation declaration) found in the
 * stylesheet, e.g. `.weather-cloud` or
 * `@media (min-width: 900px) >> .foo`. Selector lists are expanded so each
 * element that actually animates is accounted for individually.
 *
 * Robustness notes: shorthand (`animation: x 1s infinite`), longhand
 * (`animation-iteration-count: infinite`), multi-line declarations and
 * `animation: none` overrides are all handled — a rule is only reported when one
 * of its own animation declarations literally contains the `infinite` keyword.
 */
const infiniteAnimationSelectors = (css: string) => {
  const rules: StyleRule[] = []
  collectStyleRules(stripCssComments(css), [], rules)

  const found = new Map<string, string>()
  for (const rule of rules) {
    const loops: string[] = []
    for (const rawDeclaration of splitTopLevel(rule.body, ';')) {
      const colon = rawDeclaration.indexOf(':')
      if (colon === -1) continue
      const property = rawDeclaration.slice(0, colon).trim().toLowerCase()
      if (!ANIMATION_PROPERTIES.has(property)) continue
      const value = rawDeclaration.slice(colon + 1).trim().replace(/\s+/g, ' ')
      if (/(^|[\s,])infinite([\s,]|$)/.test(value)) loops.push(`${property}: ${value}`)
    }
    if (loops.length === 0) continue

    for (const rawSelector of splitTopLevel(rule.prelude, ',')) {
      const selector = rawSelector.trim()
      if (!selector) continue
      const key = [...rule.conditions, selector].join(' >> ')
      found.set(key, [found.get(key), ...loops].filter(Boolean).join(' | '))
    }
  }
  return found
}

test('every infinite CSS animation is on the reviewed allowlist', async () => {
  const css = await indexCssPromise
  const found = infiniteAnimationSelectors(css)

  const allowed = new Set(INFINITE_ANIMATION_ALLOWLIST.map((entry) => entry.selector))
  assert.equal(
    allowed.size,
    INFINITE_ANIMATION_ALLOWLIST.length,
    'INFINITE_ANIMATION_ALLOWLIST contains duplicate selectors',
  )
  for (const entry of INFINITE_ANIMATION_ALLOWLIST) {
    assert.ok(
      entry.reason.trim().length > 0,
      `allowlist entry ${entry.selector} must document why it is allowed to loop forever`,
    )
  }

  const unreviewed = [...found.keys()].filter((selector) => !allowed.has(selector)).sort()
  const stale = [...allowed].filter((selector) => !found.has(selector)).sort()

  assert.deepEqual(
    { unreviewed, stale },
    { unreviewed: [], stale: [] },
    [
      'src/index.css infinite-animation budget changed.',
      '',
      unreviewed.length > 0
        ? [
            'NEW infinite animation(s) with no reviewed justification:',
            ...unreviewed.map((selector) => `  - ${selector}  {${found.get(selector)}}`),
            '',
            'Infinite animations are the root cause of the `BrowserWindow unresponsive`',
            'family of bugs (AGENTS.md pitfalls 216 and 218): every mounted-but-inactive',
            'pane that matches keeps Electron\'s renderer/GPU doing paint & raster work for',
            'the whole provider run, the cost multiplies across concurrent streams, and the',
            'window dies after ~30 minutes with an EMPTY JS stack — so it will not show up',
            'in any profiler or crash report you would normally reach for.',
            '',
            'Pick one:',
            '  1. Make it bounded — an explicit iteration count plus static resting',
            '     declarations equal to the 0% keyframe (see .card-shell.is-complete-unread).',
            '  2. Make it static — most status chrome reads fine as a fixed border/shadow.',
            '  3. Gate it to something actually visible, e.g. prefix the selector with',
            '     `.pane-tab-panel.is-active:not([hidden])`, so hidden panes match nothing.',
            '  4. If it genuinely must loop forever, add it to INFINITE_ANIMATION_ALLOWLIST',
            '     in this file WITH a reason explaining why it cannot accumulate.',
          ].join('\n')
        : '',
      stale.length > 0
        ? [
            'Allowlisted selector(s) no longer present in src/index.css:',
            ...stale.map((selector) => `  - ${selector}`),
            '',
            'Remove them from INFINITE_ANIMATION_ALLOWLIST so the list keeps failing loudly',
            'on real regressions instead of rotting into a rubber stamp.',
          ].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
})

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

test('streaming cards keep a static border without an unbounded paint animation', async () => {
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
  assert.doesNotMatch(
    focusedStreamingBlock,
    /\binfinite\b/,
    'even the focused streaming card must not repaint a full-card box shadow forever',
  )
})

test('streaming pane tabs do not run an infinite box-shadow animation', async () => {
  const css = await indexCssPromise
  const inactiveStreamingTabBlock =
    css.match(/\.pane-tab\.is-streaming:not\(\.is-active\)\s*\{[^}]*\}/)?.[0] ?? ''

  assert.match(
    inactiveStreamingTabBlock,
    /box-shadow:/,
    'inactive streaming tabs still need a visible static outline',
  )
  assert.doesNotMatch(
    inactiveStreamingTabBlock,
    /\binfinite\b/,
    'streaming tab chrome must not keep the compositor repainting forever',
  )
})

test('hidden streaming dots stay static while the visible active pane keeps motion feedback', async () => {
  const css = await indexCssPromise
  const staticSelectors = ['.streaming-dots span', '.structured-command-running-dots span', '.is-busy::before']

  for (const selector of staticSelectors) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const block = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0] ?? ''
    assert.ok(block, `missing long-lived status selector: ${selector}`)
    assert.doesNotMatch(
      block,
      /animation\s*:[^;]*\binfinite\b/,
      `${selector} must remain static so hidden streaming panes do not age the compositor`,
    )
  }

  const activeStreamingBlock =
    css.match(/\.pane-tab-panel\.is-active:not\(\[hidden\]\) \.streaming-dots span\s*\{[^}]*\}/)?.[0] ?? ''
  const activeCommandBlock =
    css.match(
      /\.pane-tab-panel\.is-active:not\(\[hidden\]\) \.structured-command-running-dots span\s*\{[^}]*\}/,
    )?.[0] ?? ''

  assert.match(activeStreamingBlock, /animation\s*:[^;]*\bbounce-dot\b[^;]*\binfinite\b/)
  assert.match(activeCommandBlock, /animation\s*:[^;]*\bbounce-dot\b[^;]*\binfinite\b/)
})
