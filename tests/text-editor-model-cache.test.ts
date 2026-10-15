import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cacheTextEditorModel,
  clearTextEditorModelCache,
  evictTextEditorModel,
  getTextEditorModelCacheKey,
  peekCachedTextEditorModel,
  syncClaimedTextEditorModelContent,
  takeCachedTextEditorModel,
  TEXT_EDITOR_MODEL_CACHE_LIMIT,
} from '../src/components/text-editor-model-cache.ts'
import * as modelCache from '../src/components/text-editor-model-cache.ts'

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

test('claimed cached model adopts a disk refresh that finished while Monaco was loading', () => {
  let value = 'stale editor buffer'
  const writes: string[] = []
  const model = {
    getValue: () => value,
    setValue(nextValue: string) {
      writes.push(nextValue)
      value = nextValue
    },
  }

  assert.equal(syncClaimedTextEditorModelContent(model, 'agent updated disk content'), true)
  assert.equal(value, 'agent updated disk content')
  assert.deepEqual(writes, ['agent updated disk content'])

  assert.equal(syncClaimedTextEditorModelContent(model, 'agent updated disk content'), false)
  assert.deepEqual(writes, ['agent updated disk content'])
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

// 2026-10-14 用户报「重命名文件有 bug」：改名后编辑器还拿旧路径的 key 停放模型、
// 卸载时把脏内容存回旧路径。改名要把停放的模型和活着的编辑器一起改挂到新路径。
test('retarget re-keys a parked model to the renamed file without disposing it', () => {
  clearTextEditorModelCache()
  const entry = makeEntry()
  cacheTextEditorModel(getTextEditorModelCacheKey('D:\\ws', 'docs/notes.md'), entry)

  modelCache.retargetTextEditorPaths('d:/ws/', 'docs/notes.md', 'docs/notes-v2.md')

  assert.equal(peekCachedTextEditorModel(getTextEditorModelCacheKey('D:\\ws', 'docs/notes.md')), undefined)
  const moved = peekCachedTextEditorModel(getTextEditorModelCacheKey('D:\\ws', 'docs/notes-v2.md'))
  assert.equal(moved?.model, entry.model)
  assert.equal(moved?.revision, 'rev-1')
  assert.equal(moved?.pathChanged, true, 'the claimer must rebuild the Monaco model under the new URI')
  assert.equal(entry.model.isDisposed(), false)
  clearTextEditorModelCache()
})

test('retarget follows a folder rename for nested models only', () => {
  clearTextEditorModelCache()
  const nested = makeEntry()
  const sibling = makeEntry()
  const otherWorkspace = makeEntry()
  cacheTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'docs/deep/guide.md'), nested)
  cacheTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'docs-old.md'), sibling)
  cacheTextEditorModel(getTextEditorModelCacheKey('D:/other', 'docs/deep/guide.md'), otherWorkspace)

  modelCache.retargetTextEditorPaths('D:/ws', 'docs', 'documentation')

  assert.equal(peekCachedTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'documentation/deep/guide.md'))?.model, nested.model)
  assert.equal(peekCachedTextEditorModel(getTextEditorModelCacheKey('D:/ws', 'docs-old.md')), sibling)
  assert.equal(peekCachedTextEditorModel(getTextEditorModelCacheKey('D:/other', 'docs/deep/guide.md')), otherWorkspace)
  clearTextEditorModelCache()
})

test('retarget marks live editor handles so they stop saving to the old path', () => {
  const renamed = modelCache.registerTextEditorPathHandle('D:/ws', 'docs/notes.md')
  const untouched = modelCache.registerTextEditorPathHandle('D:/ws', 'src/app.ts')
  const released = modelCache.registerTextEditorPathHandle('D:/ws', 'docs/notes.md')
  modelCache.releaseTextEditorPathHandle(released)

  modelCache.retargetTextEditorPaths('D:/ws', 'docs', 'documentation')

  assert.equal(renamed.retargetedFilePath, 'documentation/notes.md')
  assert.equal(untouched.retargetedFilePath, null)
  assert.equal(released.retargetedFilePath, null)
  modelCache.releaseTextEditorPathHandle(renamed)
  modelCache.releaseTextEditorPathHandle(untouched)
})

test('live file path follows a retargeted handle and survives release', () => {
  assert.equal(modelCache.getTextEditorLiveFilePath(null, 'docs/notes.md'), 'docs/notes.md')

  const handle = modelCache.registerTextEditorPathHandle('D:/ws', 'docs/notes.md')
  assert.equal(modelCache.getTextEditorLiveFilePath(handle, 'docs/notes.md'), 'docs/notes.md')

  modelCache.retargetTextEditorPaths('D:/ws', 'docs/notes.md', 'docs/renamed.md')
  // The editor releases its handle before the park/unmount-save cleanups run,
  // so the retargeted path must still be readable afterwards.
  modelCache.releaseTextEditorPathHandle(handle)
  assert.equal(modelCache.getTextEditorLiveFilePath(handle, 'docs/notes.md'), 'docs/renamed.md')
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
