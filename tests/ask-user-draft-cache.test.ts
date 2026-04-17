import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getAskUserDraft,
  setAskUserDraft,
  clearAskUserDraft,
  __resetAskUserDraftCacheForTests,
} from '../src/components/ask-user-draft-cache.ts'

test('ask-user draft cache returns null for unknown itemId', () => {
  __resetAskUserDraftCacheForTests()
  assert.equal(getAskUserDraft('missing'), null)
})

test('ask-user draft cache persists selected + otherText across get calls', () => {
  __resetAskUserDraftCacheForTests()
  setAskUserDraft('item-1', { selected: 'Option A', otherText: '' })
  const draft = getAskUserDraft('item-1')
  assert.deepEqual(draft, { selected: 'Option A', otherText: '' })
})

test('ask-user draft cache keeps distinct drafts per itemId', () => {
  __resetAskUserDraftCacheForTests()
  setAskUserDraft('item-1', { selected: 'Option A', otherText: '' })
  setAskUserDraft('item-2', { selected: 'Other', otherText: 'free text' })
  assert.deepEqual(getAskUserDraft('item-1'), { selected: 'Option A', otherText: '' })
  assert.deepEqual(getAskUserDraft('item-2'), { selected: 'Other', otherText: 'free text' })
})

test('ask-user draft cache clears draft for a single itemId', () => {
  __resetAskUserDraftCacheForTests()
  setAskUserDraft('item-1', { selected: 'Option A', otherText: '' })
  setAskUserDraft('item-2', { selected: 'Option B', otherText: '' })
  clearAskUserDraft('item-1')
  assert.equal(getAskUserDraft('item-1'), null)
  assert.deepEqual(getAskUserDraft('item-2'), { selected: 'Option B', otherText: '' })
})

test('ask-user draft cache overwrites prior draft on the same itemId', () => {
  __resetAskUserDraftCacheForTests()
  setAskUserDraft('item-1', { selected: 'Option A', otherText: '' })
  setAskUserDraft('item-1', { selected: 'Other', otherText: 'updated' })
  assert.deepEqual(getAskUserDraft('item-1'), { selected: 'Other', otherText: 'updated' })
})
