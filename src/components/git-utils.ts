import type { AppLanguage, GitChange } from '../../shared/schema'

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

export const statusBadge = (change: GitChange) => {
  if (change.conflicted) {
    return '!'
  }

  if (change.kind === 'untracked') {
    return 'U'
  }

  return change.stagedStatus !== ' ' ? change.stagedStatus : change.workingTreeStatus
}

export const commitTimestamp = (language: AppLanguage, value: string) =>
  new Intl.DateTimeFormat(language === 'en' ? 'en' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

export const changeMatchesFilter = (change: GitChange, filterValue: string) => {
  const query = filterValue.trim().toLowerCase()

  if (!query) {
    return true
  }

  return [change.path, change.originalPath]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(query))
}

export const getRepositoryName = (repoRoot: string) =>
  repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? repoRoot

export const getDiffLineClassName = (line: string) => {
  if (line.startsWith('@@')) {
    return 'structured-diff-line is-hunk'
  }

  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'structured-diff-line is-added'
  }

  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'structured-diff-line is-removed'
  }

  return 'structured-diff-line is-context'
}

export const computeTotalStats = (changes: GitChange[]) => {
  let added = 0
  let removed = 0

  for (const change of changes) {
    if (typeof change.addedLines === 'number') added += change.addedLines
    if (typeof change.removedLines === 'number') removed += change.removedLines
  }

  return { added, removed }
}

export const summarizeGitChanges = (changes: GitChange[]) =>
  changes.reduce(
    (summary, change) => {
      if (change.conflicted) {
        summary.conflicted += 1
      }

      if (change.kind === 'untracked') {
        summary.untracked += 1
      } else if (change.workingTreeStatus !== ' ' && !change.conflicted) {
        summary.unstaged += 1
      }

      if (change.staged) {
        summary.staged += 1
      }

      return summary
    },
    {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
  )
