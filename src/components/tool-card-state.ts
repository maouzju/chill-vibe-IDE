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

export type TextEditorSaveIntent =
  | { kind: 'save'; expectedRevision: string }
  | { kind: 'refresh'; content: string; revision: string | null }
  | { kind: 'conflict'; diskContent: string; revision: string | null }
  | { kind: 'blocked-missing-revision' }

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

export type TextEditorSaveConflictResolution =
  | { kind: 'retry'; revision: string }
  | { kind: 'refresh'; content: string; revision: string | null }
  | { kind: 'conflict'; diskContent: string }

// 症状 (2026-11-20 审查): 定时保存 A 在途时失焦 flush 又发保存 B（同一个旧 revision），A 先落盘、B 被判
//   修订号冲突，弹「文件已被外部修改」并停掉自动保存，选「采用磁盘版本」还会吞掉刚打的字。
// 根因: 冲突后重读的磁盘内容等于编辑器基线 savedContent（只是自己上一次保存推进了 revision），
//   resolveTextEditorExternalRefresh 返回 null，调用方把 null 也当冲突。
// 否决: 不改 resolveTextEditorExternalRefresh 本身（syncFileSnapshot 依赖它的 null=无事可做）；只重试一次，防 revision 抖动死循环。
export const resolveTextEditorSaveConflict = ({
  savedContent,
  content,
  diskContent,
  diskRevision,
  retried,
}: {
  savedContent: string
  content: string
  diskContent: string | null
  diskRevision: string | null
  retried: boolean
}): TextEditorSaveConflictResolution => {
  if (diskContent === null) {
    return { kind: 'conflict', diskContent: '' }
  }

  const resolution = resolveTextEditorExternalRefresh(savedContent, content, diskContent)
  if (resolution?.kind === 'refresh') {
    return { kind: 'refresh', content: resolution.content, revision: diskRevision }
  }

  if (resolution === null && diskContent === savedContent && diskRevision && !retried) {
    return { kind: 'retry', revision: diskRevision }
  }

  return { kind: 'conflict', diskContent }
}

export const resolveTextEditorSaveIntent = ({
  savedContent,
  content,
  diskContent,
  diskRevision,
  currentRevision,
}: {
  savedContent: string
  content: string
  diskContent: string | null
  diskRevision: string | null
  currentRevision: string | null
}): TextEditorSaveIntent => {
  if (currentRevision) {
    return { kind: 'save', expectedRevision: currentRevision }
  }

  if (diskContent === null) {
    return { kind: 'blocked-missing-revision' }
  }

  const resolution = resolveTextEditorExternalRefresh(savedContent, content, diskContent)

  if (resolution?.kind === 'refresh') {
    return { kind: 'refresh', content: resolution.content, revision: diskRevision }
  }

  if (resolution?.kind === 'conflict') {
    return { kind: 'conflict', diskContent: resolution.diskContent, revision: diskRevision }
  }

  if (diskRevision) {
    return { kind: 'save', expectedRevision: diskRevision }
  }

  return { kind: 'blocked-missing-revision' }
}
