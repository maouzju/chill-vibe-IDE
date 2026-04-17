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
})
