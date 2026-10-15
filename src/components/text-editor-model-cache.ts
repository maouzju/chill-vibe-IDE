// Module-level cache that keeps Monaco text models (and their undo stacks,
// cursors, and scroll positions) alive across pane tab switches. Entries are
// plain in-memory objects — they must never reach React state or persistence.

import { isSameWorkspacePath, remapWorkspaceEntryPath } from '../workspace-entry-remap'

type CacheableModel = {
  dispose(): void
  isDisposed(): boolean
}

type ContentModel = {
  getValue(): string
  setValue(value: string): void
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
  /** Detected file encoding id from the last read; echoed back on saves. */
  encoding: string | null
  /**
   * Set when the file was renamed/moved while this model was parked or live:
   * the model still carries the old file URI, so the claimer must rebuild it
   * under the new path (keeping the buffer) instead of adopting it as-is.
   */
  pathChanged?: boolean
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

export const syncClaimedTextEditorModelContent = (
  model: ContentModel,
  currentContent: string,
) => {
  if (model.getValue() === currentContent) {
    return false
  }

  // A disk refresh can finish while Monaco is still lazy-loading. The React
  // refs then hold the fresh snapshot while the claimed cached model still
  // holds stale text. Reconcile before content listeners/autosave are attached.
  model.setValue(currentContent)
  return true
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

/**
 * A mounted editor's claim on its file path. When the file is renamed/moved
 * the handle is retargeted, so the unmounting editor parks its model under the
 * new path and stops saving to the old one.
 */
export type TextEditorPathHandle = {
  readonly workspacePath: string
  readonly filePath: string
  retargetedFilePath: string | null
}

const liveHandles = new Set<TextEditorPathHandle>()

export const registerTextEditorPathHandle = (workspacePath: string, filePath: string): TextEditorPathHandle => {
  const handle: TextEditorPathHandle = { workspacePath, filePath: filePath.trim(), retargetedFilePath: null }
  liveHandles.add(handle)
  return handle
}

export const releaseTextEditorPathHandle = (handle: TextEditorPathHandle) => {
  liveHandles.delete(handle)
}

/** Current on-disk path for an editor: the renamed path once retargeted, else its mount path. */
export const getTextEditorLiveFilePath = (handle: TextEditorPathHandle | null, fallbackFilePath: string) =>
  handle?.retargetedFilePath ?? fallbackFilePath

// 症状 (2026-10-14): 文件改名后编辑器 tab 跟到新路径时，脏内容/撤销栈仍停在旧路径的 key 下，
//   旧编辑器卸载时还会把内容存回旧路径。
// 根因: 缓存 key 与卸载保存都绑死在挂载时的 filePath 上。
// 为什么必须在 dispatch 改 tab 路径之前调用: React 先跑旧实例的卸载清理（停放模型 + 卸载保存）
//   再跑新实例的挂载，句柄要在那之前就指向新路径。
export const retargetTextEditorPaths = (workspacePath: string, fromPath: string, toPath: string) => {
  const moves: Array<{ fromKey: string; toKey: string; entry: TextEditorModelCacheEntry }> = []

  for (const [key, entry] of modelCache) {
    const separatorIndex = key.indexOf(cacheKeySeparator)
    const entryWorkspacePath = key.slice(0, separatorIndex)
    if (separatorIndex < 0 || !isSameWorkspacePath(entryWorkspacePath, workspacePath)) {
      continue
    }

    const nextFilePath = remapWorkspaceEntryPath(
      entryWorkspacePath,
      key.slice(separatorIndex + cacheKeySeparator.length),
      fromPath,
      toPath,
    )
    if (nextFilePath !== null) {
      moves.push({ fromKey: key, toKey: getTextEditorModelCacheKey(entryWorkspacePath, nextFilePath), entry })
    }
  }

  for (const { fromKey } of moves) {
    modelCache.delete(fromKey)
  }

  for (const { toKey, entry } of moves) {
    cacheTextEditorModel(toKey, { ...entry, pathChanged: true })
  }

  for (const handle of liveHandles) {
    if (!isSameWorkspacePath(handle.workspacePath, workspacePath)) {
      continue
    }

    const nextFilePath = remapWorkspaceEntryPath(
      handle.workspacePath,
      handle.retargetedFilePath ?? handle.filePath,
      fromPath,
      toPath,
    )
    if (nextFilePath !== null) {
      handle.retargetedFilePath = nextFilePath
    }
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
