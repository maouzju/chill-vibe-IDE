import type { GitChange } from '../../shared/schema'

const lastObservedChangeSignaturesByWorkspace = new Map<string, Map<string, string>>()

export const buildGitChangeSignatureMap = (changes: GitChange[]) =>
  new Map(
    changes.map((change) => [
      change.path,
      JSON.stringify({
        originalPath: change.originalPath ?? '',
        kind: change.kind,
        patch: change.patch ?? '',
        addedLines: change.addedLines ?? -1,
        removedLines: change.removedLines ?? -1,
        // 预览被预算跳过时 patch/行数都为空，只能靠服务端附带的 size:mtime 区分"又改了"
        contentSignature: change.contentSignature ?? '',
        conflicted: change.conflicted,
      }),
    ]),
  )

export const getGitChangesSinceLastSnapshot = (workspacePath: string, changes: GitChange[]) => {
  const previousSignatures = lastObservedChangeSignaturesByWorkspace.get(workspacePath)
  const latestSignatures = buildGitChangeSignatureMap(changes)
  const changedPaths = changes
    .filter((change) => {
      if (change.conflicted) {
        return false
      }

      const nextSignature = latestSignatures.get(change.path)
      return previousSignatures?.get(change.path) !== nextSignature
    })
    .map((change) => change.path)
  const changedPathSet = new Set(changedPaths)
  const autoStagePaths = changes
    .filter((change) => changedPathSet.has(change.path) && !change.staged)
    .map((change) => change.path)

  return {
    changedPaths,
    autoStagePaths,
    latestSignatures,
  }
}

export const rememberGitChangeSnapshot = (
  workspacePath: string,
  changesOrSignatures: GitChange[] | Map<string, string>,
) => {
  const signatures =
    changesOrSignatures instanceof Map
      ? changesOrSignatures
      : buildGitChangeSignatureMap(changesOrSignatures)

  lastObservedChangeSignaturesByWorkspace.set(workspacePath, signatures)
}
