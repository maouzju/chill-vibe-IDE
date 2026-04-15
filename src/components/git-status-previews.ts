import type { GitChange, GitStatus } from '../../shared/schema'

const hasExplicitPreviewData = (patch?: string, addedLines?: number, removedLines?: number) =>
  typeof patch === 'string' ||
  typeof addedLines === 'number' ||
  typeof removedLines === 'number'

const getOptimisticTrackedStatus = (change: GitChange) => {
  switch (change.kind) {
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'typechange':
      return 'T'
    case 'added':
    case 'untracked':
      return 'A'
    default:
      return 'M'
  }
}

export const applyOptimisticGitStageState = (change: GitChange, staged: boolean): GitChange => {
  if (staged) {
    return {
      ...change,
      staged: true,
      stagedStatus:
        change.stagedStatus !== ' ' && change.stagedStatus !== '?'
          ? change.stagedStatus
          : getOptimisticTrackedStatus(change),
      workingTreeStatus: ' ',
    }
  }

  if (change.kind === 'untracked' || change.stagedStatus === 'A') {
    return {
      ...change,
      staged: false,
      stagedStatus: '?',
      workingTreeStatus: '?',
    }
  }

  return {
    ...change,
    staged: false,
    stagedStatus: ' ',
    workingTreeStatus: getOptimisticTrackedStatus(change),
  }
}

export const mergeGitStatusPreservingPreviews = (
  previousStatus: GitStatus,
  nextStatus: GitStatus,
): GitStatus => {
  const previousChangesByPath = new Map(
    previousStatus.changes.map((change) => [change.path, change] as const),
  )

  return {
    ...nextStatus,
    changes: nextStatus.changes.map((change) => {
      if (hasExplicitPreviewData(change.patch, change.addedLines, change.removedLines)) {
        return change
      }

      const previousChange = previousChangesByPath.get(change.path)

      if (!previousChange) {
        return change
      }

      return {
        ...change,
        ...(typeof previousChange.patch === 'string' ? { patch: previousChange.patch } : {}),
        ...(typeof previousChange.addedLines === 'number'
          ? { addedLines: previousChange.addedLines }
          : {}),
        ...(typeof previousChange.removedLines === 'number'
          ? { removedLines: previousChange.removedLines }
          : {}),
      }
    }),
  }
}
