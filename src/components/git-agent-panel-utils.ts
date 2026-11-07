import type { AppLanguage, GitStatus } from '../../shared/schema'

export type CommitStrategy = {
  label: string
  description: string
  commits: Array<{ summary: string; paths: string[] }>
}

export type AnalysisResult = {
  summary: string
  strategies: CommitStrategy[]
}

/** Keep the total prompt under 6 000 chars to avoid Windows ENAMETOOLONG. */
const MAX_PROMPT_CHARS = 6000
const MAX_PATCH_PER_FILE = 400

const languageRule = (language: AppLanguage) =>
  language === 'zh-CN'
    ? '所有面向用户的文本字段，包括 summary、strategy 的 label/description，以及任何 commit summary，都必须使用简体中文。'
    : 'All human-readable text fields, including summary, strategy labels/descriptions, and any commit summaries, must be written in English.'

// 症状 — 本地改动上千个文件时 Git 卡片的 AI 分组提交报错/超时。
// 根因 — 提示词把全部路径 + 改动列表塞进去后被硬截断在 6000 字，模型看到半截 JSON，
//   还被要求在「全部提交」里逐个写出几千个路径；输出同样放不下，只会超时或解析失败。
// 被否决 — 调大 MAX_PROMPT_CHARS：prompt 走命令行，Windows 上限就是 ENAMETOOLONG 的来源。
// 做法：超过阈值改发「目录摘要」，模型用目录前缀 / "." 声明范围，执行期由
//   scopeStrategyCommitPaths 展开成真实改动文件。
const LARGE_CHANGE_THRESHOLD = 150
const MAX_SUMMARY_DIRS = 40

const summarizeChangeDirectories = (paths: readonly string[]) => {
  const counts = new Map<string, number>()
  for (const raw of paths) {
    const segments = raw.replace(/\\/g, '/').split('/')
    const dir = segments.length > 1 ? `${segments.slice(0, Math.min(2, segments.length - 1)).join('/')}/` : './'
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1])
  const lines = sorted.slice(0, MAX_SUMMARY_DIRS).map(([dir, count]) => `- ${dir} (${count})`)
  if (sorted.length > MAX_SUMMARY_DIRS) {
    const restFiles = sorted.slice(MAX_SUMMARY_DIRS).reduce((sum, [, count]) => sum + count, 0)
    lines.push(`- ... +${sorted.length - MAX_SUMMARY_DIRS} dirs (${restFiles})`)
  }
  return lines.join('\n')
}

const buildLargeAnalysisPrompt = (gitStatus: GitStatus, language: AppLanguage) => {
  const total = gitStatus.changes.length
  const summary = summarizeChangeDirectories(gitStatus.changes.map((change) => change.path))
  const zh = language === 'zh-CN'
  const instruction = zh
    ? `你是一个 Git 提交助手。本次共有 ${total} 个改动文件，数量太大无法逐个列出，下面只给目录摘要（目录/改动数）。请按目录把改动分组，直接返回一个纯 JSON 对象，不要解释文字，也不要 markdown 代码块。

JSON 格式:
{"strategies":[{"label":"策略名","description":"说明","commits":[{"summary":"提交信息","paths":["目录/"]}]}]}

规则:
- paths 里只能写目录前缀（以 / 结尾，必须来自下面的摘要）或单个 "."，不要列举单个文件
- 第一个策略必须是"全部提交"，commits 只有一条，paths 为 ["."]
- 之后每个主要模块单独作为一个策略，label 用模块名，paths 为该模块的目录前缀
- 策略数量不超过 8 个
- ${languageRule(language)}
- 只输出 JSON，不要任何其他内容

改动目录摘要:
${summary}`
    : `You are a Git commit assistant. There are ${total} changed files — too many to list, so only a directory summary (dir/count) is given. Group the changes by directory and return a pure JSON object (no explanations, no markdown code blocks).

JSON format:
{"strategies":[{"label":"name","description":"desc","commits":[{"summary":"message","paths":["dir/"]}]}]}

Rules:
- paths may only contain directory prefixes (ending with /, taken from the summary below) or a single ".", never individual files
- First strategy must be "Commit all": exactly one commit with paths ["."]
- Then one strategy per major module: label is the module name, paths are that module's directory prefixes
- At most 8 strategies
- ${languageRule(language)}
- Output ONLY JSON, nothing else

Changed directories:
${summary}`

  return instruction.length > MAX_PROMPT_CHARS ? instruction.slice(0, MAX_PROMPT_CHARS) : instruction
}

