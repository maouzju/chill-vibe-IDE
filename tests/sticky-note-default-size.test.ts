import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createCard,
  getCardDefaultSize,
  getCardMinimumSize,
  normalizeCardSize,
} from '../shared/default-state.ts'
import { STICKYNOTE_TOOL_MODEL } from '../shared/models.ts'

describe('sticky note card sizing', () => {
  it('uses a one-line minimum height and four-line default height', () => {
    assert.equal(getCardMinimumSize(STICKYNOTE_TOOL_MODEL), 96)
    assert.equal(getCardDefaultSize(STICKYNOTE_TOOL_MODEL), 164)
    assert.equal(normalizeCardSize(80, getCardMinimumSize(STICKYNOTE_TOOL_MODEL), getCardDefaultSize(STICKYNOTE_TOOL_MODEL)), 96)
    assert.equal(createCard('Sticky', undefined, 'codex', STICKYNOTE_TOOL_MODEL).size, 164)
    assert.equal(createCard('Sticky', 80, 'codex', STICKYNOTE_TOOL_MODEL).size, 96)
  })
})
