import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheTextEditorModel,
  clearTextEditorModelCache,
  evictTextEditorModel,
  getTextEditorModelCacheKey,
  peekCachedTextEditorModel,
  takeCachedTextEditorModel,
  TEXT_EDITOR_MODEL_CACHE_LIMIT,
} from '../src/components/text-editor-model-cache.ts'

const makeModel = () => {
  let disposed = false
  return {
    dispose() {
      disposed = true
    },
    isDisposed: () => disposed,
  }
}

const makeEntry = () => ({
  model: makeModel(),
  viewState: null,
  revision: 'rev-1',
  savedContent: 'saved',
  languageId: 'plaintext',
  encoding: 'utf8',
})

test('model cache keys stay isolated per workspace and file', () => {
  assert.notEqual(
    getTextEditorModelCacheKey('D:/ws-a', 'src/a.ts'),
    getTextEditorModelCacheKey('D:/ws-b', 'src/a.ts'),
  )
  assert.notEqual(
    getTextEditorModelCacheKey('D:/ws-a', 'src/a.ts'),
    getTextEditorModelCacheKey('D:/ws-a', 'src/b.ts'),
  )
})

test('take removes the entry so a second consumer cannot share the model', () => {
  clearTextEditorModelCache()
  const key = getTextEditorModelCacheKey('D:/ws', 'a.ts')
  const entry = makeEntry()

  cacheTextEditorModel(key, entry)

  assert.equal(takeCachedTextEditorModel(key), entry)
  assert.equal(takeCachedTextEditorModel(key), undefined)
  assert.equal(entry.model.isDisposed(), false)
})

test('peek returns the entry without removing it', () => {
  clearTextEditorModelCache()
  const key = getTextEditorModelCacheKey('D:/ws', 'a.ts')
  const entry = makeEntry()

  cacheTextEditorModel(key, entry)

  assert.equal(peekCachedTextEditorModel(key), entry)
  assert.equal(peekCachedTextEditorModel(key), entry)
  assert.equal(takeCachedTextEditorModel(key), entry)
  clearTextEditorModelCache()
})

test('cache evicts the least recently used model once the limit is exceeded', () => {
  clearTextEditorModelCache()
  const entries = Array.from({ length: TEXT_EDITOR_MODEL_CACHE_LIMIT + 1 }, (_, index) => ({
    key: getTextEditorModelCacheKey('D:/ws', `file-${index}.ts`),
    entry: makeEntry(),
  }))

  for (const { key, entry } of entries) {
    cacheTextEditorModel(key, entry)
  }

  assert.equal(entries[0].entry.model.isDisposed(), true)
  assert.equal(peekCachedTextEditorModel(entries[0].key), undefined)
  assert.equal(entries[1].entry.model.isDisposed(), false)
  assert.equal(peekCachedTextEditorModel(entries.at(-1)!.key), entries.at(-1)!.entry)
  clearTextEditorModelCache()
})

test('re-caching a key refreshes its LRU position', () => {
  clearTextEditorModelCache()
  const first = { key: getTextEditorModelCacheKey('D:/ws', 'file-0.ts'), entry: makeEntry() }
  cacheTextEditorModel(first.key, first.entry)

  for (let index = 1; index < TEXT_EDITOR_MODEL_CACHE_LIMIT; index += 1) {
    cacheTextEditorModel(getTextEditorModelCacheKey('D:/ws', `file-${index}.ts`), makeEntry())
  }

  // Touch the oldest entry by taking it and putting it back.
  const taken = takeCachedTextEditorModel(first.key)
  assert.ok(taken)
  cacheTextEditorModel(first.key, taken)

  // Adding one more should now evict file-1, not file-0.
  cacheTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'file-extra.ts'), makeEntry())

  assert.equal(peekCachedTextEditorModel(first.key), taken)
  assert.equal(peekCachedTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'file-1.ts')), undefined)
  assert.equal(first.entry.model.isDisposed(), false)
  clearTextEditorModelCache()
})

test('evict disposes the model and removes the entry', () => {
  clearTextEditorModelCache()
  const key = getTextEditorModelCacheKey('D:/ws', 'a.ts')
  const entry = makeEntry()

  cacheTextEditorModel(key, entry)
  evictTextEditorModel('D:/ws', 'a.ts')

  assert.equal(entry.model.isDisposed(), true)
  assert.equal(peekCachedTextEditorModel(key), undefined)
})

test('caching over an existing key disposes the replaced model but never the same model', () => {
  clearTextEditorModelCache()
  const key = getTextEditorModelCacheKey('D:/ws', 'a.ts')
  const original = makeEntry()
  const replacement = makeEntry()

  cacheTextEditorModel(key, original)
  cacheTextEditorModel(key, replacement)
  assert.equal(original.model.isDisposed(), true)
  assert.equal(replacement.model.isDisposed(), false)

  // Re-caching the same model (StrictMode double mount) must not dispose it.
  cacheTextEditorModel(key, replacement)
  assert.equal(replacement.model.isDisposed(), false)
  clearTextEditorModelCache()
})

test('disposed models are rejected instead of cached', () => {
  clearTextEditorModelCache()
  const key = getTextEditorModelCacheKey('D:/ws', 'a.ts')
  const entry = makeEntry()
  entry.model.dispose()

  cacheTextEditorModel(key, entry)

  assert.equal(peekCachedTextEditorModel(key), undefined)
})

test('clear disposes every cached model', () => {
  clearTextEditorModelCache()
  const first = makeEntry()
  const second = makeEntry()

  cacheTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'a.ts'), first)
  cacheTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'b.ts'), second)
  clearTextEditorModelCache()

  assert.equal(first.model.isDisposed(), true)
  assert.equal(second.model.isDisposed(), true)
})