export const buildAnalysisPrompt = (gitStatus: GitStatus, language: AppLanguage) => {
  if (gitStatus.changes.length > LARGE_CHANGE_THRESHOLD) {
    return buildLargeAnalysisPrompt(gitStatus, language)
  }

  const changesDescription = gitStatus.changes
    .map((change) => {
      const stats = [
        typeof change.addedLines === 'number' ? `+${change.addedLines}` : '',
        typeof change.removedLines === 'number' ? `-${change.removedLines}` : '',
      ].filter(Boolean).join(' ')

      return `- ${change.kind}: ${change.path} ${stats}`
    })
    .join('\n')

  const patchParts: string[] = []
  const skipPatches = gitStatus.changes.length > 40
  let patchBudget = MAX_PROMPT_CHARS - changesDescription.length - 800

  if (!skipPatches) {
    for (const change of gitStatus.changes) {
      if (!change.patch || patchBudget <= 0) break
      const trimmed = change.patch.length > MAX_PATCH_PER_FILE
        ? change.patch.slice(0, MAX_PATCH_PER_FILE) + '\n... (truncated)'
        : change.patch
      const block = `=== ${change.path} ===\n${trimmed}`
      if (block.length > patchBudget) break
      patchParts.push(block)
      patchBudget -= block.length
    }
  }

  const patchContext = patchParts.join('\n\n')
  const allPaths = gitStatus.changes.map((c) => c.path)
  const patchSection = skipPatches
    ? ''
    : language === 'zh-CN'
      ? `\n\n部分 Patch:\n${patchContext}`
      : `\n\nPartial patches:\n${patchContext}`

  const instruction = language === 'zh-CN'
    ? `你是一个 Git 提交助手。分析以下改动，将文件按模块/功能分组，直接返回一个纯 JSON 对象，不要解释文字，也不要 markdown 代码块。

JSON 格式:
{"strategies":[{"label":"策略名","description":"说明","commits":[{"summary":"提交信息","paths":["文件路径"]}]}]}

规则:
- 先识别改动涉及哪些独立模块（按功能/目录/关联性分组）
- 第一个策略必须是"全部提交"，一次提交所有文件
- 之后每个模块单独作为一个策略，label 用模块名，commits 只包含该模块的文件
- 如果只有1个模块，则只需要"全部提交"这一个策略
- ${languageRule(language)}
- 只输出 JSON，不要任何其他内容

所有文件路径: ${JSON.stringify(allPaths)}

改动列表:
${changesDescription}${patchSection}`
    : `You are a Git commit assistant. Analyze the changes below, group files by module/feature, and return a pure JSON object (no explanations, no markdown code blocks).

JSON format:
{"strategies":[{"label":"name","description":"desc","commits":[{"summary":"message","paths":["file"]}]}]}

Rules:
- First identify which independent modules the changes belong to (group by feature/directory/relatedness)
- First strategy must be "Commit all" — a single commit with all file paths
- Then one strategy per module: label is the module name, commits contain only that module's files
- If there is only 1 module, only include the "Commit all" strategy
- ${languageRule(language)}
- Output ONLY JSON, nothing else

All file paths: ${JSON.stringify(allPaths)}

Changes:
${changesDescription}${patchSection}`

  return instruction.length > MAX_PROMPT_CHARS ? instruction.slice(0, MAX_PROMPT_CHARS) : instruction
}

const isCommitEntry = (item: unknown): item is { summary: string; paths: string[] } => {
  if (typeof item !== 'object' || item === null) return false
  const entry = item as Record<string, unknown>
  return (
    typeof entry.summary === 'string' &&
    Array.isArray(entry.paths) &&
    entry.paths.every((path) => typeof path === 'string')
  )
}

// 症状：AI 只要有一条 commit 结构不合法（截断成 {"summary":"feat: b"} 缺 paths、或 paths 写成字符串），
//   整条策略就被丢掉；它若是唯一一条，面板退化成一坨 500 字原始 JSON、零个可执行分组。
// 根因：2026-08-02 复核发现旧版是 commits.every(isCommitEntry) 的策略级全有全无判定，而这道闸门换不到任何保护 ——
//   isCommitEntry 根本不看 "." 这类通配 token，真正拦住越权提交的是执行期与真实改动求交的 scopeStrategyCommitPaths。
// 被否决的替代方案：
//   1) 保留 every：代价是整条策略连坐，收益为零，已实测截断样本会走到这条路。
//   2) 保留过滤后 commits 为空的策略、让下游 executedCommits === 0 报错兜底：GitAgentStrategyList 对空 commits
//      的渲染跟正常策略一模一样，用户点到的是一张必然失败的死卡片，而且那句报错说的是"路径都不在当前改动中"，
//      对截断场景是错误归因。宁可整条丢掉退回原文，让用户看出这次是模型输出残缺。
const sanitizeCommitStrategy = (item: unknown): CommitStrategy | null => {
  if (typeof item !== 'object' || item === null) return null
  const entry = item as Record<string, unknown>
  if (typeof entry.label !== 'string' || typeof entry.description !== 'string') return null
  if (!Array.isArray(entry.commits)) return null

  const commits = entry.commits.filter(isCommitEntry)
  if (commits.length === 0) return null

  return { label: entry.label, description: entry.description, commits }
}

const collectCommitStrategies = (items: readonly unknown[]): CommitStrategy[] =>
  items
    .map(sanitizeCommitStrategy)
    .filter((strategy): strategy is CommitStrategy => strategy !== null)

