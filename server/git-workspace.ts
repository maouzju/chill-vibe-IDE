import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
  GitChange,
  GitChangeKind,
  GitCommit,
  GitCommitResponse,
  GitLogResponse,
  GitOperationResponse,
  GitStatus,
  StreamEditedFile,
} from '../shared/schema.js'

type GitRunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type GitCommitOptions = {
  workspacePath: string
  summary: string
  description?: string
  paths?: string[]
}

type GitStageOptions = {
  workspacePath: string
  paths: string[]
  staged: boolean
}

type InspectGitWorkspaceOptions = {
  includeChangePreviews?: boolean
  includeRepositoryDetails?: boolean
}

export type WorkspaceSnapshot = {
  workspacePath: string
  repoRoot: string
  changes: GitChange[]
  files: Record<
    string,
    {
      path: string
      originalPath?: string
      content: string | null
    }
  >
}

export type WorkspaceSnapshotDiff = {
  files: StreamEditedFile[]
}

const emptyGitSummary = () => ({
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
})

const notRepositoryNote = 'This workspace is not a Git repository yet.'
const gitChangePreviewMaxFileBytes = 256 * 1024
const gitChangePreviewMaxTotalBytes = 512 * 1024
const gitChangePreviewMaxPatchChars = 128 * 1024

const normalizePathList = (paths: string[]) =>
  Array.from(
    new Set(
      paths
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )

const formatGitFailure = (args: string[], result: GitRunResult) => {
  const message = [result.stderr.trim(), result.stdout.trim()].find((entry) => entry.length > 0)

  if (message) {
    return message
  }

  return `git ${args.join(' ')} failed with exit code ${result.exitCode}.`
}

const runGit = async (
  workspacePath: string,
  args: string[],
  options?: {
    allowFailure?: boolean
  },
): Promise<GitRunResult> =>
  await new Promise((resolve, reject) => {
    // `-c core.quotepath=false` keeps non-ASCII paths (e.g. Chinese file names)
    // as raw UTF-8 in porcelain/diff output instead of being backslash-escaped,
    // so paths we read from `git status` round-trip cleanly back into `git add`.
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      const result: GitRunResult = {
        stdout,
        stderr,
        exitCode: code ?? 1,
      }

      if ((code ?? 1) !== 0 && !options?.allowFailure) {
        reject(new Error(formatGitFailure(args, result)))
        return
      }

      resolve(result)
    })
  })

const isConflictStatus = (status: string) =>
  new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(status)

const classifyGitChange = (
  stagedStatus: string,
  workingTreeStatus: string,
  conflicted: boolean,
): GitChangeKind => {
  if (conflicted) {
    return 'conflicted'
  }

  for (const code of [stagedStatus, workingTreeStatus]) {
    if (code === 'R') {
      return 'renamed'
    }

    if (code === 'C') {
      return 'copied'
    }

    if (code === 'A') {
      return 'added'
    }

    if (code === 'D') {
      return 'deleted'
    }

    if (code === 'T') {
      return 'typechange'
    }

    if (code === '?') {
      return 'untracked'
    }
  }

  return 'modified'
}

