import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, it } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const cssPath = path.resolve(here, '..', 'src', 'index.css')

describe('message-list scrollbar gutter', () => {
  it('reserves symmetric scrollbar gutter so system messages stay centered when the list scrolls', () => {
    const css = readFileSync(cssPath, 'utf8')
    // Find the base .message-list rule (not the nested/override ones)
    const match = css.match(/\n\.message-list\s*\{[^}]*\}/)
    assert.ok(match, 'expected to find a .message-list rule')
    const rule = match[0]
    assert.match(
      rule,
      /scrollbar-gutter:\s*stable\s+both-edges/,
      '.message-list must declare `scrollbar-gutter: stable both-edges` to keep the visible content box centered',
    )
  })

  it('keeps embedded pane error cards width-constrained so reconnect failures do not create right-side blanks', () => {
    const css = readFileSync(cssPath, 'utf8')
    const paneCardRule = css.match(/\.pane-content > \.card-shell,\s*\.pane-content > \.pane-tab-panel > \.card-shell\s*\{[^}]*\}/)
    assert.ok(paneCardRule, 'expected pane embedded card sizing rule')
    assert.match(paneCardRule[0], /min-width:\s*0/, 'embedded cards must be allowed to shrink inside the pane')

    const paneErrorRule = css.match(/\.pane-content > \.card-shell:not\(\.is-error\),[\s\S]*?\.pane-content > \.pane-tab-panel > \.card-shell\.is-pane-embedded\.is-error\s*\{[^}]*\}/)
    assert.ok(paneErrorRule, 'expected pane embedded error cards to share the same transparent pane surface rule')
    assert.match(paneErrorRule[0], /border:\s*none/, 'embedded error cards should not keep standalone-card borders')
    assert.match(paneErrorRule[0], /background:\s*transparent/, 'embedded error cards should not repaint a narrower standalone background')
  })

  it('drops paint containment for pane-embedded chat cards so long-running panes keep repainting composer input', () => {
    const css = readFileSync(cssPath, 'utf8')
    const containmentRule = css.match(/\.card-shell\.is-streaming,[\s\S]*?\.card-shell:has\(\.message-sticky-overlay\)\s*\{[^}]*\}/)
    assert.ok(containmentRule, 'expected live chat containment mitigation rule')
    assert.match(
      containmentRule[0],
      /\.card-shell\.is-pane-embedded/,
      'pane-embedded chat cards should opt out of paint containment to avoid stale compositor/focus surfaces after long runs',
    )
    assert.match(
      containmentRule[0],
      /contain:\s*layout\s+style\s*;/,
      'pane-embedded mitigation should keep layout/style containment while dropping paint containment',
    )
    assert.doesNotMatch(
      containmentRule[0],
      /contain:\s*layout\s+style\s+paint\s*;/,
      'pane-embedded mitigation must not keep paint containment',
    )
  })

})