const normalizeComparablePath = (value: string): string =>
  value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** 模型偷懒时会用通配代替逐个列举；这些 token 展开成"本次分析范围内的全部改动"，而不是交给 git 扫整棵树。 */
const wholeTreePathTokens = new Set(['', '.', '*', '**'])

/**
 * 把某个策略提交声明的路径收敛到真实改动集合内。
 * 返回值使用 allowedPaths 里的规范写法，顺序按模型给的顺序去重。
 */
export const scopeStrategyCommitPaths = (
  requestedPaths: readonly unknown[],
  allowedPaths: readonly string[],
): string[] => {
  const allowedByKey = new Map<string, string>()
  for (const allowed of allowedPaths) {
    const key = normalizeComparablePath(allowed)
    if (key && !allowedByKey.has(key)) allowedByKey.set(key, allowed)
  }

  const picked: string[] = []
  const seen = new Set<string>()
  const pick = (canonical: string) => {
    if (seen.has(canonical)) return
    seen.add(canonical)
    picked.push(canonical)
  }

  for (const requested of requestedPaths) {
    if (typeof requested !== 'string') continue
    const key = normalizeComparablePath(requested)
    if (wholeTreePathTokens.has(key)) {
      for (const canonical of allowedByKey.values()) pick(canonical)
      continue
    }
    const canonical = allowedByKey.get(key)
    if (canonical) {
      pick(canonical)
      continue
    }
    // 目录前缀：展开成该目录下的真实改动文件（只认整段目录，src/a 不吞 src/ab）。
    const prefix = `${key}/`
    for (const [allowedKey, allowedCanonical] of allowedByKey) {
      if (allowedKey.startsWith(prefix)) pick(allowedCanonical)
    }
  }

  return picked
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets/braces/strings.
 * This handles the case where the AI stream was killed mid-response.
 */
const repairTruncatedJson = (raw: string): unknown | null => {
  let s = raw.trim()
  // Remove trailing comma
  s = s.replace(/,\s*$/, '')
  // Close unclosed string
  const quotes = (s.match(/"/g) || []).length
  if (quotes % 2 !== 0) s += '"'
  // Close unclosed brackets/braces
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  // Remove trailing comma before closing
  s = s.replace(/,\s*$/, '')
  s += stack.reverse().join('')
  try { return JSON.parse(s) } catch { return null }
}

const extractStrategies = (parsed: Record<string, unknown>): CommitStrategy[] => {
  if (!Array.isArray(parsed.strategies)) return []
  return collectCommitStrategies(parsed.strategies as unknown[])
}

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const toAnalysisResult = (parsed: unknown): AnalysisResult | null => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary : ''
  const strategies = extractStrategies(record)
  return summary || strategies.length > 0 ? { summary, strategies } : null
}

// 文本里每个配平的顶层 `{...}`；只在对象内部认字符串，旁白里的引号不影响配平。
// 旁白里未闭合的 `{`（如引用代码 `if (x) {`）不能吞掉后面的 JSON，所以它找不到闭合时从下一位重扫。
const findJsonObjectEnd = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const findBalancedJsonObjects = (text: string): string[] => {
  const objects: string[] = []
  let from = 0
  while (from < text.length) {
    const start = text.indexOf('{', from)
    if (start === -1) break
    const end = findJsonObjectEnd(text, start)
    if (end === -1) {
      from = start + 1
      continue
    }
    objects.push(text.slice(start, end + 1))
    from = end + 1
  }
  return objects
}

export const parseAnalysisResult = (content: string): AnalysisResult | null => {
  try {
    const cleaned = content
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim()

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const result = toAnalysisResult(tryParseJson(jsonMatch[0]))
      if (result) return result
    }

    // Claude / Gemini 累计的是整轮全部文本增量（没有 Codex 那种整条 assistant_message 覆盖），
    // JSON 前的旁白一带 `{`，上面「首个 { 到末个 }」就整段解析失败（2026-10-17 Git 卡可走 Claude 后）。
    // 从后往前逐个试配平的对象：回答正文的 JSON 通常在最后。
    for (const candidate of findBalancedJsonObjects(cleaned).reverse()) {
      const result = toAnalysisResult(tryParseJson(candidate))
      if (result) return result
    }

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      const arr = tryParseJson(arrayMatch[0])
      const strategies = Array.isArray(arr) ? collectCommitStrategies(arr) : []
      if (strategies.length > 0) return { summary: '', strategies }
    }

    // Try repairing truncated JSON (stream killed mid-response)
    const truncMatch = cleaned.match(/\{[\s\S]*/)
    if (truncMatch) {
      const repaired = repairTruncatedJson(truncMatch[0]) as Record<string, unknown> | null
      if (repaired) {
        const strategies = extractStrategies(repaired)
        if (strategies.length > 0) return { summary: '', strategies }
      }
    }

    if (cleaned.length > 10) {
      return { summary: cleaned.slice(0, 500), strategies: [] }
    }

    return null
  } catch {
    return null
  }
}