const parseBranchLine = (
  branchLine: string | undefined,
  repoRoot: string,
): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind'> => {
  if (!branchLine) {
    return {
      branch: path.basename(repoRoot),
      upstream: undefined,
      ahead: 0,
      behind: 0,
    }
  }

  const raw = branchLine.replace(/^##\s+/, '').trim()

  if (raw.startsWith('No commits yet on ')) {
    return {
      branch: raw.slice('No commits yet on '.length).trim(),
      upstream: undefined,
      ahead: 0,
      behind: 0,
    }
  }

  if (raw.startsWith('HEAD (no branch)')) {
    return {
      branch: 'detached',
      upstream: undefined,
      ahead: 0,
      behind: 0,
    }
  }

  const [local, tracking] = raw.split('...')
  const trackingMatch = tracking?.match(/^([^ ]+)(?: \[(.+)\])?$/)
  const counters = trackingMatch?.[2] ?? ''

  return {
    branch: local.trim(),
    upstream: trackingMatch?.[1],
    ahead: Number(counters.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(counters.match(/behind (\d+)/)?.[1] ?? 0),
  }
}

const parseStatusLine = (line: string): GitChange | null => {
  if (!line || line.startsWith('## ')) {
    return null
  }

  const stagedStatus = line[0] ?? ' '
  const workingTreeStatus = line[1] ?? ' '
  const rawPath = line.slice(3).trim()

  if (!rawPath || stagedStatus === '!') {
    return null
  }

  const conflicted = isConflictStatus(`${stagedStatus}${workingTreeStatus}`)
  const renameParts = rawPath.split(' -> ')
  const originalPath = renameParts.length > 1 ? renameParts[0] : undefined
  const filePath = renameParts.length > 1 ? renameParts[renameParts.length - 1] : rawPath

  return {
    path: filePath,
    originalPath,
    kind: classifyGitChange(stagedStatus, workingTreeStatus, conflicted),
    stagedStatus,
    workingTreeStatus,
    staged: stagedStatus !== ' ' && stagedStatus !== '?',
    conflicted,
  }
}

const sortChanges = (left: GitChange, right: GitChange) =>
  Number(right.conflicted) - Number(left.conflicted) ||
  Number(right.staged) - Number(left.staged) ||
  left.path.localeCompare(right.path)

const summarizeChanges = (changes: GitChange[]) =>
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
    emptyGitSummary(),
  )

const isCanceledStagedAddition = (change: GitChange) =>
  change.stagedStatus === 'A' && change.workingTreeStatus === 'D'

