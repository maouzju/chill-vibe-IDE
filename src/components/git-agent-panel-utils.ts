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

export const buildAnalysisPrompt = (gitStatus: GitStatus, language: AppLanguage) => {
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
    if (canonical) pick(canonical)
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

export const parseAnalysisResult = (content: string): AnalysisResult | null => {
  try {
    const cleaned = content
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim()

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
      const strategies = extractStrategies(parsed)
      if (summary || strategies.length > 0) return { summary, strategies }
    }

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/)
    if (arrayMatch) {
      const arr = JSON.parse(arrayMatch[0]) as unknown[]
      const strategies = collectCommitStrategies(arr)
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
