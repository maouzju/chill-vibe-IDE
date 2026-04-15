import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheFileTreeNodes,
  clearFileTreeCacheForCard,
  getCachedFileTreeNodes,
  getFileTreeCacheKey,
  shouldFlushTextEditorSave,
} from '../src/components/tool-card-state.ts'

test('file tree cache keys stay isolated per workspace', () => {
  assert.notEqual(
    getFileTreeCacheKey('card-1', 'D:/workspace/a'),
    getFileTreeCacheKey('card-1', 'D:/workspace/b'),
  )
})

test('clearing a file tree card removes cached trees for every workspace copy of that card', () => {
  cacheFileTreeNodes('card-1', 'D:/workspace/a', ['alpha'])
  cacheFileTreeNodes('card-1', 'D:/workspace/b', ['beta'])
  cacheFileTreeNodes('card-2', 'D:/workspace/a', ['gamma'])

  clearFileTreeCacheForCard('card-1')

  assert.equal(getCachedFileTreeNodes('card-1', 'D:/workspace/a'), undefined)
  assert.equal(getCachedFileTreeNodes('card-1', 'D:/workspace/b'), undefined)
  assert.deepEqual(getCachedFileTreeNodes('card-2', 'D:/workspace/a'), ['gamma'])
  clearFileTreeCacheForCard('card-2')
})

test('text editor only flushes when content changed since the last save', () => {
  assert.equal(shouldFlushTextEditorSave('saved text', 'saved text'), false)
  assert.equal(shouldFlushTextEditorSave('saved text', 'edited text'), true)
})