const readWorkspaceFile = async (repoRoot: string, relativePath: string) => {
  try {
    return await readFile(path.join(repoRoot, relativePath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

const readWorkspaceFileSize = async (repoRoot: string, relativePath: string) => {
  try {
    return (await stat(path.join(repoRoot, relativePath))).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }

    throw error
  }
}

const readHeadFile = async (repoRoot: string, relativePath: string) => {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const result = await runGit(repoRoot, ['show', `HEAD:${normalizedPath}`], {
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout
}

const readHeadFileSize = async (repoRoot: string, relativePath: string) => {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const result = await runGit(repoRoot, ['cat-file', '-s', `HEAD:${normalizedPath}`], {
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return 0
  }

  const parsedSize = Number(result.stdout.trim())
  return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0
}

const countPatchLines = (patch: string) =>
  patch.split(/\r?\n/).reduce(
    (summary, line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return summary
      }

      if (line.startsWith('+')) {
        summary.addedLines += 1
      } else if (line.startsWith('-')) {
        summary.removedLines += 1
      }

      return summary
    },
    { addedLines: 0, removedLines: 0 },
  )

const createPatch = async (
  oldLabel: string,
  oldContent: string | null,
  newLabel: string,
  newContent: string | null,
) => {
  if ((oldContent ?? null) === (newContent ?? null)) {
    return ''
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'chill-vibe-diff-'))
  const beforePath = path.join(tempRoot, 'before.txt')
  const afterPath = path.join(tempRoot, 'after.txt')

  try {
    await writeFile(beforePath, oldContent ?? '', 'utf8')
    await writeFile(afterPath, newContent ?? '', 'utf8')

    const result = await runGit(
      tempRoot,
      ['diff', '--no-index', '--unified=3', '--no-prefix', '--', beforePath, afterPath],
      { allowFailure: true },
    )

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(formatGitFailure(['diff', '--no-index'], result))
    }

    const patchLines = result.stdout.trim().split(/\r?\n/)

    return patchLines
      .map((line, index) => {
        if (index === 0 && line.startsWith('diff --git ')) {
          return `diff --git a/${oldLabel} b/${newLabel}`
        }

        if (line.startsWith('--- ')) {
          return oldContent === null ? '--- /dev/null' : `--- a/${oldLabel}`
        }

        if (line.startsWith('+++ ')) {
          return newContent === null ? '+++ /dev/null' : `+++ b/${newLabel}`
        }

        return line
      })
      .join('\n')
      .trim()
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

const sortEditedFiles = (left: StreamEditedFile, right: StreamEditedFile) =>
  left.path.localeCompare(right.path)

const shouldSkipGitChangePreview = async (
  repoRoot: string,
  change: GitChange,
  remainingPreviewBudgetBytes: number,
) => {
  if (remainingPreviewBudgetBytes <= 0) {
    return true
  }

  const currentFileSize =
    change.kind === 'deleted'
      ? 0
      : await readWorkspaceFileSize(repoRoot, change.path)
  const baselineFileSize =
    change.kind === 'untracked' || change.kind === 'added'
      ? 0
      : await readHeadFileSize(repoRoot, change.originalPath ?? change.path)
  const combinedFileSize = currentFileSize + baselineFileSize

  return (
    currentFileSize > gitChangePreviewMaxFileBytes ||
    baselineFileSize > gitChangePreviewMaxFileBytes ||
    combinedFileSize > remainingPreviewBudgetBytes
  )
}

const readGitChangePreview = async (
  repoRoot: string,
  change: GitChange,
  remainingPreviewBudgetBytes: number,
): Promise<Pick<GitChange, 'patch' | 'addedLines' | 'removedLines'>> => {
  if (await shouldSkipGitChangePreview(repoRoot, change, remainingPreviewBudgetBytes)) {
    return {
      patch: '',
    }
  }

  const currentContent = await readWorkspaceFile(repoRoot, change.path)
  const baselineContent =
    change.kind === 'untracked' || change.kind === 'added'
      ? null
      : await readHeadFile(repoRoot, change.originalPath ?? change.path)
  const patch = await createPatch(
    change.originalPath ?? change.path,
    baselineContent,
    change.path,
    currentContent,
  )
  const { addedLines, removedLines } = countPatchLines(patch)

  if (patch.length > gitChangePreviewMaxPatchChars) {
    return {
      patch: '',
      addedLines,
      removedLines,
    }
  }

  return {
    patch,
    addedLines,
    removedLines,
  }
}

const readLastCommit = async (workspacePath: string): Promise<GitCommit | null> => {
  const format = '%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1e'
  const result = await runGit(workspacePath, ['log', '-1', `--format=${format}`], {
    allowFailure: true,
  })

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null
  }

  const [hash, shortHash, summary, description, authorName, authoredAt] = result.stdout
    .split('\x1e')[0]
    ?.split('\x1f') ?? []

  if (!hash || !shortHash || !authorName || !authoredAt) {
    return null
  }

  return {
    hash: hash.trim(),
    shortHash: shortHash.trim(),
    summary: (summary ?? '').trim(),
    description: (description ?? '').trim(),
    authorName: authorName.trim(),
    authoredAt: authoredAt.trim(),
  }
}

const getRepositoryRoot = async (workspacePath: string) => {
  const result = await runGit(workspacePath, ['rev-parse', '--show-toplevel'], {
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  const repoRoot = result.stdout.trim().split(/\r?\n/).at(-1)?.trim()
  return repoRoot && repoRoot.length > 0 ? path.normalize(repoRoot) : null
}

const readRepoDescription = async (repoRoot: string): Promise<string> => {
  try {
    const raw = await readFile(path.join(repoRoot, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { description?: string }
    return typeof pkg.description === 'string' ? pkg.description.trim() : ''
  } catch {
    return ''
  }
}

const assertRepository = async (workspacePath: string) => {
  const status = await inspectGitWorkspace(workspacePath)

  if (!status.isRepository) {
    throw new Error(status.note ?? notRepositoryNote)
  }

  return status
}

const hasHeadCommit = async (workspacePath: string) => {
  const result = await runGit(workspacePath, ['rev-parse', '--verify', 'HEAD'], {
    allowFailure: true,
  })

  return result.exitCode === 0
}

const hasStagedChanges = async (workspacePath: string) => {
  const result = await runGit(workspacePath, ['diff', '--cached', '--name-only'], {
    allowFailure: true,
  })

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length > 0
}

export const inspectGitWorkspace = async (
  workspacePath: string,
  options?: InspectGitWorkspaceOptions,
): Promise<GitStatus> => {
  const repoRoot = await getRepositoryRoot(workspacePath)

  if (!repoRoot) {
    return {
      workspacePath,
      isRepository: false,
      repoRoot: '',
      branch: '',
      upstream: undefined,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      clean: true,
      summary: emptyGitSummary(),
      changes: [],
      lastCommit: null,
      description: '',
      note: notRepositoryNote,
    }
  }

  const statusResult = await runGit(repoRoot, ['status', '--branch', '--porcelain=v1', '--untracked-files=all'])
  const lines = statusResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
  const branchInfo = parseBranchLine(lines.find((line) => line.startsWith('## ')), repoRoot)
  const parsedChanges = lines
    .map(parseStatusLine)
    .filter((change): change is GitChange => change !== null)
  const includeChangePreviews = options?.includeChangePreviews !== false
  const includeRepositoryDetails = options?.includeRepositoryDetails !== false
  const changes = includeChangePreviews
    ? (
        await (async () => {
          const hydratedChanges: GitChange[] = []
          let remainingPreviewBudgetBytes = gitChangePreviewMaxTotalBytes

          for (const change of parsedChanges) {
            try {
              const preview = await readGitChangePreview(
                repoRoot,
                change,
                remainingPreviewBudgetBytes,
              )

              if (preview.patch) {
                remainingPreviewBudgetBytes = Math.max(
                  0,
                  remainingPreviewBudgetBytes - preview.patch.length,
                )
              }

              hydratedChanges.push({
                ...change,
                ...preview,
              })
            } catch {
              hydratedChanges.push(change)
            }
          }

          return hydratedChanges
        })()
      ).sort(sortChanges)
    : parsedChanges.sort(sortChanges)
  const summary = summarizeChanges(changes)

  return {
    workspacePath,
    isRepository: true,
    repoRoot,
    branch: branchInfo.branch,
    upstream: branchInfo.upstream,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    hasConflicts: summary.conflicted > 0,
    clean: changes.length === 0,
    summary,
    changes,
    lastCommit: includeRepositoryDetails ? await readLastCommit(repoRoot) : undefined,
    description: includeRepositoryDetails ? await readRepoDescription(repoRoot) : '',
    note: undefined,
  }
}

export const initGitWorkspace = async (workspacePath: string): Promise<GitOperationResponse> => {
  const existingStatus = await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })

  if (existingStatus.isRepository) {
    return {
      status: existingStatus,
      message: 'This workspace is already a Git repository.',
    }
  }

  let initArgs = ['init', '--initial-branch=main']
  let initResult = await runGit(workspacePath, initArgs, { allowFailure: true })

  if (initResult.exitCode !== 0) {
    initArgs = ['init']
    initResult = await runGit(workspacePath, initArgs, { allowFailure: true })
  }

  if (initResult.exitCode !== 0) {
    throw new Error(formatGitFailure(initArgs, initResult))
  }

  const status = await inspectGitWorkspace(workspacePath)
  const message =
    [initResult.stdout.trim(), initResult.stderr.trim()].find((entry) => entry.length > 0)?.split(/\r?\n/).at(-1)
    ?? 'Created a new Git repository.'

  return {
    status,
    message,
  }
}

export const captureWorkspaceSnapshot = async (
  workspacePath: string,
): Promise<WorkspaceSnapshot | null> => {
  const status = await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })

  if (!status.isRepository) {
    return null
  }

  const files = Object.fromEntries(
    await Promise.all(
      status.changes.map(async (change) => [
        change.path,
        {
          path: change.path,
          originalPath: change.originalPath,
          content: await readWorkspaceFile(status.repoRoot, change.path),
        },
      ]),
    ),
  )

  return {
    workspacePath,
    repoRoot: status.repoRoot,
    changes: status.changes,
    files,
  }
}

export const diffWorkspaceSnapshot = async (
  snapshot: WorkspaceSnapshot | null,
  workspacePath: string,
  touchedPaths?: Set<string>,
): Promise<WorkspaceSnapshotDiff> => {
  if (!snapshot) {
    return { files: [] }
  }

  const currentStatus = await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })

  if (!currentStatus.isRepository || currentStatus.repoRoot !== snapshot.repoRoot) {
    return { files: [] }
  }

  const editedFiles: StreamEditedFile[] = []
  const handledSnapshotPaths = new Set<string>()

  for (const change of currentStatus.changes) {
    if (touchedPaths && !touchedPaths.has(change.path)) {
      continue
    }

    const snapshotFile =
      snapshot.files[change.path] ??
      (change.originalPath ? snapshot.files[change.originalPath] : undefined)

    const currentContent = await readWorkspaceFile(snapshot.repoRoot, change.path)
    const baselineContent = snapshotFile
      ? snapshotFile.content
      : change.kind === 'untracked' || change.kind === 'added'
        ? null
        : await readHeadFile(snapshot.repoRoot, change.originalPath ?? change.path)

    const patch = await createPatch(
      snapshotFile?.originalPath ?? change.originalPath ?? change.path,
      baselineContent,
      change.path,
      currentContent,
    )

    if (!patch) {
      if (snapshotFile) {
        handledSnapshotPaths.add(snapshotFile.path)
      }
      continue
    }

    const { addedLines, removedLines } = countPatchLines(patch)
    editedFiles.push({
      path: change.path,
      originalPath: change.originalPath,
      kind: change.kind,
      addedLines,
      removedLines,
      patch,
    })

    if (snapshotFile) {
      handledSnapshotPaths.add(snapshotFile.path)
    }
  }

  for (const snapshotFile of Object.values(snapshot.files)) {
    if (handledSnapshotPaths.has(snapshotFile.path)) {
      continue
    }

    if (touchedPaths && !touchedPaths.has(snapshotFile.path)) {
      continue
    }

    const currentContent = await readWorkspaceFile(snapshot.repoRoot, snapshotFile.path)
    const patch = await createPatch(
      snapshotFile.originalPath ?? snapshotFile.path,
      snapshotFile.content,
      snapshotFile.path,
      currentContent,
    )

    if (!patch) {
      continue
    }

    const { addedLines, removedLines } = countPatchLines(patch)
    editedFiles.push({
      path: snapshotFile.path,
      originalPath: snapshotFile.originalPath,
      kind: currentContent === null ? 'deleted' : 'modified',
      addedLines,
      removedLines,
      patch,
    })
  }

  return {
    files: editedFiles.sort(sortEditedFiles),
  }
}

export const setGitWorkspaceStage = async ({
  workspacePath,
  paths,
  staged,
}: GitStageOptions): Promise<GitStatus> => {
  const status = await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })
  const normalizedPaths = normalizePathList(paths)

  if (!status.isRepository) {
    throw new Error(status.note ?? notRepositoryNote)
  }

  if (normalizedPaths.length === 0) {
    throw new Error('Choose at least one file to update its staged state.')
  }

  if (staged) {
    await runGit(status.repoRoot, ['add', '--', ...normalizedPaths])
    return await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })
  }

  const restoreResult = await runGit(status.repoRoot, ['restore', '--staged', '--', ...normalizedPaths], {
    allowFailure: true,
  })

  if (restoreResult.exitCode !== 0) {
    if (await hasHeadCommit(status.repoRoot)) {
      await runGit(status.repoRoot, ['reset', '--quiet', 'HEAD', '--', ...normalizedPaths])
    } else {
      await runGit(status.repoRoot, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...normalizedPaths], {
        allowFailure: true,
      })
    }
  }

  return await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })
}

