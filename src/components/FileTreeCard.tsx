import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'

import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  fetchFileList,
  moveWorkspaceEntry,
  openMessageLocalLink,
  renameWorkspaceEntry,
  searchFiles,
} from '../api'
import { clearDragPayload, readDragPayload, writeDragPayload } from '../dnd'
import type { AppLanguage, FileEntry, FileSearchEntry } from '../../shared/schema'
import { resolveFileTreeMoveDestination } from './file-tree-dnd'
import {
  applyRefreshedFileTreeDirectories,
  attachFileTreeAutoRefreshTriggers,
  collectExpandedFileTreeDirectoryPaths,
} from './file-tree-refresh'
import {
  cacheFileTreeNodes,
  clearFileTreeCacheEntry,
  getCachedFileTreeNodes,
  getFileTreeCacheKey,
} from './tool-card-state'
import { getFileTreeCardText } from './tool-card-text'

type FileTreeCardProps = {
  cardId: string
  workspacePath: string
  language: AppLanguage
  onOpenFile: (relativePath: string) => void
}

type TreeNode = FileEntry & {
  path: string
  children?: TreeNode[]
  loaded?: boolean
  expanded?: boolean
}

type ContextMenuTarget = {
  source: 'tree' | 'search'
  path: string
  name: string
  isDirectory: boolean
  expanded?: boolean
}

type ContextMenuAction = {
  key: string
  label: string
  danger?: boolean
}

type FileTreeDropTarget = {
  path: string
  isDirectory: boolean
} | null

type FileTreeMutationDetail = {
  workspacePath: string
  sourceParentRelativePath: string
  destinationParentRelativePath: string
}

const fileTreeMutationEventName = 'chill-vibe:file-tree-mutation'

const normalizeWorkspaceKey = (value: string) => value.trim().toLowerCase()

const dispatchFileTreeMutation = (detail: FileTreeMutationDetail) => {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(
    new CustomEvent<FileTreeMutationDetail>(fileTreeMutationEventName, {
      detail,
    }),
  )
}

const FileIcon = () => (
  <svg className="file-tree-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
    <path d="M3.5 1A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 12.5 4H9.5L8 1.5A1 1 0 0 0 7.2 1H3.5zM3 2.5a.5.5 0 0 1 .5-.5h3.7l1.5 2.5a1 1 0 0 0 .8.5h3a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-11z" />
  </svg>
)

const TreeFolderIcon = () => (
  <svg className="file-tree-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
    <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.658.658A.5.5 0 0 0 7.744 3.25H13.5A1.5 1.5 0 0 1 15 4.75v7.75a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" />
  </svg>
)

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    className={`file-tree-chevron${expanded ? ' is-expanded' : ''}`}
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="currentColor"
  >
    <path d="M6 4l4 4-4 4" />
  </svg>
)

