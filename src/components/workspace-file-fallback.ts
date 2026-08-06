// 症状：正文里的 `PlayerRunSystem.OverflowLoot.cs:195` 点开只报「工作区里没有这个文件」。
// 根因：模型在散文里几乎总是写裸文件名或短相对路径，而 resolveOpenableFilePath 是纯字符串
//   解析（structured-file-paths.ts:162），把裸名当成工作区根下的文件，真实文件却在
//   Assets/Scripts/Run/ 之类的深层目录里 → 打开即 ENOENT（2026-08-05 用户实测）。
// 被否决的替代方案：在渲染阶段对每个候选做存在性预校验（Copilot 的 stat 缓存做法）——
//   会把跨进程 IO 拖进 markdown 渲染路径，还要处理异步一致性；这里只在**点击时**探测一次，
//   代价是一次目录列举，且只有真的找不到时才走全仓搜索。

import type { FileSearchEntry } from '../../shared/schema'

export type WorkspaceFileLookup = {
  listDirectory: (relativeDir: string) => Promise<{ name: string; isDirectory: boolean }[]>
  searchFiles: (query: string) => Promise<FileSearchEntry[]>
}

const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|[\\/])/i

// searchWorkspaceFiles walks the whole tree and only skips `.git` / `node_modules`
// (server/file-system.ts:67). A Unity workspace drags Library/ + Temp/ along, so the
// walk can run for seconds — and a click that hangs is worse than one that reports a
// missing file. Past the budget we fall back to the original path and the existing
// "工作区里没有这个文件" message.
const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

const toSegments = (value: string) => value.split(/[\\/]/).filter(Boolean)

const countMatchingSuffixSegments = (candidate: string[], entry: string[]) => {
  let matched = 0

  while (
    matched < candidate.length
    && matched < entry.length
    && candidate[candidate.length - 1 - matched]?.toLowerCase()
      === entry[entry.length - 1 - matched]?.toLowerCase()
  ) {
    matched += 1
  }

  return matched
}

// Ranking is deliberately total and deterministic: same inputs must always open the
// same file, or "click the link twice, land in two different places" becomes a bug.
export const pickWorkspaceFileFallback = (
  candidatePath: string,
  entries: readonly FileSearchEntry[],
): string | null => {
  const candidateSegments = toSegments(candidatePath)
  const basename = candidateSegments.at(-1)?.toLowerCase()

  if (!basename) {
    return null
  }

  let best: { path: string; suffix: number; depth: number } | null = null

  for (const entry of entries) {
    if (entry.isDirectory) {
      continue
    }

    const entrySegments = toSegments(entry.path)

    if (entrySegments.at(-1)?.toLowerCase() !== basename) {
      continue
    }

    const scored = {
      path: entry.path,
      suffix: countMatchingSuffixSegments(candidateSegments, entrySegments),
      depth: entrySegments.length,
    }

    if (
      !best
      || scored.suffix > best.suffix
      || (scored.suffix === best.suffix
        && (scored.depth < best.depth || (scored.depth === best.depth && scored.path < best.path)))
    ) {
      best = scored
    }
  }

  return best?.path ?? null
}

export const resolveExistingWorkspaceFilePath = async (
  candidatePath: string,
  lookup: WorkspaceFileLookup,
  options: { searchTimeoutMs?: number } = {},
): Promise<string> => {
  const timeoutMs = options.searchTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS
  const trimmed = candidatePath.trim()

  // Absolute paths already point somewhere concrete (tool cards, out-of-workspace
  // files); guessing a workspace twin for them would open the wrong file.
  if (!trimmed || ABSOLUTE_PATH.test(trimmed)) {
    return candidatePath
  }

  const segments = toSegments(trimmed)
  const basename = segments.at(-1)

  if (!basename) {
    return candidatePath
  }

  const relativeDir = segments.slice(0, -1).join('/')

  try {
    const entries = await withTimeout(lookup.listDirectory(relativeDir), timeoutMs, [])

    if (entries.some((entry) => !entry.isDirectory && entry.name.toLowerCase() === basename.toLowerCase())) {
      return candidatePath
    }
  } catch {
    // A missing parent directory is exactly the case the search fallback handles.
  }

  try {
    const entries = await withTimeout(lookup.searchFiles(basename), timeoutMs, [])

    return pickWorkspaceFileFallback(trimmed, entries) ?? candidatePath
  } catch {
    return candidatePath
  }
}