export const commitGitWorkspace = async ({
  workspacePath,
  summary,
  description = '',
  paths,
}: GitCommitOptions): Promise<GitCommitResponse> => {
  let status = await assertRepository(workspacePath)
  const normalizedSummary = summary.trim()
  const normalizedDescription = description.trim()
  let normalizedPaths = paths ? normalizePathList(paths) : []

  if (!normalizedSummary) {
    throw new Error('Write a commit summary before committing.')
  }

  if (status.hasConflicts) {
    throw new Error('Resolve merge conflicts before creating a commit.')
  }

  if (paths && normalizedPaths.length === 0) {
    throw new Error('Choose at least one file to commit.')
  }

  if (normalizedPaths.length > 0) {
    const requestedPathSet = new Set(normalizedPaths)
    const requestedChanges = status.changes.filter((change) => requestedPathSet.has(change.path))

    if (requestedChanges.length === 0) {
      throw new Error('Choose at least one file to commit.')
    }

    const canceledAdditionPaths = requestedChanges
      .filter(isCanceledStagedAddition)
      .map((change) => change.path)

    if (canceledAdditionPaths.length > 0) {
      await runGit(status.repoRoot, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...canceledAdditionPaths])
    }

    const pathsToStage = requestedChanges
      .filter((change) => !isCanceledStagedAddition(change))
      .filter((change) => !change.staged || change.workingTreeStatus !== ' ')
      .map((change) => change.path)

    if (pathsToStage.length > 0) {
      await setGitWorkspaceStage({
        workspacePath,
        paths: pathsToStage,
        staged: true,
      })
    }

    status = await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })
    const refreshedChangesByPath = new Map(status.changes.map((change) => [change.path, change]))
    normalizedPaths = normalizedPaths.filter((path) => {
      const change = refreshedChangesByPath.get(path)
      return change !== undefined && !change.conflicted && !isCanceledStagedAddition(change)
    })

    if (normalizedPaths.length === 0) {
      throw new Error('Choose at least one file to commit.')
    }
  }

  if (!(await hasStagedChanges(status.repoRoot))) {
    throw new Error('Stage at least one file before committing.')
  }

  const args = ['commit', '-m', normalizedSummary]

  if (normalizedDescription) {
    args.push('-m', normalizedDescription)
  }

  if (normalizedPaths.length > 0) {
    args.push('--only', '--', ...normalizedPaths)
  }

  await runGit(status.repoRoot, args)

  const nextStatus = await inspectGitWorkspace(workspacePath)

  if (!nextStatus.lastCommit) {
    throw new Error('The commit succeeded, but the latest commit details could not be read back.')
  }

  return {
    status: nextStatus,
    commit: nextStatus.lastCommit,
  }
}

