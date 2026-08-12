import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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

export type GitRunResult = {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
  aborted?: boolean
}

export type GitRunOptions = {
  allowFailure?: boolean
  stdin?: string | Buffer
  timeoutMs?: number
  killGraceMs?: number
  signal?: AbortSignal
}

/**
 * The subset of `ChildProcess` this module supervises. Narrow on purpose so a
 * test can drive the real supervision logic with a process that never closes.
 */
export type SupervisedGitChild = {
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => unknown } | null
  stderr: { on: (event: 'data', listener: (chunk: Buffer) => void) => unknown } | null
  stdin: { end: (data: string | Buffer) => void } | null
  on: {
    (event: 'error', listener: (error: Error) => void): unknown
    (event: 'close', listener: (code: number | null) => void): unknown
  }
  kill: (signal?: NodeJS.Signals) => boolean
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

type GitDiscardOptions = {
  workspacePath: string
  paths: string[]
}

type InspectGitWorkspaceOptions = {
  includeChangePreviews?: boolean
  includeRepositoryDetails?: boolean
  signal?: AbortSignal
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

export type WorkspaceSnapshotDiffLimits = {
  maxFileBytes?: number
  maxTotalBytes?: number
  maxFiles?: number
  signal?: AbortSignal
}

export type CaptureWorkspaceSnapshotOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export type GitCommitDiffLimits = {
  maxPatchBytes?: number
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
const gitChangePreviewDiffBatchChars = 12 * 1024
// A history commit is rendered as one patch, so it needs its own ceiling well
// above the per-file preview cap yet far below what freezes the renderer.
const gitCommitDiffMaxPatchBytes = 512 * 1024
// A chat stream keeps this snapshot alive until the provider turn settles.
// Keep the retained baseline strictly bounded so several concurrent streams
// cannot each clone gigabytes of untracked build/test output into Electron's
// main process.
const workspaceSnapshotMaxFileBytes = 256 * 1024
const workspaceSnapshotMaxTotalBytes = 4 * 1024 * 1024
const workspaceSnapshotMaxFiles = 256
const workspaceSnapshotSharedContentMaxBytes = 32 * 1024 * 1024

type WorkspaceSnapshotContentStoreStats = {
  entries: number
  bytes: number
  hits: number
  misses: number
  evictions: number
}

/**
 * Baselines remain per-turn, but identical immutable strings can be shared.
 * The LRU is byte-bounded so deduplication never becomes a new global leak.
 */
export const createWorkspaceSnapshotContentStore = (maxBytes: number) => {
  const entries = new Map<string, { content: string; bytes: number }>()
  let retainedBytes = 0
  let hits = 0
  let misses = 0
  let evictions = 0

  const intern = (content: string) => {
    const bytes = Buffer.byteLength(content)
    const digest = createHash('sha256').update(content).digest('hex')
    const key = `${bytes}:${digest}`
    const cached = entries.get(key)

    if (cached) {
      hits += 1
      entries.delete(key)
      entries.set(key, cached)
      return cached.content
    }

    misses += 1
    if (bytes > maxBytes) {
      return content
    }

    while (retainedBytes + bytes > maxBytes && entries.size > 0) {
      const oldestKey = entries.keys().next().value as string | undefined
      if (!oldestKey) {
        break
      }
      const oldest = entries.get(oldestKey)
      entries.delete(oldestKey)
      if (oldest) {
        retainedBytes -= oldest.bytes
        evictions += 1
      }
    }

    entries.set(key, { content, bytes })
    retainedBytes += bytes
    return content
  }

  const getStats = (): WorkspaceSnapshotContentStoreStats => ({
    entries: entries.size,
    bytes: retainedBytes,
    hits,
    misses,
    evictions,
  })

  return { intern, getStats }
}

const workspaceSnapshotContentStore = createWorkspaceSnapshotContentStore(
  workspaceSnapshotSharedContentMaxBytes,
)

const normalizePathList = (paths: string[]) =>
  Array.from(
    new Set(
      paths
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )

export const decodeGitStreamChunks = (chunks: readonly Buffer[]) => {
  if (chunks.length === 0) {
    return ''
  }

  if (chunks.length === 1) {
    return chunks[0]!.toString('utf8')
  }

  return Buffer.concat(chunks as Buffer[]).toString('utf8')
}

const formatGitFailure = (args: string[], result: GitRunResult) => {
  const message = [result.stderr.trim(), result.stdout.trim()].find((entry) => entry.length > 0)

  if (message) {
    return message
  }

  return `git ${args.join(' ')} failed with exit code ${result.exitCode}.`
}

// 症状 — 应用"闪退"，实测退出码 0xCFFFFFFF（Windows 结束"窗口无响应"进程写的码）；
//   外部监控实测冻结期间主进程 CPU=0%、主线程处于内核 Wait，也就是卡死的后果。
// 根因 — 2026-08-12 实测这台机器上 spawn() 本身是主线程同步阻塞（libuv 在 Windows 上
//   同步执行 CreateProcessW）：40 次 git spawn p50=102ms、p90=1831ms、最坏单次 6910ms、
//   25 次合计 21s。而 runGit 既没有超时也没有 kill，一个静默的 git 子进程能让 await
//   永不返回，上一轮的残余还会和下一轮叠加成 spawn 风暴。
// 为什么不能只加超时不 kill — 那正是 chat-manager 的 withHardTimeout 旧写法：Promise.race
//   只是放弃等待，那一串 git 照样在跑、照样占着句柄和 CPU，叠加只会更快。到点必须真杀。
// 这个默认值的职责是"卡死的 git 不能永远挂住调用方"，**不是**快速失败：真正约束热
// 路径的是上层的取消预算（收尾 diff 12s、发消息前快照 60s，两者现在都会真的 kill）。
// 所以它必须给到远超正常耗时：2026-08-12 有负载的本机上，tests/git-workspace.test.ts
// 里单条真实 git 用例实测跑到 90s，取小值只会把用户正常的 Git 操作杀掉。
export const gitRunDefaultTimeoutMs = 120_000
export const gitRunKillGraceMs = 2_000
// 网络子命令的耗时分布和本地命令完全不是一回事：一次 `git pull` 在慢网络上跑几分钟
// 是正常的。给它们套本地默认值等于把用户的正常操作杀掉。
const gitNetworkRunTimeoutMs = 10 * 60 * 1000
const gitNetworkSubcommands = new Set([
  'clone',
  'fetch',
  'ls-remote',
  'pull',
  'push',
  'remote',
  'submodule',
])

/**
 * 超时策略必须集中在一处：40+ 个 runGit 调用点里只要有一个忘了给网络命令放宽预算，
 * 用户的 `git pull` 就会在 20s 上被 kill。按子命令判定，调用点无从遗漏。
 */
export const resolveGitRunTimeoutMs = (
  args: readonly string[],
  explicitTimeoutMs?: number,
) => {
  if (explicitTimeoutMs !== undefined) {
    return explicitTimeoutMs
  }

  const subcommand = args.find((arg) => !arg.startsWith('-'))

  return subcommand && gitNetworkSubcommands.has(subcommand)
    ? gitNetworkRunTimeoutMs
    : gitRunDefaultTimeoutMs
}

export const superviseGitChild = async (
  child: SupervisedGitChild,
  args: string[],
  options?: GitRunOptions,
): Promise<GitRunResult> =>
  await new Promise((resolve, reject) => {
    // 症状：`git diff` / `git status` 输出里的中文路径或中文改动内容偶发变成 U+FFFD 乱码，
    //   下游 `git add` 按乱码路径回写就会失败。
    // 根因：2026-08-10 实测，旧写法 `stdout += chunk.toString()` 逐 chunk 独立解码；一个
    //   UTF-8 多字节字符跨越 64KiB chunk 边界时两半各自解码，必然产出替换符
    //   （tests/git-patch-block-index.test.ts 对每一个字节切点都有红证）。
    // 被否决：`chunks.map((c) => c.toString()).join('')` —— 它只是把拼接换了个写法，逐 chunk
    //   解码这个真正的病根原样保留。注意本改动是纯正确性修复：2026-08-10 基准测试 6MB CJK
    //   输出上 `+=`(353ms) 与 Buffer.concat(333ms) 基本持平，别当成性能优化去"还原"。
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    const timeoutMs = options?.timeoutMs ?? gitRunDefaultTimeoutMs
    const signal = options?.signal
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (finish: () => void) => {
      if (settled) {
        return
      }
      settled = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      signal?.removeEventListener('abort', onAbort)
      finish()
    }

    // kill 可能因为进程刚好已退出而抛（ESRCH / EPERM），绝不能让它掀掉 settle。
    // SIGTERM 之后仍不 close 的进程用 SIGKILL 兜底；两个定时器都不 unref —— 唯一
    // 在等这个 promise 的调用方可能没有别的活儿，unref 会让 Node 提前退出。
    const killChild = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone; nothing else to reap.
      }

      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone; nothing else to reap.
        }
      }, options?.killGraceMs ?? gitRunKillGraceMs)
    }

    const giveUp = (reason: 'timeout' | 'abort') => {
      if (settled) {
        return
      }

      killChild()
      settle(() => {
        const result: GitRunResult = {
          stdout: decodeGitStreamChunks(stdoutChunks),
          stderr: decodeGitStreamChunks(stderrChunks),
          exitCode: -1,
          ...(reason === 'timeout' ? { timedOut: true } : { aborted: true }),
        }

        if (options?.allowFailure) {
          resolve(result)
          return
        }

        reject(new Error(
          reason === 'timeout'
            ? `git ${args.join(' ')} timed out after ${timeoutMs}ms and was killed.`
            : `git ${args.join(' ')} was cancelled and killed.`,
        ))
      })
    }

    function onAbort() {
      giveUp('abort')
    }

    child.on('error', (error) => {
      settle(() => reject(error))
    })
    if (options?.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin)
    }
    child.on('close', (code) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }

      settle(() => {
        const result: GitRunResult = {
          stdout: decodeGitStreamChunks(stdoutChunks),
          stderr: decodeGitStreamChunks(stderrChunks),
          exitCode: code ?? 1,
        }

        if ((code ?? 1) !== 0 && !options?.allowFailure) {
          reject(new Error(formatGitFailure(args, result)))
          return
        }

        resolve(result)
      })
    })

    if (signal) {
      if (signal.aborted) {
        giveUp('abort')
        return
      }

      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => giveUp('timeout'), timeoutMs)
    }
  })

