import assert from 'node:assert/strict'
import test from 'node:test'

import { readStringPreserveWhitespace } from '../server/provider-stream-text.js'

test('readStringPreserveWhitespace keeps newline-only streaming chunks intact', () => {
  assert.equal(readStringPreserveWhitespace({ delta: '\n\n' }, 'delta'), '\n\n')
  assert.equal(readStringPreserveWhitespace({ delta: '  leading\n' }, 'delta'), '  leading\n')
  assert.equal(readStringPreserveWhitespace({ delta: 42 }, 'delta'), undefined)
})