export const pullGitWorkspace = async (workspacePath: string): Promise<GitOperationResponse> => {
  const status = await assertRepository(workspacePath)

  // Fetch first so we can detect potential conflicts before pulling
  await runGit(status.repoRoot, ['fetch'], { allowFailure: true })

  // Check which files are incoming from remote
  const upstream = status.upstream || `origin/${status.branch}`
  const incomingResult = await runGit(status.repoRoot, ['diff', '--name-only', `HEAD...${upstream}`], {
    allowFailure: true,
  })

  if (incomingResult.exitCode === 0 && incomingResult.stdout.trim()) {
    const incomingFiles = new Set(incomingResult.stdout.trim().split(/\r?\n/).filter(Boolean))
    // Find local dirty files (unstaged modified + untracked) that overlap with incoming
    const localDirty = status.changes
      .filter((c) => !c.staged)
      .map((c) => c.path)
    const blocked = localDirty.filter((f) => incomingFiles.has(f))

    if (blocked.length > 0) {
      const refreshed = await inspectGitWorkspace(workspacePath)
      return {
        status: refreshed,
        blockedFiles: blocked,
      }
    }
  }

  const result = await runGit(status.repoRoot, ['pull', '--no-rebase', '--autostash'], {
    allowFailure: true,
  })
  const nextStatus = await inspectGitWorkspace(workspacePath)

  if (result.exitCode !== 0) {
    throw new Error(formatGitFailure(['pull', '--no-rebase', '--autostash'], result))
  }

  const message =
    [result.stdout.trim(), result.stderr.trim()].find((entry) => entry.length > 0)?.split(/\r?\n/).at(-1) ??
    (nextStatus.behind === 0 ? 'Already up to date.' : 'Pulled the latest changes.')

  return {
    status: nextStatus,
    message,
  }
}

