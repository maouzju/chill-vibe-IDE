export type GitChangeSelection = {
  paths: string[]
  anchorPath: string | null
}

export const emptyGitSelection: GitChangeSelection = {
  paths: [],
  anchorPath: null,
}

type SelectionModifiers = {
  ctrlKey: boolean
  shiftKey: boolean
}

const orderPaths = (paths: Iterable<string>, orderedPaths: string[]) => {
  const wanted = new Set(paths)
  return orderedPaths.filter((path) => wanted.has(path))
}

export const applyGitSelectionClick = (
  selection: GitChangeSelection,
  orderedPaths: string[],
  targetPath: string,
  modifiers: SelectionModifiers,
): GitChangeSelection => {
  if (modifiers.shiftKey) {
    const anchorIndex =
      selection.anchorPath === null ? -1 : orderedPaths.indexOf(selection.anchorPath)
    const targetIndex = orderedPaths.indexOf(targetPath)

    if (anchorIndex === -1 || targetIndex === -1) {
      return { paths: [targetPath], anchorPath: targetPath }
    }

    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    return {
      paths: orderedPaths.slice(start, end + 1),
      anchorPath: selection.anchorPath,
    }
  }

  if (modifiers.ctrlKey) {
    const next = new Set(selection.paths)
    if (next.has(targetPath)) {
      next.delete(targetPath)
    } else {
      next.add(targetPath)
    }
    return {
      paths: orderPaths(next, orderedPaths),
      anchorPath: targetPath,
    }
  }

  return { paths: [targetPath], anchorPath: targetPath }
}

export const pruneGitSelection = (
  selection: GitChangeSelection,
  orderedPaths: string[],
): GitChangeSelection => {
  const visible = new Set(orderedPaths)
  const paths = selection.paths.filter((path) => visible.has(path))
  const anchorPath =
    selection.anchorPath !== null && visible.has(selection.anchorPath)
      ? selection.anchorPath
      : null

  return paths.length === selection.paths.length && anchorPath === selection.anchorPath
    ? selection
    : { paths, anchorPath }
}

export const resolveGitContextTarget = (
  selection: GitChangeSelection,
  targetPath: string,
): GitChangeSelection =>
  selection.paths.includes(targetPath)
    ? selection
    : { paths: [targetPath], anchorPath: targetPath }
