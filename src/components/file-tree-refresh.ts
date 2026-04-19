export type RefreshableFileTreeNode = {
  path: string
  isDirectory: boolean
  children?: RefreshableFileTreeNode[]
  loaded?: boolean
  expanded?: boolean
}

const mergeTreeNodes = <T extends RefreshableFileTreeNode>(previousNodes: T[], nextNodes: T[]): T[] => {
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
      children: (previousNode.children ?? node.children) as T['children'],
    }
  })
}

export const collectExpandedFileTreeDirectoryPaths = <T extends RefreshableFileTreeNode>(nodes: T[]) => {
  const paths: string[] = []

  const visit = (entries: T[]) => {
    for (const node of entries) {
      if (!node.isDirectory || !node.expanded) {
        continue
      }

      paths.push(node.path)

      if (node.children?.length) {
        visit(node.children as T[])
      }
    }
  }

  visit(nodes)
  return paths
}

const updateTree = <T extends RefreshableFileTreeNode>(
  nodes: T[],
  targetPath: string,
  updater: (node: T) => T,
): T[] =>
  nodes.map((node) => {
    if (node.path === targetPath) {
      return updater(node)
    }

    if (node.children && targetPath.startsWith(`${node.path}/`)) {
      return {
        ...node,
        children: updateTree(node.children as T[], targetPath, updater),
      }
    }

    return node
  })

type AutoRefreshListener = () => void

type AutoRefreshWindowLike = {
  addEventListener: (name: string, listener: AutoRefreshListener) => void
  removeEventListener: (name: string, listener: AutoRefreshListener) => void
}

type AutoRefreshDocumentLike = AutoRefreshWindowLike & {
  visibilityState: 'visible' | 'hidden' | string
}

export type AttachFileTreeAutoRefreshOptions = {
  win: AutoRefreshWindowLike
  doc: AutoRefreshDocumentLike
  onRefresh: () => void
}

export const attachFileTreeAutoRefreshTriggers = ({
  win,
  doc,
  onRefresh,
}: AttachFileTreeAutoRefreshOptions) => {
  const handleFocus: AutoRefreshListener = () => {
    onRefresh()
  }

  const handleVisibilityChange: AutoRefreshListener = () => {
    if (doc.visibilityState === 'visible') {
      onRefresh()
    }
  }

  win.addEventListener('focus', handleFocus)
  doc.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    win.removeEventListener('focus', handleFocus)
    doc.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}

export const applyRefreshedFileTreeDirectories = <T extends RefreshableFileTreeNode>(
  currentNodes: T[],
  refreshedByPath: ReadonlyMap<string, T[]>,
) => {
  let nextNodes = currentNodes
  const refreshedRoot = refreshedByPath.get('')

  if (refreshedRoot) {
    nextNodes = mergeTreeNodes(nextNodes, refreshedRoot)
  }

  const refreshedNestedPaths = [...refreshedByPath.keys()]
    .filter((path) => path.length > 0)
    .sort((left, right) => left.split('/').length - right.split('/').length)

  for (const path of refreshedNestedPaths) {
    const refreshedChildren = refreshedByPath.get(path)

    if (!refreshedChildren) {
      continue
    }

    nextNodes = updateTree(nextNodes, path, (node) => ({
      ...node,
      loaded: true,
      expanded: node.expanded ?? true,
      children: mergeTreeNodes((node.children ?? []) as T[], refreshedChildren),
    }))
  }

  return nextNodes
}