export const pushGitWorkspace = async (workspacePath: string): Promise<GitOperationResponse> => {
  const status = await assertRepository(workspacePath)
  const args = ['push']

  if (!status.upstream) {
    args.push('-u', 'origin', status.branch)
  }

  const result = await runGit(status.repoRoot, args, { allowFailure: true })
  const nextStatus = await inspectGitWorkspace(workspacePath)

  if (result.exitCode !== 0) {
    throw new Error(formatGitFailure(args, result))
  }

  const message =
    [result.stdout.trim(), result.stderr.trim()].find((entry) => entry.length > 0)?.split(/\r?\n/).at(-1) ??
    (nextStatus.ahead === 0 ? 'Everything up-to-date.' : 'Pushed successfully.')

  return {
    status: nextStatus,
    message,
  }
}

export const commitAllGitWorkspace = async ({
  workspacePath,
  summary,
  description = '',
}: Omit<GitCommitOptions, 'paths'>): Promise<GitCommitResponse> => {
  const status = await assertRepository(workspacePath)

  if (status.hasConflicts) {
    throw new Error('Resolve merge conflicts before creating a commit.')
  }

  if (status.clean) {
    throw new Error('No changes to commit.')
  }

  await runGit(status.repoRoot, ['add', '--all'])

  return commitGitWorkspace({ workspacePath, summary, description })
}

