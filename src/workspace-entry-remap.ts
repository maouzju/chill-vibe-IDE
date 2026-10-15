// Pure helpers for "a workspace entry was renamed / moved" bookkeeping.
// FileTreeCard announces the move once, then App remaps editor tab paths
// (reducer) and the text-editor model cache with exactly the same rules, so
// both sides land on byte-identical paths and cache keys.

export const WORKSPACE_ENTRY_MOVED_EVENT = 'chill-vibe:workspace-entry-moved'

export type WorkspaceEntryMovedDetail = {
  workspacePath: string
  /** Workspace-relative path before the rename/move (file or folder). */
  fromPath: string
  /** Workspace-relative path after the rename/move. */
  toPath: string
}

export const dispatchWorkspaceEntryMoved = (detail: WorkspaceEntryMovedDetail) => {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent<WorkspaceEntryMovedDetail>(WORKSPACE_ENTRY_MOVED_EVENT, { detail }))
}

const normalizeWorkspaceRelativePath = (value: string) => {
  let normalized = value.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/')

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }

  return normalized.replace(/\/+$/, '')
}

const normalizeWorkspaceRoot = (value: string) =>
  value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

export const isSameWorkspacePath = (left: string, right: string) => {
  const normalizedLeft = normalizeWorkspaceRoot(left)
  return normalizedLeft.length > 0 && normalizedLeft === normalizeWorkspaceRoot(right)
}

// Windows workspaces (drive letter, UNC or backslash paths) live on
// case-insensitive file systems, so `Docs/a.md` and `docs/a.md` are one file.
const isCaseInsensitiveWorkspace = (workspacePath: string) => {
  const trimmed = workspacePath.trim()
  return /^[a-z]:/i.test(trimmed) || trimmed.includes('\\')
}

/**
 * Returns the new workspace-relative path for `filePath` after `fromPath`
 * was renamed/moved to `toPath`, or `null` when `filePath` is unaffected.
 * Matches the entry itself and anything nested under it (folder rename).
 */
export const remapWorkspaceEntryPath = (
  workspacePath: string,
  filePath: string,
  fromPath: string,
  toPath: string,
): string | null => {
  const file = normalizeWorkspaceRelativePath(filePath)
  const from = normalizeWorkspaceRelativePath(fromPath)
  const to = normalizeWorkspaceRelativePath(toPath)

  if (!file || !from || !to || file.length < from.length) {
    return null
  }

  const head = file.slice(0, from.length)
  const rest = file.slice(from.length)
  const headMatches = isCaseInsensitiveWorkspace(workspacePath)
    ? head.toLowerCase() === from.toLowerCase()
    : head === from

  if (!headMatches || (rest !== '' && !rest.startsWith('/'))) {
    return null
  }

  const next = `${to}${rest}`
  return next === filePath ? null : next
}

export const getWorkspaceEntryBaseName = (value: string) => {
  const normalized = normalizeWorkspaceRelativePath(value)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
