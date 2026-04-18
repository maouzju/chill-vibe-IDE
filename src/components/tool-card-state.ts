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

export const resolveTextEditorExternalRefresh = (
  savedContent: string,
  content: string,
  diskContent: string,
) => {
  if (shouldFlushTextEditorSave(savedContent, content)) {
    return null
  }

  if (diskContent === savedContent && diskContent === content) {
    return null
  }

  return {
    content: diskContent,
    savedContent: diskContent,
  }
}
