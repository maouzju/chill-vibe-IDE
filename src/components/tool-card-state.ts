const fileTreeCache = new Map<string, unknown>()
const fileTreeCacheSeparator = '\0'

export const getFileTreeCacheKey = (cardId: string, workspacePath: string) =>
  `${workspacePath}${fileTreeCacheSeparator}${cardId}`

export const getCachedFileTreeNodes = <T>(cardId: string, workspacePath: string) =>
  fileTreeCache.get(getFileTreeCacheKey(cardId, workspacePath)) as T | undefined

export const cacheFileTreeNodes = <T>(cardId: string, workspacePath: string, nodes: T) => {
  fileTreeCache.set(getFileTreeCacheKey(cardId, workspacePath), nodes)
}

export const clearFileTreeCacheEntry = (cardId: string, workspacePath: string) => {
  fileTreeCache.delete(getFileTreeCacheKey(cardId, workspacePath))
}

export const clearFileTreeCacheForCard = (cardId: string) => {
  const suffix = `${fileTreeCacheSeparator}${cardId}`

  for (const key of fileTreeCache.keys()) {
    if (key.endsWith(suffix)) {
      fileTreeCache.delete(key)
    }
  }
}

export const shouldFlushTextEditorSave = (savedContent: string, content: string) =>
  savedContent !== content

export type TextEditorRefreshResolution =
  | { kind: 'refresh'; content: string }
  | { kind: 'conflict'; diskContent: string }
  | null

export const resolveTextEditorExternalRefresh = (
  savedContent: string,
  content: string,
  diskContent: string,
): TextEditorRefreshResolution => {
  if (shouldFlushTextEditorSave(savedContent, content)) {
    // The disk caught up with the local buffer — treat it as an external save.
    if (diskContent === content) {
      return { kind: 'refresh', content: diskContent }
    }

    // Local edits and external edits diverged; never silently drop either side.
    if (diskContent !== savedContent) {
      return { kind: 'conflict', diskContent }
    }

    return null
  }

  if (diskContent === savedContent && diskContent === content) {
    return null
  }

  return { kind: 'refresh', content: diskContent }
}
