export type FileTreeMoveSource = {
  workspacePath: string
  relativePath: string
  isDirectory: boolean
}

export type FileTreeMoveTarget = {
  path: string
  isDirectory: boolean
} | null

const normalizeWorkspacePath = (value: string) => value.trim().toLowerCase()

const getRelativeParentPath = (relativePath: string) => {
  const lastSlashIndex = relativePath.lastIndexOf('/')
  return lastSlashIndex === -1 ? '' : relativePath.slice(0, lastSlashIndex)
}

export const resolveFileTreeMoveDestination = ({
  source,
  targetWorkspacePath,
  target,
}: {
  source: FileTreeMoveSource
  targetWorkspacePath: string
  target: FileTreeMoveTarget
}) => {
  if (normalizeWorkspacePath(source.workspacePath) !== normalizeWorkspacePath(targetWorkspacePath)) {
    return null
  }

  const destinationParentRelativePath =
    target === null
      ? ''
      : target.isDirectory
        ? target.path
        : getRelativeParentPath(target.path)
  const sourceParentRelativePath = getRelativeParentPath(source.relativePath)

  if (destinationParentRelativePath === sourceParentRelativePath) {
    return null
  }

  if (
    source.isDirectory &&
    (
      destinationParentRelativePath === source.relativePath ||
      destinationParentRelativePath.startsWith(`${source.relativePath}/`)
    )
  ) {
    return null
  }

  return { destinationParentRelativePath }
}
