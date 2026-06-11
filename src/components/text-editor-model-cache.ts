// Module-level cache that keeps Monaco text models (and their undo stacks,
// cursors, and scroll positions) alive across pane tab switches. Entries are
// plain in-memory objects — they must never reach React state or persistence.

type CacheableModel = {
  dispose(): void
  isDisposed(): boolean
}

export type TextEditorModelCacheEntry<
  TModel extends CacheableModel = CacheableModel,
  TViewState = unknown,
> = {
  model: TModel
  viewState: TViewState | null
  revision: string | null
  savedContent: string
  languageId: string
}

export const TEXT_EDITOR_MODEL_CACHE_LIMIT = 12

const modelCache = new Map<string, TextEditorModelCacheEntry>()
const cacheKeySeparator = '\0'

export const getTextEditorModelCacheKey = (workspacePath: string, filePath: string) =>
  `${workspacePath}${cacheKeySeparator}${filePath.trim()}`

export const peekCachedTextEditorModel = (key: string): TextEditorModelCacheEntry | undefined => {
  const entry = modelCache.get(key)

  if (entry && entry.model.isDisposed()) {
    modelCache.delete(key)
    return undefined
  }

  return entry
}

export const takeCachedTextEditorModel = (key: string): TextEditorModelCacheEntry | undefined => {
  const entry = peekCachedTextEditorModel(key)

  if (entry) {
    modelCache.delete(key)
  }

  return entry
}

export const cacheTextEditorModel = (key: string, entry: TextEditorModelCacheEntry) => {
  if (entry.model.isDisposed()) {
    return
  }

  const existing = modelCache.get(key)
  if (existing && existing.model !== entry.model && !existing.model.isDisposed()) {
    existing.model.dispose()
  }

  // Re-insert so the entry moves to the freshest LRU position.
  modelCache.delete(key)
  modelCache.set(key, entry)

  while (modelCache.size > TEXT_EDITOR_MODEL_CACHE_LIMIT) {
    const oldestKey = modelCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }

    const oldest = modelCache.get(oldestKey)
    modelCache.delete(oldestKey)
    if (oldest && !oldest.model.isDisposed()) {
      oldest.model.dispose()
    }
  }
}

export const evictTextEditorModel = (workspacePath: string, filePath: string) => {
  const key = getTextEditorModelCacheKey(workspacePath, filePath)
  const entry = modelCache.get(key)

  if (!entry) {
    return
  }

  modelCache.delete(key)
  if (!entry.model.isDisposed()) {
    entry.model.dispose()
  }
}

export const clearTextEditorModelCache = () => {
  for (const entry of modelCache.values()) {
    if (!entry.model.isDisposed()) {
      entry.model.dispose()
    }
  }

  modelCache.clear()
}
