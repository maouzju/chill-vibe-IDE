import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test('sticky preview width stays tied to the overlay lane instead of a shrink-to-fit target', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

  const stickyOverlayRules = Array.from(css.matchAll(/\.message-sticky-overlay\s*\{[^}]*\}/g), (match) => match[0])
  assert.ok(stickyOverlayRules.length > 0, 'expected to find at least one .message-sticky-overlay rule')
  assert.ok(
    stickyOverlayRules.some((rule) => /container-type:\s*inline-size;/.test(rule)),
    'expected a .message-sticky-overlay rule to declare `container-type: inline-size`',
  )

  const stickyAnchorRules = Array.from(css.matchAll(/\.message-user\.is-sticky-anchor\s*\{[^}]*\}/g), (match) => match[0])
  assert.ok(stickyAnchorRules.length > 0, 'expected to find a .message-user.is-sticky-anchor rule')
  assert.ok(
    stickyAnchorRules.some(
      (rule) =>
        /max-inline-size:\s*(?:88cqw|min\(\s*88cqw\s*,\s*100%\s*\));/.test(rule),
    ),
    'expected sticky user previews to clamp width with container-width units (`88cqw`)',
  )
})