const TreeItem = ({
  node,
  depth,
  dropTargetPath,
  onToggle,
  onSelect,
  onContextMenu,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  node: TreeNode
  depth: number
  dropTargetPath: string | null
  onToggle: (node: TreeNode) => void
  onSelect: (path: string) => void
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, target: ContextMenuTarget) => void
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragEnter: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragOver: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragLeave: (event: ReactDragEvent<HTMLButtonElement>, path: string) => void
  onDrop: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragEnd: () => void
}) => {
  return (
    <>
      <button
        type="button"
        className={`file-tree-item${node.isDirectory ? ' is-directory' : ''}${dropTargetPath === node.path ? ' is-drop-target' : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        draggable
        onContextMenu={(event) =>
          onContextMenu(event, {
            source: 'tree',
            path: node.path,
            name: node.name,
            isDirectory: node.isDirectory,
            expanded: node.expanded,
          })}
        onDragStart={(event) => onDragStart(event, { path: node.path, isDirectory: node.isDirectory })}
        onDragEnter={(event) => onDragEnter(event, { path: node.path, isDirectory: node.isDirectory })}
        onDragOver={(event) => onDragOver(event, { path: node.path, isDirectory: node.isDirectory })}
        onDragLeave={(event) => onDragLeave(event, node.path)}
        onDrop={(event) => onDrop(event, { path: node.path, isDirectory: node.isDirectory })}
        onDragEnd={onDragEnd}
        onClick={() => {
          if (node.isDirectory) {
            onToggle(node)
          } else {
            onSelect(node.path)
          }
        }}
      >
        {node.isDirectory ? (
          <>
            <ChevronIcon expanded={!!node.expanded} />
            <TreeFolderIcon />
          </>
        ) : (
          <>
            <span className="file-tree-chevron-spacer" />
            <FileIcon />
          </>
        )}
        <span className="file-tree-name">{node.name}</span>
      </button>
      {node.isDirectory && node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          dropTargetPath={dropTargetPath}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
        />
      ))}
    </>
  )
}

const SearchResultItem = ({
  entry,
  dropTargetPath,
  onSelect,
  onContextMenu,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  entry: FileSearchEntry
  dropTargetPath: string | null
  onSelect: (path: string) => void
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, target: ContextMenuTarget) => void
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragEnter: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragOver: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragLeave: (event: ReactDragEvent<HTMLButtonElement>, path: string) => void
  onDrop: (event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => void
  onDragEnd: () => void
}) => {
  const lastSlashIndex = entry.path.lastIndexOf('/')
  const parentPath = lastSlashIndex === -1 ? '' : entry.path.slice(0, lastSlashIndex)

  return (
    <button
      type="button"
      className={`file-tree-search-result${dropTargetPath === entry.path ? ' is-drop-target' : ''}`}
      draggable
      onClick={() => onSelect(entry.path)}
      onContextMenu={(event) =>
        onContextMenu(event, {
          source: 'search',
          path: entry.path,
          name: entry.name,
          isDirectory: entry.isDirectory,
        })}
      onDragStart={(event) => onDragStart(event, { path: entry.path, isDirectory: entry.isDirectory })}
      onDragEnter={(event) => onDragEnter(event, { path: entry.path, isDirectory: entry.isDirectory })}
      onDragOver={(event) => onDragOver(event, { path: entry.path, isDirectory: entry.isDirectory })}
      onDragLeave={(event) => onDragLeave(event, entry.path)}
      onDrop={(event) => onDrop(event, { path: entry.path, isDirectory: entry.isDirectory })}
      onDragEnd={onDragEnd}
      title={entry.path}
    >
      <FileIcon />
      <span className="file-tree-search-result-copy">
        <span className="file-tree-search-result-name">{entry.name}</span>
        {parentPath ? <span className="file-tree-search-result-path">{parentPath}</span> : null}
      </span>
    </button>
  )
}

const normalizeSearchQuery = (value: string) => value.trim().toLowerCase()

const getRelativeParentPath = (relativePath: string) => {
  const lastSlashIndex = relativePath.lastIndexOf('/')
  return lastSlashIndex === -1 ? '' : relativePath.slice(0, lastSlashIndex)
}

const joinRelativePath = (parentRelativePath: string, name: string) =>
  parentRelativePath ? `${parentRelativePath}/${name}` : name

const resolveAbsolutePath = (workspacePath: string, relativePath: string) => {
  const separator = workspacePath.includes('\\') ? '\\' : '/'
  const normalizedWorkspace = workspacePath.replace(/[\\/]+$/, '')
  const normalizedRelativePath = relativePath.replace(/\//g, separator)

  return normalizedRelativePath
    ? `${normalizedWorkspace}${separator}${normalizedRelativePath}`
    : normalizedWorkspace
}

const getActionText = (language: AppLanguage) => ({
  open: language === 'en' ? 'Open' : '打开',
  expand: language === 'en' ? 'Expand' : '展开',
  collapse: language === 'en' ? 'Collapse' : '折叠',
  newFile: language === 'en' ? 'New File…' : '新建文件…',
  newFolder: language === 'en' ? 'New Folder…' : '新建文件夹…',
  rename: language === 'en' ? 'Rename…' : '重命名…',
  delete: language === 'en' ? 'Delete…' : '删除…',
  copyRelativePath: language === 'en' ? 'Copy Relative Path' : '复制相对路径',
  copyAbsolutePath: language === 'en' ? 'Copy Absolute Path' : '复制绝对路径',
  revealInSystem: language === 'en' ? 'Show in System' : '在系统中显示',
  refresh: language === 'en' ? 'Refresh' : '刷新',
  promptNewFile: language === 'en' ? 'New file name' : '新文件名',
  promptNewFolder: language === 'en' ? 'New folder name' : '新文件夹名',
  promptRename: language === 'en' ? 'Rename to' : '重命名为',
  confirmDelete: (name: string) =>
    language === 'en'
      ? `Delete "${name}"?`
      : `确认删除“${name}”吗？`,
  clipboardUnavailable:
    language === 'en'
      ? 'Clipboard is unavailable in this environment.'
      : '当前环境暂不支持剪贴板。',
  genericError:
    language === 'en'
      ? 'The file action failed.'
      : '文件操作失败。',
})

const FileTreeCardInner = ({ cardId, workspacePath, language, onOpenFile }: FileTreeCardProps) => {
  const text = getFileTreeCardText(language)
  const actionText = getActionText(language)
  const cached = getCachedFileTreeNodes<TreeNode[]>(cardId, workspacePath)
  const [nodes, setNodes] = useState<TreeNode[]>(() => cached ?? [])
  const [loading, setLoading] = useState(() => cached === undefined)
  const [error, setError] = useState<string | null>(null)
  const [hasLoadedRoot, setHasLoadedRoot] = useState(() => cached !== undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [searchResults, setSearchResults] = useState<FileSearchEntry[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchRevision, setSearchRevision] = useState(0)
  const [contextMenu, setContextMenu] = useState<{
    target: ContextMenuTarget
    x: number
    y: number
  } | null>(null)
  const [contextMenuPosition, setContextMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  const mountedRef = useRef(true)
  const searchCacheRef = useRef(new Map<string, FileSearchEntry[]>())
  const contextMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (hasLoadedRoot) {
      cacheFileTreeNodes(cardId, workspacePath, nodes)
    }
  }, [cardId, hasLoadedRoot, nodes, workspacePath])

  const loadDirectory = useCallback(async (relativePath: string): Promise<TreeNode[]> => {
    const entries = await fetchFileList(workspacePath, relativePath)
    return entries.map((entry) => ({
      ...entry,
      path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      children: entry.isDirectory ? [] : undefined,
      loaded: false,
      expanded: false,
    }))
  }, [workspacePath])

  const refreshSearch = useCallback(() => {
    const normalizedQuery = normalizeSearchQuery(searchQuery)

    if (!normalizedQuery) {
      return
    }

    searchCacheRef.current.delete(normalizedQuery)
    setSearchLoading(true)
    setSearchError(null)
    setSearchRevision((current) => current + 1)
  }, [searchQuery])

  const refreshVisibleTree = useCallback(async () => {
    const visibleDirectoryPaths = ['', ...collectExpandedFileTreeDirectoryPaths(nodes)]
    const uniqueDirectoryPaths = [...new Set(visibleDirectoryPaths)]
    const refreshedEntries = await Promise.all(
      uniqueDirectoryPaths.map(async (relativePath) => {
        try {
          return [relativePath, await loadDirectory(relativePath)] as const
        } catch (error) {
          if (!relativePath) {
            throw error
          }

          return null
        }
      }),
    )

    if (!mountedRef.current) {
      return
    }

    const refreshedByPath = new Map(
      refreshedEntries.flatMap((entry) => (entry ? [entry] : [])),
    )

    setNodes((currentNodes) => applyRefreshedFileTreeDirectories(currentNodes, refreshedByPath))
    setHasLoadedRoot(true)
    setLoading(false)
    setError(null)
  }, [loadDirectory, nodes])

  const clearDropState = useCallback(() => {
    setDropTargetPath(null)
    setRootDropActive(false)
  }, [])

  useEffect(() => {
    if (cached !== undefined) return

    let cancelled = false

    loadDirectory('')
      .then((result) => {
        if (!cancelled && mountedRef.current) {
          setNodes(result)
          setHasLoadedRoot(true)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled && mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load files')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [cached, loadDirectory])

  const updateSearchQuery = useCallback((nextValue: string) => {
    setSearchQuery(nextValue)

    const normalizedQuery = normalizeSearchQuery(nextValue)

    if (normalizedQuery.length === 0) {
      setSearchResults([])
      setSearchLoading(false)
      setSearchError(null)
      return
    }

    const cachedResults = searchCacheRef.current.get(normalizedQuery)

    if (cachedResults) {
      setSearchResults(cachedResults)
      setSearchLoading(false)
      setSearchError(null)
      return
    }

    setSearchResults([])
    setSearchLoading(true)
    setSearchError(null)
  }, [])

  useEffect(() => {
    const normalizedQuery = normalizeSearchQuery(deferredSearchQuery)

    if (normalizedQuery.length === 0) {
      return
    }

    if (searchCacheRef.current.has(normalizedQuery)) {
      return
    }

    let cancelled = false

    searchFiles(workspacePath, normalizedQuery)
      .then((result) => {
        if (cancelled || !mountedRef.current) {
          return
        }

        searchCacheRef.current.set(normalizedQuery, result)
        setSearchResults(result)
        setSearchLoading(false)
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) {
          return
        }

        setSearchError(err instanceof Error ? err.message : 'Failed to search files')
        setSearchLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [deferredSearchQuery, searchRevision, workspacePath])

  const toggleDirectory = useCallback(async (targetPath: string) => {
    const target = findTreeNode(nodes, targetPath)

    if (!target?.isDirectory) {
      return
    }

    if (target.expanded) {
      setNodes((prev) => updateTree(prev, target.path, (node) => ({ ...node, expanded: false })))
      return
    }

    if (!target.loaded) {
      try {
        const children = await loadDirectory(target.path)
        if (mountedRef.current) {
          setNodes((prev) =>
            updateTree(prev, target.path, (node) => ({
              ...node,
              expanded: true,
              loaded: true,
              children: mergeTreeNodes(node.children ?? [], children),
            })),
          )
        }
      } catch {
        // Silently fail; the directory may be inaccessible.
      }
    } else {
      setNodes((prev) => updateTree(prev, target.path, (node) => ({ ...node, expanded: true })))
    }
  }, [loadDirectory, nodes])

  const toggleNode = useCallback(async (target: TreeNode) => {
    if (!target.isDirectory) return
    await toggleDirectory(target.path)
  }, [toggleDirectory])

  useEffect(() => {
    if (!contextMenu) {
      return
    }

    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null)
        setContextMenuPosition(null)
      }
    }
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
        setContextMenuPosition(null)
      }
    }

    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu) {
      return
    }

    const menu = contextMenuRef.current

    if (!menu) {
      return
    }

    const rect = menu.getBoundingClientRect()
    const left = Math.min(Math.max(contextMenu.x, 8), Math.max(8, window.innerWidth - rect.width - 8))
    const top = Math.min(Math.max(contextMenu.y, 8), Math.max(8, window.innerHeight - rect.height - 8))

    setContextMenuPosition((current) =>
      current && current.left === left && current.top === top ? current : { left, top },
    )
  }, [contextMenu])

  const handleContextMenuOpen = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    target: ContextMenuTarget,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ target, x: event.clientX, y: event.clientY })
    setContextMenuPosition({ left: event.clientX, top: event.clientY })
  }, [])

  const reportActionError = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : actionText.genericError
    window.alert(message)
  }, [actionText.genericError])

  const copyText = useCallback(async (value: string) => {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      throw new Error(actionText.clipboardUnavailable)
    }

    await navigator.clipboard.writeText(value)
  }, [actionText.clipboardUnavailable])

  const clearSearchCache = useCallback(() => {
    searchCacheRef.current.clear()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleMutation = (event: Event) => {
      const detail = (event as CustomEvent<FileTreeMutationDetail>).detail

      if (!detail) {
        return
      }

      if (normalizeWorkspaceKey(detail.workspacePath) !== normalizeWorkspaceKey(workspacePath)) {
        return
      }

      clearSearchCache()

      if (normalizeSearchQuery(searchQuery).length > 0) {
        refreshSearch()
      }

      void refreshVisibleTree().catch(() => undefined)
    }

    window.addEventListener(fileTreeMutationEventName, handleMutation as EventListener)
    return () => {
      window.removeEventListener(fileTreeMutationEventName, handleMutation as EventListener)
    }
  }, [clearSearchCache, refreshSearch, refreshVisibleTree, searchQuery, workspacePath])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const triggerRefresh = () => {
      clearSearchCache()

      if (normalizeSearchQuery(searchQuery).length > 0) {
        refreshSearch()
      }

      void refreshVisibleTree().catch(() => undefined)
    }

    return attachFileTreeAutoRefreshTriggers({
      win: window,
      doc: document,
      onRefresh: triggerRefresh,
    })
  }, [clearSearchCache, refreshSearch, refreshVisibleTree, searchQuery])

  const hasSearchQuery = normalizeSearchQuery(searchQuery).length > 0

  const contextMenuActions: ContextMenuAction[] = []

  if (contextMenu) {
    const { target } = contextMenu

    contextMenuActions.push(
      target.isDirectory
        ? {
            key: 'toggle',
            label: target.expanded ? actionText.collapse : actionText.expand,
          }
        : {
            key: 'open',
            label: actionText.open,
          },
    )

    if (target.isDirectory) {
      contextMenuActions.push(
        {
          key: 'new-file',
          label: actionText.newFile,
        },
        {
          key: 'new-folder',
          label: actionText.newFolder,
        },
      )
    }

    contextMenuActions.push(
      {
        key: 'copy-relative',
        label: actionText.copyRelativePath,
      },
      {
        key: 'copy-absolute',
        label: actionText.copyAbsolutePath,
      },
      {
        key: 'reveal',
        label: actionText.revealInSystem,
      },
      {
        key: 'rename',
        label: actionText.rename,
      },
      {
        key: 'refresh',
        label: actionText.refresh,
      },
      {
        key: 'delete',
        label: actionText.delete,
        danger: true,
      },
    )
  }

  const runContextMenuAction = useCallback(async (key: string) => {
    const target = contextMenu?.target

    if (!target) {
      return
    }

    const parentRelativePath = getRelativeParentPath(target.path)

    switch (key) {
      case 'toggle':
        await toggleDirectory(target.path)
        return
      case 'open':
        onOpenFile(target.path)
        return
      case 'new-file': {
        const nextName = window.prompt(actionText.promptNewFile, '')
        const trimmedName = nextName?.trim()

        if (!trimmedName) {
          return
        }

        await createWorkspaceFile(workspacePath, target.path, trimmedName)
        dispatchFileTreeMutation({
          workspacePath,
          sourceParentRelativePath: target.path,
          destinationParentRelativePath: target.path,
        })
        onOpenFile(joinRelativePath(target.path, trimmedName))
        return
      }
      case 'new-folder': {
        const nextName = window.prompt(actionText.promptNewFolder, '')
        const trimmedName = nextName?.trim()

        if (!trimmedName) {
          return
        }

        await createWorkspaceDirectory(workspacePath, target.path, trimmedName)
        dispatchFileTreeMutation({
          workspacePath,
          sourceParentRelativePath: target.path,
          destinationParentRelativePath: target.path,
        })
        return
      }
      case 'copy-relative':
        await copyText(target.path)
        return
      case 'copy-absolute':
        await copyText(resolveAbsolutePath(workspacePath, target.path))
        return
      case 'reveal':
        await openMessageLocalLink(target.path, workspacePath)
        return
      case 'rename': {
        const nextName = window.prompt(actionText.promptRename, target.name)
        const trimmedName = nextName?.trim()

        if (!trimmedName || trimmedName === target.name) {
          return
        }

        await renameWorkspaceEntry(workspacePath, target.path, trimmedName)
        dispatchFileTreeMutation({
          workspacePath,
          sourceParentRelativePath: parentRelativePath,
          destinationParentRelativePath: parentRelativePath,
        })
        return
      }
      case 'refresh':
        await refreshVisibleTree()
        if (hasSearchQuery) {
          clearSearchCache()
          refreshSearch()
        }
        return
      case 'delete':
        if (!window.confirm(actionText.confirmDelete(target.name))) {
          return
        }

        await deleteWorkspaceEntry(workspacePath, target.path)
        dispatchFileTreeMutation({
          workspacePath,
          sourceParentRelativePath: parentRelativePath,
          destinationParentRelativePath: parentRelativePath,
        })
        return
      default:
        return
    }
  }, [
    actionText,
    clearSearchCache,
    contextMenu,
    copyText,
    hasSearchQuery,
    onOpenFile,
    refreshSearch,
    refreshVisibleTree,
    toggleDirectory,
    workspacePath,
  ])

  const handleItemDragStart = useCallback((event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => {
    if (!target) {
      return
    }

    writeDragPayload(event, {
      type: 'file-tree-entry',
      workspacePath,
      relativePath: target.path,
      isDirectory: target.isDirectory,
    })
    setDropTargetPath(null)
    setRootDropActive(false)
  }, [workspacePath])

  const applyDropTargetPreview = useCallback((
    event: ReactDragEvent<HTMLElement>,
    target: FileTreeDropTarget,
  ) => {
    const payload = readDragPayload(event)

    if (payload?.type !== 'file-tree-entry') {
      return false
    }

    const moveDestination = resolveFileTreeMoveDestination({
      source: {
        workspacePath: payload.workspacePath,
        relativePath: payload.relativePath,
        isDirectory: payload.isDirectory,
      },
      targetWorkspacePath: workspacePath,
      target,
    })

    if (!moveDestination) {
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetPath(target?.path ?? null)
    setRootDropActive(target === null)
    return true
  }, [workspacePath])

  const handleItemDragEnter = useCallback((event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => {
    void applyDropTargetPreview(event, target)
  }, [applyDropTargetPreview])

  const handleItemDragOver = useCallback((event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => {
    void applyDropTargetPreview(event, target)
  }, [applyDropTargetPreview])

  const handleRootDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    void applyDropTargetPreview(event, null)
  }, [applyDropTargetPreview])

  const handleRootDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    void applyDropTargetPreview(event, null)
  }, [applyDropTargetPreview])

  const handleItemDragLeave = useCallback((event: ReactDragEvent<HTMLButtonElement>, path: string) => {
    const nextTarget = event.relatedTarget

    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return
    }

    if (dropTargetPath === path) {
      setDropTargetPath(null)
    }
  }, [dropTargetPath])

  const handleRootDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget

    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return
    }

    clearDropState()
  }, [clearDropState])

  const completeMove = useCallback(async (event: ReactDragEvent<HTMLElement>, target: FileTreeDropTarget) => {
    const payload = readDragPayload(event)

    clearDropState()
    clearDragPayload()

    if (payload?.type !== 'file-tree-entry') {
      return
    }

    const moveDestination = resolveFileTreeMoveDestination({
      source: {
        workspacePath: payload.workspacePath,
        relativePath: payload.relativePath,
        isDirectory: payload.isDirectory,
      },
      targetWorkspacePath: workspacePath,
      target,
    })

    if (!moveDestination) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    await moveWorkspaceEntry(payload.workspacePath, payload.relativePath, moveDestination.destinationParentRelativePath)

    dispatchFileTreeMutation({
      workspacePath: payload.workspacePath,
      sourceParentRelativePath: getRelativeParentPath(payload.relativePath),
      destinationParentRelativePath: moveDestination.destinationParentRelativePath,
    })
  }, [clearDropState, workspacePath])

  const handleItemDrop = useCallback((event: ReactDragEvent<HTMLButtonElement>, target: FileTreeDropTarget) => {
    event.preventDefault()
    event.stopPropagation()
    void completeMove(event, target).catch(reportActionError)
  }, [completeMove, reportActionError])

  const handleRootDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void completeMove(event, null).catch(reportActionError)
  }, [completeMove, reportActionError])

  const handleDragEnd = useCallback(() => {
    clearDropState()
    clearDragPayload()
  }, [clearDropState])

  return (
    <div className="file-tree-card">
      <div className="file-tree-toolbar">
        <input
          className="control file-tree-search-input"
          type="search"
          value={searchQuery}
          onChange={(event) => updateSearchQuery(event.target.value)}
          placeholder={text.searchPlaceholder}
          aria-label={text.searchLabel}
        />
        {hasSearchQuery ? (
          <button
            type="button"
            className="file-tree-search-clear"
            onClick={() => updateSearchQuery('')}
            aria-label={text.clearSearch}
          >
            {text.clearSearch}
          </button>
        ) : null}
      </div>
      <div
        className={`file-tree-body${rootDropActive ? ' is-drop-target' : ''}`}
        onDragEnter={handleRootDragEnter}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {hasSearchQuery ? (
          searchLoading ? (
            <div className="file-tree-loading">{text.searching}</div>
          ) : searchError ? (
            <div className="file-tree-error">{searchError}</div>
          ) : searchResults.length === 0 ? (
            <div className="file-tree-empty">{text.emptySearch}</div>
          ) : (
            <div className="file-tree-search-results">
              {searchResults.map((entry) => (
                <SearchResultItem
                  key={entry.path}
                  entry={entry}
                  dropTargetPath={dropTargetPath}
                  onSelect={onOpenFile}
                  onContextMenu={handleContextMenuOpen}
                  onDragStart={handleItemDragStart}
                  onDragEnter={handleItemDragEnter}
                  onDragOver={handleItemDragOver}
                  onDragLeave={handleItemDragLeave}
                  onDrop={handleItemDrop}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </div>
          )
        ) : loading ? (
          <div className="file-tree-loading">{text.loading}</div>
        ) : error ? (
          <div className="file-tree-error">{error}</div>
        ) : (
          <div className="file-tree-list">
            {nodes.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                dropTargetPath={dropTargetPath}
                onToggle={toggleNode}
                onSelect={onOpenFile}
                onContextMenu={handleContextMenuOpen}
                onDragStart={handleItemDragStart}
                onDragEnter={handleItemDragEnter}
                onDragOver={handleItemDragOver}
                onDragLeave={handleItemDragLeave}
                onDrop={handleItemDrop}
                onDragEnd={handleDragEnd}
              />
            ))}
          </div>
        )}
      </div>
      {contextMenu && contextMenuPosition && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="pane-tab-context-menu"
              style={{ left: contextMenuPosition.left, top: contextMenuPosition.top }}
            >
              {contextMenuActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className={action.danger ? 'is-danger' : undefined}
                  onClick={() => {
                    setContextMenu(null)
                    setContextMenuPosition(null)
                    void runContextMenuAction(action.key).catch(reportActionError)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

export function FileTreeCard({ cardId, workspacePath, language, onOpenFile }: FileTreeCardProps) {
  const previousLocationRef = useRef<{ cardId: string; workspacePath: string } | null>(null)
  const cacheKey = getFileTreeCacheKey(cardId, workspacePath)

  useEffect(() => {
    const previous = previousLocationRef.current

    if (previous && (previous.cardId !== cardId || previous.workspacePath !== workspacePath)) {
      clearFileTreeCacheEntry(previous.cardId, previous.workspacePath)
    }

    previousLocationRef.current = { cardId, workspacePath }
  }, [cardId, workspacePath])

  return (
    <FileTreeCardInner
      key={cacheKey}
      cardId={cardId}
      workspacePath={workspacePath}
      language={language}
      onOpenFile={onOpenFile}
    />
  )
}

function findTreeNode(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node
    }

    if (node.children) {
      const match = findTreeNode(node.children, targetPath)

      if (match) {
        return match
      }
    }
  }

  return null
}

function mergeTreeNodes(previousNodes: TreeNode[], nextNodes: TreeNode[]): TreeNode[] {
  const previousByPath = new Map(previousNodes.map((node) => [node.path, node]))

  return nextNodes.map((node) => {
    const previousNode = previousByPath.get(node.path)

    if (!previousNode || !node.isDirectory) {
      return node
    }

    return {
      ...node,
      loaded: previousNode.loaded ?? node.loaded,
      expanded: previousNode.expanded ?? node.expanded,
      children: previousNode.children ?? node.children,
    }
  })
}

function updateTree(
  nodes: TreeNode[],
  targetPath: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return updater(node)
    }
    if (node.children && targetPath.startsWith(node.path + '/')) {
      return { ...node, children: updateTree(node.children, targetPath, updater) }
    }
    return node
  })
}