export const fetchGitLog = async ({
  workspacePath,
  limit = 20,
  skip = 0,
}: {
  workspacePath: string
  limit?: number
  skip?: number
}): Promise<GitLogResponse> => {
  const status = await assertRepository(workspacePath)

  if (!(await hasHeadCommit(status.repoRoot))) {
    return { commits: [], hasMore: false }
  }

  const format = '%H%n%h%n%s%n%b%n%an%n%aI%n---END---'
  const result = await runGit(
    status.repoRoot,
    ['log', `--format=${format}`, `-n`, String(limit + 1), `--skip=${skip}`],
    { allowFailure: true },
  )

  if (result.exitCode !== 0) {
    return { commits: [], hasMore: false }
  }

  const blocks = result.stdout.split('---END---\n').filter((b) => b.trim())
  const hasMore = blocks.length > limit
  const commits: GitCommit[] = blocks.slice(0, limit).map((block) => {
    const lines = block.trim().split('\n')
    const hash = lines[0] ?? ''
    const shortHash = lines[1] ?? hash.slice(0, 7)
    const summary = lines[2] ?? ''
    const authorName = lines[lines.length - 2] ?? ''
    const authoredAt = lines[lines.length - 1] ?? ''
    const description = lines.slice(3, -2).join('\n').trim()
    return { hash, shortHash, summary, description, authorName, authoredAt }
  })

  return { commits, hasMore }
}

export const fetchCommitDiff = async (
  workspacePath: string,
  hash: string,
): Promise<string> => {
  const status = await assertRepository(workspacePath)
  const result = await runGit(status.repoRoot, ['show', hash, '--format=', '--patch'], {
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    throw new Error(formatGitFailure(['show', hash], result))
  }

  return result.stdout
}