const runGit = async (
  workspacePath: string,
  args: string[],
  options?: GitRunOptions,
): Promise<GitRunResult> => {
  // 取消之后就绝不能再派生进程 —— 这才是"砍掉 spawn 风暴"真正省下的部分：一次
  // workspace diff 最多派生 3 × 256 个 git 子进程，超时点之后剩下的几百次 spawn
  // 每次都是主线程同步阻塞（2026-08-12 实测最坏单次 6910ms）。
  if (options?.signal?.aborted) {
    if (options.allowFailure) {
      return { stdout: '', stderr: '', exitCode: -1, aborted: true }
    }

    throw new Error(`git ${args.join(' ')} was cancelled before it started.`)
  }

  // `-c core.quotepath=false` keeps non-ASCII paths (e.g. Chinese file names)
  // as raw UTF-8 in porcelain/diff output instead of being backslash-escaped,
  // so paths we read from `git status` round-trip cleanly back into `git add`.
  const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: workspacePath,
    stdio: [options?.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  return await superviseGitChild(child, args, {
    ...options,
    timeoutMs: resolveGitRunTimeoutMs(args, options?.timeoutMs),
  })
}

export const encodeGitPathspecStdin = (paths: string[]) =>
  Buffer.from(`${paths.join('\0')}\0`, 'utf8')

const runGitWithPathspecs = (
  workspacePath: string,
  args: string[],
  paths: string[],
  options?: {
    allowFailure?: boolean
  },
) =>
  runGit(
    workspacePath,
    [...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
    {
      ...options,
      stdin: encodeGitPathspecStdin(paths),
    },
  )

const isConflictStatus = (status: string) =>
  new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(status)

const decodeGitStatusPath = (rawPath: string) => {
  const trimmedPath = rawPath.trim()

  if (!trimmedPath.startsWith('"') || !trimmedPath.endsWith('"')) {
    return trimmedPath
  }

  try {
    const decoded = JSON.parse(trimmedPath) as unknown
    return typeof decoded === 'string' ? decoded : trimmedPath
  } catch {
    return trimmedPath.slice(1, -1)
  }
}

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
  const originalPath = renameParts.length > 1 ? decodeGitStatusPath(renameParts[0] ?? '') : undefined
  const filePath = decodeGitStatusPath(renameParts.length > 1 ? (renameParts[renameParts.length - 1] ?? '') : rawPath)

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

/**
 * 症状 — with `status.renames=copies` in the user's gitconfig, unchecking or
 *   committing a copied file silently unstaged / committed the *source* file
 *   too, throwing away staged work the user never selected.
 * 根因 — `git status --porcelain=v1` renders both halves of `R old -> new` and
 *   `C old -> new` the same way, so `parseStatusLine` fills `originalPath` for
 *   both and one shared predicate treated them alike. The semantics diverge:
 *   a rename's `old` is gone from index and worktree (expanding is mandatory,
 *   or the deletion half is left behind), while a copy's `old` still exists and
 *   commonly carries its own staged edits. 2026-08-02 实测 in a temp repo:
 *   `C base.txt -> copy.txt` + `M base.txt`, then unchecking `copy.txt` ran
 *   `git restore --staged copy.txt base.txt` and dropped `base.txt` to ` M`.
 * 被否决 — normalizing copies away in `parseStatusLine` (dropping `originalPath`
 *   for `C`) would break the Git card's "copied from" label and the snapshot
 *   diff path at :1551 that follows `originalPath`. `runGit` also cannot pin
 *   `-c status.renames=renames` to make copies disappear, because the card is
 *   supposed to show the user the copy relationship their config asked for.
 */
const isRenameChange = (change: GitChange) =>
  change.stagedStatus === 'R' && Boolean(change.originalPath)

const isCopyChange = (change: GitChange) =>
  change.stagedStatus === 'C' && Boolean(change.originalPath)

/**
 * A rename is one logical change recorded across two paths, but the Git card
 * only ever shows (and lets the user select) `change.path`. Every index-side
 * pathspec built from a selection must therefore re-attach `originalPath`.
 * A copy must NOT be expanded — see `isRenameChange` above.
 */
const renamePathspecsForChange = (change: GitChange) =>
  isRenameChange(change) ? [change.path, change.originalPath as string] : [change.path]

const expandStagedRenamePathspecs = (
  selectedPaths: string[],
  originalPathsByNewPath: Map<string, string>,
) => {
  if (originalPathsByNewPath.size === 0) {
    return selectedPaths
  }

  const expanded = selectedPaths.flatMap((selectedPath) => {
    const originalPath = originalPathsByNewPath.get(selectedPath)
    return originalPath ? [selectedPath, originalPath] : [selectedPath]
  })

  return expanded.length === selectedPaths.length ? selectedPaths : normalizePathList(expanded)
}

/**
 * `--name-status -z` emits one NUL-terminated status token per entry, followed
 * by one path — or by two paths when the token is a rename/copy score such as
 * `R100`. Walk the fields instead of splitting on lines so paths containing
 * newlines or non-ASCII bytes survive verbatim.
 */
const parseStagedRenamePairs = (stdout: string) => {
  const fields = stdout.split('\0').filter((field) => field.length > 0)
  const originalPathsByNewPath = new Map<string, string>()
  let index = 0

  while (index < fields.length) {
    const statusToken = fields[index] ?? ''
    const originalPath = fields[index + 1]
    index += 2

    if (!statusToken.startsWith('R') && !statusToken.startsWith('C')) {
      continue
    }

    const newPath = fields[index]
    index += 1

    if (statusToken.startsWith('R') && originalPath && newPath) {
      originalPathsByNewPath.set(newPath, originalPath)
    }
  }

  return originalPathsByNewPath
}

/**
 * 症状 — every checkbox toggle in the Git card ran a third git process, and on
 *   a large repo each one walked the whole working tree.
 * 根因 — unstaging needs the `new -> old` pairing of staged renames, and the
 *   only source was another `inspectResolvedGitWorkspace`. Its very first call
 *   is `git status --branch --porcelain=v1 --untracked-files=all`, which
 *   `includeChangePreviews:false` / `includeRepositoryDetails:false` do not
 *   touch — those options only skip preview hydration, `git log`, and the
 *   package.json read. So rapid-clicking 20 checkboxes cost 20 extra full-tree
 *   scans plus every unignored untracked file.
 * 被否决 — passing the renderer's already-loaded `changes` down would change the
 *   public `setGitWorkspaceStage` signature for every caller and still need a
 *   server-side fallback; `git diff --cached` compares index against HEAD only,
 *   never stats the worktree, and normally returns empty. `-M` is passed
 *   explicitly so a `diff.renames=copies` config cannot fold copies in here
 *   (verified 2026-08-02: copies come back as `A` and `--diff-filter=R` drops
 *   them), keeping this query aligned with `isRenameChange`.
 */
const readStagedRenamePairs = async (repoRoot: string) => {
  const result = await runGit(
    repoRoot,
    ['diff', '--cached', '--name-status', '-M', '-z', '--diff-filter=R'],
    { allowFailure: true },
  )

  if (result.exitCode !== 0) {
    return new Map<string, string>()
  }

  return parseStagedRenamePairs(result.stdout)
}

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

const workspaceFileExists = async (repoRoot: string, relativePath: string) => {
  try {
    await stat(path.join(repoRoot, relativePath))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

const readHeadFile = async (repoRoot: string, relativePath: string, signal?: AbortSignal) => {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const result = await runGit(repoRoot, ['show', `HEAD:${normalizedPath}`], {
    allowFailure: true,
    signal,
  })

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout
}

const isInsideGitRepository = async (workspacePath: string) => {
  const result = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'], {
    allowFailure: true,
  })

  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

export type GitFileHeadState = {
  isRepository: boolean
  /** HEAD revision content, or null for untracked files / non-repositories. */
  headContent: string | null
}

export const readGitHeadFileState = async (request: {
  workspacePath: string
  relativePath: string
}): Promise<GitFileHeadState> => {
  if (!(await isInsideGitRepository(request.workspacePath))) {
    return { isRepository: false, headContent: null }
  }

  // The `./` prefix makes git resolve the path relative to the cwd, which keeps
  // sub-directory workspaces working without resolving the repo root first.
  const normalizedPath = request.relativePath.replace(/\\/g, '/')
  const result = await runGit(request.workspacePath, ['show', `HEAD:./${normalizedPath}`], {
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    return { isRepository: true, headContent: null }
  }

  return { isRepository: true, headContent: result.stdout }
}

export type GitLineDiffRange = { start: number; end: number }

export type GitFileLineDiff = {
  isRepository: boolean
  tracked: boolean
  added: GitLineDiffRange[]
  modified: GitLineDiffRange[]
  /** New-side line numbers after which content was removed (0 = before line 1). */
  removed: number[]
}

const unifiedZeroHunkPattern = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export const parseGitUnifiedZeroHunks = (
  patch: string,
): Pick<GitFileLineDiff, 'added' | 'modified' | 'removed'> => {
  const added: GitLineDiffRange[] = []
  const modified: GitLineDiffRange[] = []
  const removed: number[] = []

  for (const line of patch.split('\n')) {
    const match = unifiedZeroHunkPattern.exec(line)
    if (!match) {
      continue
    }

    const oldCount = match[1] === undefined ? 1 : Number(match[1])
    const newStart = Number(match[2])
    const newCount = match[3] === undefined ? 1 : Number(match[3])

    if (newCount === 0) {
      removed.push(newStart)
      continue
    }

    const range: GitLineDiffRange = { start: newStart, end: newStart + newCount - 1 }
    if (oldCount === 0) {
      added.push(range)
    } else {
      modified.push(range)
    }
  }

  return { added, modified, removed }
}

export const readGitFileLineDiff = async (request: {
  workspacePath: string
  relativePath: string
}): Promise<GitFileLineDiff> => {
  const emptyRanges = { added: [], modified: [], removed: [] }

  if (!(await isInsideGitRepository(request.workspacePath))) {
    return { isRepository: false, tracked: false, ...emptyRanges }
  }

  const normalizedPath = request.relativePath.replace(/\\/g, '/')
  const trackedResult = await runGit(
    request.workspacePath,
    ['ls-files', '--error-unmatch', '--', normalizedPath],
    { allowFailure: true },
  )

  if (trackedResult.exitCode !== 0) {
    return { isRepository: true, tracked: false, ...emptyRanges }
  }

  const diffResult = await runGit(
    request.workspacePath,
    ['diff', 'HEAD', '--unified=0', '--', normalizedPath],
    { allowFailure: true },
  )

  if (diffResult.exitCode !== 0) {
    return { isRepository: true, tracked: true, ...emptyRanges }
  }

  return { isRepository: true, tracked: true, ...parseGitUnifiedZeroHunks(diffResult.stdout) }
}

const readHeadFileSize = async (repoRoot: string, relativePath: string, signal?: AbortSignal) => {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const result = await runGit(repoRoot, ['cat-file', '-s', `HEAD:${normalizedPath}`], {
    allowFailure: true,
    signal,
  })

  if (result.exitCode !== 0) {
    return 0
  }

  const parsedSize = Number(result.stdout.trim())
  return Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0
}

const readHeadFileSizes = async (repoRoot: string, signal?: AbortSignal) => {
  const result = await runGit(repoRoot, ['ls-tree', '-r', '-l', '-z', 'HEAD'], {
    allowFailure: true,
    signal,
  })

  if (result.exitCode !== 0) {
    return null
  }

  const sizes = new Map<string, number>()
  for (const entry of result.stdout.split('\0')) {
    const separatorIndex = entry.indexOf('\t')
    if (separatorIndex < 0) {
      continue
    }

    const metadata = entry.slice(0, separatorIndex).trim().split(/\s+/)
    const relativePath = entry.slice(separatorIndex + 1)
    const size = Number(metadata.at(-1))

    if (relativePath && Number.isFinite(size) && size >= 0) {
      sizes.set(relativePath, size)
    }
  }

  return sizes
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
  signal?: AbortSignal,
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
      { allowFailure: true, signal },
    )

    if (result.aborted || result.timedOut) {
      return ''
    }

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

const createOmittedEditedFile = (
  change: Pick<GitChange, 'path' | 'originalPath' | 'kind'>,
  patchOmittedReason: NonNullable<StreamEditedFile['patchOmittedReason']>,
): StreamEditedFile => ({
  path: change.path,
  ...(change.originalPath ? { originalPath: change.originalPath } : {}),
  kind: change.kind,
  addedLines: 0,
  removedLines: 0,
  patch: '',
  patchOmittedReason,
})

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

const normalizeGitDiffPath = (rawPath: string) => {
  const withoutTimestamp = rawPath.split('\t', 1)[0] ?? rawPath
  if (withoutTimestamp === '/dev/null') {
    return null
  }

  const decoded = decodeGitStatusPath(withoutTimestamp)
  return decoded.replace(/^[ab]\//, '')
}

const splitGitPatchBlocks = (patch: string) => {
  const blocks: string[] = []
  let current: string[] = []

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      blocks.push(current.join('\n').trim())
      current = []
    }

    if (current.length > 0 || line.startsWith('diff --git ')) {
      current.push(line)
    }
  }

  if (current.length > 0) {
    blocks.push(current.join('\n').trim())
  }

  return blocks.filter(Boolean)
}

/**
 * Reads a block's first line plus its first `--- ` / `+++ ` markers without
 * materializing one string per patch line. Semantics are identical to the old
 * `block.split('\n')` + `lines.find(...)` pair: first occurrence wins, and a
 * block missing either marker falls back to its `diff --git` header line.
 */
const scanGitPatchBlockHeader = (block: string) => {
  let headerLine = block
  let oldMarker: string | null = null
  let newMarker: string | null = null
  let lineStart = 0
  let isFirstLine = true

  while (lineStart <= block.length) {
    const newlineIndex = block.indexOf('\n', lineStart)
    const lineEnd = newlineIndex < 0 ? block.length : newlineIndex

    if (isFirstLine) {
      headerLine = block.slice(lineStart, lineEnd)
      isFirstLine = false
    }

    if (oldMarker === null && block.startsWith('--- ', lineStart)) {
      oldMarker = block.slice(lineStart + 4, lineEnd)
    } else if (newMarker === null && block.startsWith('+++ ', lineStart)) {
      newMarker = block.slice(lineStart + 4, lineEnd)
    }

    if (oldMarker !== null && newMarker !== null) {
      break
    }

    lineStart = lineEnd + 1
  }

  return { headerLine, oldMarker, newMarker }
}

// `\u0000` / `\u0001` cannot appear in a git path, so they are safe as key
// separator and "no path" sentinel. The `m` / `h` prefixes keep marker-derived
// keys from ever colliding with raw `diff --git ...` header keys.
const gitPatchBlockMarkerKey = (oldPath: string | null, newPath: string | null) =>
  `m\u0000${oldPath ?? '\u0001'}\u0000${newPath ?? '\u0001'}`

const gitPatchBlockHeaderKey = (headerLine: string) => `h\u0000${headerLine}`

/**
 * 症状：Git 卡片刷新时输入、切 tab、开新会话一起卡顿（关掉 Git 卡片即恢复）。
 * 根因：旧 `findGitPatchBlock` 对每个 change 线性扫描全部 patch block，且每个 block 内部
 *   再 `split('\n')` 全量切行 —— 完整的 N×N。2026-08-10 实测（同机同数据，legacy vs 本
 *   实现）：60 改动/200KB patch 12ms→1ms，120/529KB 56ms→0ms，200/1311KB 230ms→0ms，
 *   耗时随 N 平方增长实锤。这段跑在 Electron 主进程的 JS 主线程上，直接顶住输入事件派发。
 * 被否决：只把 `split('\n')` 换成 `slice` 早停并不够 —— 外层 N×N 的扫描才是主项；也不能
 *   改成"按 change.path 直接查 Map"，因为匹配规则包含 /dev/null、重命名 old/new、引号
 *   转义路径和 header 兜底四种形态，必须按 block 自身的判定口径建键才能保持语义不变。
 */
export const createGitPatchBlockIndex = (blocks: readonly string[]) => {
  const byKey = new Map<string, { order: number; block: string }>()

  for (let order = 0; order < blocks.length; order += 1) {
    const block = blocks[order]!
    const { headerLine, oldMarker, newMarker } = scanGitPatchBlockHeader(block)
    const key = oldMarker !== null && newMarker !== null
      ? gitPatchBlockMarkerKey(normalizeGitDiffPath(oldMarker), normalizeGitDiffPath(newMarker))
      : gitPatchBlockHeaderKey(headerLine)

    // First writer wins, mirroring `Array#find` returning the earliest match.
    if (!byKey.has(key)) {
      byKey.set(key, { order, block })
    }
  }

  const find = (change: GitChange) => {
    const expectedOldPath = change.kind === 'added'
      ? null
      : (change.originalPath ?? change.path).replace(/\\/g, '/')
    const expectedNewPath = change.kind === 'deleted'
      ? null
      : change.path.replace(/\\/g, '/')

    const markerMatch = byKey.get(gitPatchBlockMarkerKey(expectedOldPath, expectedNewPath))
    const headerMatch = byKey.get(gitPatchBlockHeaderKey(
      `diff --git a/${change.originalPath ?? change.path} b/${change.path}`,
    ))

    if (markerMatch && headerMatch) {
      return markerMatch.order < headerMatch.order ? markerMatch.block : headerMatch.block
    }

    return (markerMatch ?? headerMatch)?.block ?? ''
  }

  return { find }
}

const createAddedFilePatch = (relativePath: string, content: string | null) => {
  if (!content) {
    return ''
  }

  const normalized = content.replace(/\r\n/g, '\n')
  const hasTrailingNewline = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (hasTrailingNewline) {
    lines.pop()
  }
  if (lines.length === 0) {
    return ''
  }

  const range = lines.length === 1 ? '+1' : `+1,${lines.length}`
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 ${range} @@`,
    ...lines.map((line) => `+${line}`),
    ...(hasTrailingNewline ? [] : ['\\ No newline at end of file']),
  ].join('\n')
}

type GitPreviewCandidate = {
  change: GitChange
  currentFileSize: number
  baselineFileSize: number
  combinedFileSize: number
}

const getGitPreviewCandidate = async (
  repoRoot: string,
  change: GitChange,
  headFileSizes: Map<string, number> | null,
): Promise<GitPreviewCandidate> => {
  const currentFileSize = change.kind === 'deleted'
    ? 0
    : await readWorkspaceFileSize(repoRoot, change.path)
  const baselinePath = (change.originalPath ?? change.path).replace(/\\/g, '/')
  const baselineFileSize = change.kind === 'untracked' || change.kind === 'added'
    ? 0
    : (headFileSizes?.get(baselinePath) ?? await readHeadFileSize(repoRoot, baselinePath))

  return {
    change,
    currentFileSize,
    baselineFileSize,
    combinedFileSize: currentFileSize + baselineFileSize,
  }
}

const getGitDiffBatchPathChars = (change: GitChange) =>
  change.path.length + (change.originalPath?.length ?? 0) + 2

const readTrackedGitPatchBlocks = async (
  repoRoot: string,
  candidates: GitPreviewCandidate[],
) => {
  const paths = Array.from(new Set(candidates.flatMap(({ change }) => [
    ...(change.originalPath ? [change.originalPath] : []),
    change.path,
  ])))
  const result = await runGit(
    repoRoot,
    ['diff', '--unified=3', '--no-color', '--no-ext-diff', 'HEAD', '--', ...paths],
    { allowFailure: true },
  )

  return result.exitCode === 0 ? splitGitPatchBlocks(result.stdout) : []
}

const hydrateGitChangePreviews = async (repoRoot: string, changes: GitChange[]) => {
  const headFileSizes = await readHeadFileSizes(repoRoot)
  const candidates = await Promise.all(
    changes.map(async (change) => {
      try {
        return await getGitPreviewCandidate(repoRoot, change, headFileSizes)
      } catch {
        return {
          change,
          currentFileSize: Number.POSITIVE_INFINITY,
          baselineFileSize: Number.POSITIVE_INFINITY,
          combinedFileSize: Number.POSITIVE_INFINITY,
        }
      }
    }),
  )
  const hydratedChanges: GitChange[] = []
  let remainingPreviewBudgetBytes = gitChangePreviewMaxTotalBytes
  let index = 0

  const appendPreview = (change: GitChange, patch: string) => {
    const { addedLines, removedLines } = countPatchLines(patch)
    const preview = patch.length > gitChangePreviewMaxPatchChars
      ? { patch: '', addedLines, removedLines }
      : { patch, addedLines, removedLines }

    if (preview.patch) {
      remainingPreviewBudgetBytes = Math.max(
        0,
        remainingPreviewBudgetBytes - preview.patch.length,
      )
    }

    hydratedChanges.push({ ...change, ...preview })
  }

  while (index < candidates.length) {
    const candidate = candidates[index]!
    const { change } = candidate
    const shouldSkip =
      remainingPreviewBudgetBytes <= 0 ||
      candidate.currentFileSize > gitChangePreviewMaxFileBytes ||
      candidate.baselineFileSize > gitChangePreviewMaxFileBytes ||
      candidate.combinedFileSize > remainingPreviewBudgetBytes

    if (shouldSkip) {
      hydratedChanges.push({ ...change, patch: '' })
      index += 1
      continue
    }

    if (change.kind === 'untracked') {
      try {
        appendPreview(
          change,
          createAddedFilePatch(change.path, await readWorkspaceFile(repoRoot, change.path)),
        )
      } catch {
        hydratedChanges.push(change)
      }
      index += 1
      continue
    }

    const batch: GitPreviewCandidate[] = []
    let batchCombinedBytes = 0
    let batchPathChars = 0

    for (let batchIndex = index; batchIndex < candidates.length; batchIndex += 1) {
      const nextCandidate = candidates[batchIndex]!
      if (nextCandidate.change.kind === 'untracked') {
        break
      }
      if (
        nextCandidate.currentFileSize > gitChangePreviewMaxFileBytes ||
        nextCandidate.baselineFileSize > gitChangePreviewMaxFileBytes ||
        nextCandidate.combinedFileSize > remainingPreviewBudgetBytes
      ) {
        break
      }

      const nextPathChars = getGitDiffBatchPathChars(nextCandidate.change)
      if (
        batch.length > 0 && (
          batchCombinedBytes + nextCandidate.combinedFileSize > remainingPreviewBudgetBytes ||
          batchPathChars + nextPathChars > gitChangePreviewDiffBatchChars
        )
      ) {
        break
      }

      batch.push(nextCandidate)
      batchCombinedBytes += nextCandidate.combinedFileSize
      batchPathChars += nextPathChars
    }

    if (batch.length === 0) {
      try {
        const preview = await readGitChangePreview(
          repoRoot,
          change,
          remainingPreviewBudgetBytes,
        )
        appendPreview(change, preview.patch ?? '')
      } catch {
        hydratedChanges.push(change)
      }
      index += 1
      continue
    }

    const blocks = await readTrackedGitPatchBlocks(repoRoot, batch)
    const blockIndex = createGitPatchBlockIndex(blocks)
    for (const batchCandidate of batch) {
      if (batchCandidate.combinedFileSize > remainingPreviewBudgetBytes) {
        hydratedChanges.push({ ...batchCandidate.change, patch: '' })
        continue
      }

      const patch = blockIndex.find(batchCandidate.change)
      if (patch) {
        appendPreview(batchCandidate.change, patch)
        continue
      }

      try {
        const preview = await readGitChangePreview(
          repoRoot,
          batchCandidate.change,
          remainingPreviewBudgetBytes,
        )
        appendPreview(batchCandidate.change, preview.patch ?? '')
      } catch {
        hydratedChanges.push(batchCandidate.change)
      }
    }
    index += batch.length
  }

  return hydratedChanges
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

const getRepositoryRoot = async (workspacePath: string, signal?: AbortSignal) => {
  const result = await runGit(workspacePath, ['rev-parse', '--show-toplevel'], {
    allowFailure: true,
    signal,
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

const inspectResolvedGitWorkspace = async (
  workspacePath: string,
  repoRoot: string,
  options?: InspectGitWorkspaceOptions,
): Promise<GitStatus> => {
  const statusResult = await runGit(
    repoRoot,
    ['status', '--branch', '--porcelain=v1', '--untracked-files=all'],
    { signal: options?.signal },
  )
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
    ? (await hydrateGitChangePreviews(repoRoot, parsedChanges)).sort(sortChanges)
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

export const inspectGitWorkspace = async (
  workspacePath: string,
  options?: InspectGitWorkspaceOptions,
): Promise<GitStatus> => {
  const repoRoot = await getRepositoryRoot(workspacePath, options?.signal)

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

  return await inspectResolvedGitWorkspace(workspacePath, repoRoot, options)
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

// 症状 — 发消息像卡住：点了发送之后窗口整片不响应，最终被 Windows 当无响应进程杀掉。
// 根因 — 这条路径在**每次发消息前**都跑，里面的 `git status --untracked-files=all` 无上界，
//   而整条路径此前完全没有超时保护；2026-08-12 实测单次 git spawn 最坏 6910ms，足以单独
//   触发 Windows 的无响应判定。
// 为什么是安静返回 null 而不是抛错 — 这份基线只用于回合结束的兜底改动卡。少显示一点
//   diff 远好过让用户发不出消息，所以超时必须降级成"这轮没有基线"，绝不能变成弹窗或
//   阻塞发送；诊断信息只留在返回值形状里（null）而不是错误路径。
// 为什么不取更小的值（先后试过 8s / 15s，都被实测打回） — 降级的代价是这一轮丢掉兜底
//   改动卡，所以阈值必须**远离正常耗时分布**（同 pitfall 243 的教训：兜底值落在正常耗时
//   中间 = 正常波动就触发）。2026-08-12 在有负载的本机上实测：一个只有 1~2 个文件的临时
//   仓库，这条路径跑到 19s，git-workspace.test.ts 里单条真实 git 用例甚至跑到 90s。
//   这里要的是"有上界"（此前是无穷，一个卡住的 git 能让回合永远等下去），不是调紧。
export const captureWorkspaceSnapshotTimeoutMs = 60_000

const createGitDeadlineSignal = (timeoutMs?: number, external?: AbortSignal) => {
  const bounded = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined

  if (bounded && external) {
    return AbortSignal.any([bounded, external])
  }

  return bounded ?? external
}

export const captureWorkspaceSnapshot = async (
  workspacePath: string,
  options?: CaptureWorkspaceSnapshotOptions,
): Promise<WorkspaceSnapshot | null> => {
  const signal = createGitDeadlineSignal(
    options?.timeoutMs ?? captureWorkspaceSnapshotTimeoutMs,
    options?.signal,
  )

  try {
    return await captureWorkspaceSnapshotWithin(workspacePath, signal)
  } catch {
    return null
  }
}

const captureWorkspaceSnapshotWithin = async (
  workspacePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot | null> => {
  const status = await inspectGitWorkspace(workspacePath, {
    includeChangePreviews: false,
    // 这份快照只读 isRepository / repoRoot / changes，`git log -1` 拿的 lastCommit
    // 从未被用到——每次发消息白白多一次主线程同步 spawn。
    includeRepositoryDetails: false,
    signal,
  })

  if (!status.isRepository) {
    return null
  }

  const files: WorkspaceSnapshot['files'] = {}
  let retainedBytes = 0
  let retainedFiles = 0
  // Preserve tracked dirty baselines first. Untracked cache/build output is
  // lower value for the end-of-turn fallback and is the common explosion path.
  const prioritizedChanges = [...status.changes].sort(
    (left, right) => Number(left.kind === 'untracked') - Number(right.kind === 'untracked'),
  )

  for (const change of prioritizedChanges) {
    if (retainedFiles >= workspaceSnapshotMaxFiles || signal?.aborted) {
      break
    }

    const fileSize = await readWorkspaceFileSize(status.repoRoot, change.path)
    if (
      fileSize > workspaceSnapshotMaxFileBytes ||
      retainedBytes + fileSize > workspaceSnapshotMaxTotalBytes
    ) {
      continue
    }

    const content = await readWorkspaceFile(status.repoRoot, change.path)
    const contentBytes = content === null ? 0 : Buffer.byteLength(content)
    if (
      contentBytes > workspaceSnapshotMaxFileBytes ||
      retainedBytes + contentBytes > workspaceSnapshotMaxTotalBytes
    ) {
      continue
    }

    files[change.path] = {
      path: change.path,
      originalPath: change.originalPath,
      content: content === null ? null : workspaceSnapshotContentStore.intern(content),
    }
    retainedBytes += contentBytes
    retainedFiles += 1
  }

  return {
    workspacePath,
    repoRoot: status.repoRoot,
    changes: status.changes,
    files,
  }
}

// Providers report edited files in whatever shape their tool inputs use —
// Claude sends absolute OS paths (`D:\repo\src\app.js`), Codex may send either
// form — while git status yields repo-relative posix paths. Normalize both
// sides to one canonical key or the touched-path filter silently matches
// nothing and the end-of-turn fallback edits card never fires.
const canonicalTouchedPathKey = (rawPath: string, repoRootKey: string) => {
  let key = rawPath.trim().replaceAll('\\', '/')

  if (process.platform === 'win32') {
    key = key.toLowerCase()
  }

  if (repoRootKey && key.startsWith(`${repoRootKey}/`)) {
    key = key.slice(repoRootKey.length + 1)
  }

  return key
}

const buildTouchedPathMatcher = (repoRoot: string, touchedPaths: Set<string>) => {
  let repoRootKey = repoRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  if (process.platform === 'win32') {
    repoRootKey = repoRootKey.toLowerCase()
  }

  const touchedKeys = new Set<string>()
  for (const touched of touchedPaths) {
    const key = canonicalTouchedPathKey(touched, repoRootKey)
    if (key) {
      touchedKeys.add(key)
    }
  }

  return (repoRelativePath: string) => touchedKeys.has(canonicalTouchedPathKey(repoRelativePath, repoRootKey))
}

export const diffWorkspaceSnapshot = async (
  snapshot: WorkspaceSnapshot | null,
  workspacePath: string,
  touchedPaths?: Set<string>,
  limits: WorkspaceSnapshotDiffLimits = {},
): Promise<WorkspaceSnapshotDiff> => {
  if (!snapshot) {
    return { files: [] }
  }

  if (touchedPaths && touchedPaths.size === 0) {
    return { files: [] }
  }

  // 症状 — 上一轮的收尾 diff 超时后那一串 git 还在跑，和下一轮的 diff 叠加。
  // 根因 — chat-manager 的硬超时曾只是 Promise.race，既不 abort 也不 kill；现在它传
  //   AbortSignal 进来，取消必须在每个 await 边界生效，否则最多还会再派生 3×256 个
  //   子进程（每次 spawn 都是主线程同步阻塞，2026-08-12 实测最坏单次 6910ms）。
  // 为什么是"返回已攒到的结果"而不是抛错 — 取消是我们自己发起的，调用方要的是安静
  //   降级（少几个改动文件），抛错会让收尾路径把整轮 edits 都丢掉。
  const signal = limits.signal

  if (signal?.aborted) {
    return { files: [] }
  }

  let currentStatus: GitStatus
  try {
    currentStatus = await inspectGitWorkspace(workspacePath, {
      includeChangePreviews: false,
      // 与快照同理：这条路径只用 repoRoot / changes，`git log -1` 是白跑的一次 spawn。
      includeRepositoryDetails: false,
      signal,
    })
  } catch {
    return { files: [] }
  }

  if (!currentStatus.isRepository || currentStatus.repoRoot !== snapshot.repoRoot) {
    return { files: [] }
  }

  const editedFiles: StreamEditedFile[] = []
  const maxFileBytes = limits.maxFileBytes ?? workspaceSnapshotMaxFileBytes
  const maxTotalBytes = limits.maxTotalBytes ?? workspaceSnapshotMaxTotalBytes
  const maxFiles = limits.maxFiles ?? workspaceSnapshotMaxFiles
  const handledSnapshotPaths = new Set<string>()
  const isTouchedPath = touchedPaths ? buildTouchedPathMatcher(snapshot.repoRoot, touchedPaths) : null
  const isChangeTouched = (change: Pick<GitChange, 'path'>) =>
    !isTouchedPath || isTouchedPath(change.path)
  const baselineChangePaths = new Set(
    snapshot.changes.flatMap((change) =>
      change.originalPath ? [change.path, change.originalPath] : [change.path],
    ),
  )
  const currentChangePaths = new Set(
    currentStatus.changes.flatMap((change) =>
      change.originalPath ? [change.path, change.originalPath] : [change.path],
    ),
  )
  let retainedPatchBytes = 0
  let retainedDetailFiles = 0
  // HEAD 里每个文件的大小此前是逐文件一次 `git cat-file -s`，256 个变更文件就是
  // 最多 256 次主线程同步 spawn。`ls-tree -r -l -z HEAD` 一次拿全（预览路径早就
  // 这么做了），语义完全一致：两者都返回 HEAD 里该 blob 的字节数。惰性求值，
  // 只有真需要 HEAD 基线的那一轮才付这一次 spawn 的钱。
  let headFileSizes: Map<string, number> | null | undefined
  const getHeadFileSize = async (relativePath: string) => {
    const normalizedPath = relativePath.replace(/\\/g, '/')

    if (headFileSizes === undefined) {
      headFileSizes = await readHeadFileSizes(snapshot.repoRoot, signal)
    }

    return headFileSizes?.get(normalizedPath)
      ?? (headFileSizes ? 0 : await readHeadFileSize(snapshot.repoRoot, normalizedPath, signal))
  }

  for (const change of currentStatus.changes) {
    if (signal?.aborted) {
      break
    }

    if (!isChangeTouched(change)) {
      continue
    }

    const snapshotFile =
      snapshot.files[change.path] ??
      (change.originalPath ? snapshot.files[change.originalPath] : undefined)
    if (snapshotFile) {
      handledSnapshotPaths.add(snapshotFile.path)
    }

    // The path was already dirty when the turn started but its baseline was
    // omitted by the safety budget. Comparing it with HEAD/null would falsely
    // attribute old content to the agent and could reload the same huge file.
    if (
      !snapshotFile &&
      (baselineChangePaths.has(change.path) ||
        (change.originalPath ? baselineChangePaths.has(change.originalPath) : false))
    ) {
      if (isTouchedPath) {
        editedFiles.push(createOmittedEditedFile(change, 'baseline-unavailable'))
      }
      continue
    }

    if (retainedDetailFiles >= maxFiles) {
      editedFiles.push(createOmittedEditedFile(change, 'detail-file-limit'))
      continue
    }

    const currentFileSize = await readWorkspaceFileSize(snapshot.repoRoot, change.path)
    if (currentFileSize > maxFileBytes) {
      editedFiles.push(createOmittedEditedFile(change, 'file-too-large'))
      continue
    }

    const needsHeadBaseline =
      !snapshotFile && change.kind !== 'untracked' && change.kind !== 'added'
    const headFileSize = needsHeadBaseline
      ? await getHeadFileSize(change.originalPath ?? change.path)
      : 0
    if (headFileSize > maxFileBytes) {
      editedFiles.push(createOmittedEditedFile(change, 'file-too-large'))
      continue
    }

    const currentContent = await readWorkspaceFile(snapshot.repoRoot, change.path)
    const baselineContent = snapshotFile
      ? snapshotFile.content
      : change.kind === 'untracked' || change.kind === 'added'
        ? null
        : await readHeadFile(snapshot.repoRoot, change.originalPath ?? change.path, signal)

    const patch = await createPatch(
      snapshotFile?.originalPath ?? change.originalPath ?? change.path,
      baselineContent,
      change.path,
      currentContent,
      signal,
    )

    if (!patch) {
      continue
    }

    const patchBytes = Buffer.byteLength(patch)
    if (retainedPatchBytes + patchBytes > maxTotalBytes) {
      editedFiles.push(createOmittedEditedFile(change, 'patch-budget'))
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
    retainedPatchBytes += patchBytes
    retainedDetailFiles += 1
  }

  for (const snapshotFile of Object.values(snapshot.files)) {
    if (signal?.aborted) {
      break
    }

    if (handledSnapshotPaths.has(snapshotFile.path)) {
      continue
    }

    if (isTouchedPath && !isTouchedPath(snapshotFile.path)) {
      continue
    }

    const currentFileSize = await readWorkspaceFileSize(snapshot.repoRoot, snapshotFile.path)
    if (currentFileSize > maxFileBytes) {
      editedFiles.push(createOmittedEditedFile({
        path: snapshotFile.path,
        originalPath: snapshotFile.originalPath,
        kind: 'modified',
      }, 'file-too-large'))
      continue
    }

    const currentContent = await readWorkspaceFile(snapshot.repoRoot, snapshotFile.path)
    if (currentContent === snapshotFile.content) {
      continue
    }

    const fallbackChange = {
      path: snapshotFile.path,
      originalPath: snapshotFile.originalPath,
      kind: currentContent === null ? 'deleted' as const : 'modified' as const,
    }
    if (retainedDetailFiles >= maxFiles) {
      editedFiles.push(createOmittedEditedFile(fallbackChange, 'detail-file-limit'))
      continue
    }

    const patch = await createPatch(
      snapshotFile.originalPath ?? snapshotFile.path,
      snapshotFile.content,
      snapshotFile.path,
      currentContent,
      signal,
    )

    if (!patch) {
      continue
    }

    const patchBytes = Buffer.byteLength(patch)
    if (retainedPatchBytes + patchBytes > maxTotalBytes) {
      editedFiles.push(createOmittedEditedFile(fallbackChange, 'patch-budget'))
      continue
    }

    const { addedLines, removedLines } = countPatchLines(patch)
    editedFiles.push({
      path: snapshotFile.path,
      originalPath: snapshotFile.originalPath,
      kind: fallbackChange.kind,
      addedLines,
      removedLines,
      patch,
    })
    retainedPatchBytes += patchBytes
    retainedDetailFiles += 1
  }

  // An omitted dirty baseline can disappear from `git status` altogether
  // (for example, a pre-existing untracked file is deleted or a dirty tracked
  // file is restored to HEAD). The provider-reported touched path is still
  // authoritative evidence that the turn changed it, so preserve the filename
  // even though neither currentStatus.changes nor snapshot.files can carry it.
  if (isTouchedPath) {
    for (const baselineChange of snapshot.changes) {
      if (
        snapshot.files[baselineChange.path] ||
        currentChangePaths.has(baselineChange.path) ||
        (baselineChange.originalPath && currentChangePaths.has(baselineChange.originalPath)) ||
        !isChangeTouched(baselineChange)
      ) {
        continue
      }

      const currentFileExists = await workspaceFileExists(snapshot.repoRoot, baselineChange.path)
      const fallbackKind: GitChangeKind = !currentFileExists
        ? 'deleted'
        : baselineChange.kind === 'deleted'
          ? 'added'
          : 'modified'

      editedFiles.push(createOmittedEditedFile({
        path: baselineChange.path,
        originalPath: baselineChange.originalPath,
        kind: fallbackKind,
      }, 'baseline-unavailable'))
    }
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
  const repoRoot = await getRepositoryRoot(workspacePath)
  const normalizedPaths = normalizePathList(paths)

  if (!repoRoot) {
    throw new Error(notRepositoryNote)
  }

  if (normalizedPaths.length === 0) {
    throw new Error('Choose at least one file to update its staged state.')
  }

  if (staged) {
    // Staging deliberately does NOT expand a rename to its original path, and
    // this asymmetry with the unstage branch below is load-bearing:
    // 症状 — expanding it makes every rename stage fail outright.
    // 根因 — a staged rename (`R old -> new`) has already recorded the removal
    //   of `old`, so `old` is in neither the worktree nor the index; 2026-08-02
    //   实测 `git add old` then dies with `fatal: pathspec 'old' did not match
    //   any files` and aborts the whole (possibly hundreds-of-paths) batch.
    //   Adding `new` alone already carries the complete rename.
    // 被否决 — `git add` has no `--ignore-unmatch` escape hatch, and probing
    //   each original path for existence would cost an extra Git process on the
    //   hot staging path for a no-op. Guarded by the "stages a modified rename
    //   target without feeding git add the vanished original path" test.
    await runGitWithPathspecs(repoRoot, ['add'], normalizedPaths)
    return await inspectResolvedGitWorkspace(
      workspacePath,
      repoRoot,
      { includeChangePreviews: false },
    )
  }

  // 症状 — unchecking a renamed file left `D old` still staged plus `?? new`.
  // 根因 — the caller only knows `change.path`, so unstaging reset just the new
  //   side of the rename while the index kept the deletion of the original.
  // 被否决 — resolving the pair in the caller (the Git card) would leave the
  //   server API silently half-correct for every other caller; read the index
  //   here instead, through the index-only query in `readStagedRenamePairs`
  //   (see its comment for why this is not another `git status`).
  const unstagePaths = expandStagedRenamePathspecs(
    normalizedPaths,
    await readStagedRenamePairs(repoRoot),
  )

  const restoreResult = await runGitWithPathspecs(repoRoot, ['restore', '--staged'], unstagePaths, {
    allowFailure: true,
  })

  if (restoreResult.exitCode !== 0) {
    if (await hasHeadCommit(repoRoot)) {
      await runGitWithPathspecs(repoRoot, ['reset', '--quiet', 'HEAD'], unstagePaths)
    } else {
      await runGitWithPathspecs(
        repoRoot,
        ['rm', '--cached', '--quiet', '--ignore-unmatch'],
        unstagePaths,
        {
          allowFailure: true,
        },
      )
    }
  }

  return await inspectResolvedGitWorkspace(
    workspacePath,
    repoRoot,
    { includeChangePreviews: false },
  )
}

export const discardGitWorkspaceChanges = async ({
  workspacePath,
  paths,
}: GitDiscardOptions): Promise<GitStatus> => {
  const status = await inspectGitWorkspace(workspacePath, { includeChangePreviews: false })
  const normalizedPaths = normalizePathList(paths)

  if (!status.isRepository) {
    throw new Error(status.note ?? notRepositoryNote)
  }

  if (normalizedPaths.length === 0) {
    throw new Error('Choose at least one file to discard.')
  }

  const requestedPathSet = new Set(normalizedPaths)
  const requestedChanges = status.changes.filter((change) => requestedPathSet.has(change.path))

  if (requestedChanges.length === 0) {
    throw new Error('Choose at least one changed file to discard.')
  }

  if (requestedChanges.some((change) => change.conflicted)) {
    throw new Error('Resolve merge conflicts before discarding these files.')
  }

  // Staged-new paths (including the new side of renames/copies) leave the
  // index first; restoring them from HEAD would fail because HEAD has no blob.
  const indexRemovePaths: string[] = []
  const deleteWorkingTreePaths: string[] = []
  const restorePaths: string[] = []

  for (const change of requestedChanges) {
    if (isRenameChange(change)) {
      indexRemovePaths.push(change.path)
      deleteWorkingTreePaths.push(change.path)
      restorePaths.push(change.originalPath!)
      continue
    }

    if (change.kind === 'untracked') {
      deleteWorkingTreePaths.push(change.path)
      continue
    }

    // A copy target is an addition that happens to know where its content came
    // from; discarding it must drop only the new path. Restoring `originalPath`
    // the way the rename branch does would roll back the source file's own
    // staged edits, which the user never selected (see `isRenameChange`).
    if (change.stagedStatus === 'A' || isCopyChange(change)) {
      indexRemovePaths.push(change.path)
      if (change.workingTreeStatus !== 'D') {
        deleteWorkingTreePaths.push(change.path)
      }
      continue
    }

    restorePaths.push(change.path)
  }

  if (indexRemovePaths.length > 0) {
    await runGitWithPathspecs(
      status.repoRoot,
      ['rm', '--cached', '--quiet', '--ignore-unmatch'],
      indexRemovePaths,
      { allowFailure: true },
    )
  }

  for (const relativePath of deleteWorkingTreePaths) {
    await rm(path.join(status.repoRoot, relativePath), { force: true })
  }

  if (restorePaths.length > 0) {
    await runGitWithPathspecs(
      status.repoRoot,
      ['restore', '--source=HEAD', '--staged', '--worktree'],
      restorePaths,
    )
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
      await runGitWithPathspecs(
        status.repoRoot,
        ['rm', '--cached', '--quiet', '--ignore-unmatch'],
        canceledAdditionPaths,
      )
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
    // 症状 — committing a renamed file produced a tree holding BOTH names and
    //   left `D old` staged, so the next commit silently carried the leftover.
    // 根因 — the selection only names the new path, and `git commit --only`
    //   commits exactly the pathspecs it is given: the rename's deletion half
    //   was never in the pathspec list. 2026-08-02 实测 `--only -- old new`
    //   records the single `rename old => new` and leaves the tree clean.
    // 被否决 — falling back to a full `git commit` would drag in every other
    //   staged file the user deliberately left unchecked. Copies (`C old ->
    //   new`) are deliberately not expanded here for the same reason: `old`
    //   still exists with its own staged edits (see `isRenameChange`).
    // NOTE — this path reuses the `inspectGitWorkspace` above rather than
    //   `readStagedRenamePairs`; that status read is already required to drop
    //   conflicted and canceled-addition paths, so an index-only query would
    //   add a git process here instead of removing one.
    normalizedPaths = normalizePathList(
      normalizedPaths.flatMap((selectedPath) => {
        const change = refreshedChangesByPath.get(selectedPath)

        if (change === undefined || change.conflicted || isCanceledStagedAddition(change)) {
          return []
        }

        return renamePathspecsForChange(change)
      }),
    )

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
    args.push('--only', '--pathspec-from-file=-', '--pathspec-file-nul')
  }

  await runGit(
    status.repoRoot,
    args,
    normalizedPaths.length > 0
      ? { stdin: encodeGitPathspecStdin(normalizedPaths) }
      : undefined,
  )

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

const formatGitDiffByteSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KiB`
  }

  return `${bytes} B`
}

/**
 * 症状 — opening a large commit in Git history froze the renderer; a probe
 *   commit shipped 8.5 MiB of patch text straight into one message bubble.
 * 根因 — `fetchCommitDiff` returned `git show` stdout verbatim with no budget,
 *   unlike every other patch producer here (`gitChangePreviewMaxPatchChars`,
 *   `workspaceSnapshotMaxTotalBytes`), so commit size scaled memory linearly.
 * 被否决 — dropping the patch entirely the way `buildGitChangePreview` does on
 *   overflow is wrong for this surface (the user opened it to read the diff),
 *   and capping inside `runGit` would silently corrupt status/log callers. Keep
 *   the head of the patch and say out loud that the tail was cut, so a
 *   truncated diff can never be mistaken for a short one.
 */
const truncateGitCommitDiff = (patch: string, hash: string, maxPatchBytes: number) => {
  const totalBytes = Buffer.byteLength(patch)

  if (totalBytes <= maxPatchBytes) {
    return patch
  }

  const head = Buffer.from(patch, 'utf8').subarray(0, maxPatchBytes).toString('utf8')
  const lastLineBreak = head.lastIndexOf('\n')
  // Cut on a line boundary so the kept part stays a readable patch. That also
  // drops the U+FFFD a mid-codepoint byte slice leaves behind; strip it
  // explicitly for the (rare) patch whose head holds no line break at all.
  let kept = lastLineBreak > 0 ? head.slice(0, lastLineBreak + 1) : head
  while (kept.length > 0 && kept.charCodeAt(kept.length - 1) === 0xfffd) {
    kept = kept.slice(0, -1)
  }
  const notice =
    `[Chill Vibe] Diff truncated after ${formatGitDiffByteSize(Buffer.byteLength(kept))} ` +
    `of ${formatGitDiffByteSize(totalBytes)}. Run \`git show ${hash}\` to read the full patch.`

  return `${kept}\n${notice}\n`
}

export const fetchCommitDiff = async (
  workspacePath: string,
  hash: string,
  limits: GitCommitDiffLimits = {},
): Promise<string> => {
  const status = await assertRepository(workspacePath)
  const result = await runGit(status.repoRoot, ['show', hash, '--format=', '--patch'], {
    allowFailure: true,
  })

  if (result.exitCode !== 0) {
    throw new Error(formatGitFailure(['show', hash], result))
  }

  return truncateGitCommitDiff(
    result.stdout,
    hash,
    limits.maxPatchBytes ?? gitCommitDiffMaxPatchBytes,
  )
}
