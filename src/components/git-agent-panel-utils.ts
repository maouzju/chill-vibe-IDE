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

const isCommitStrategy = (item: unknown): item is CommitStrategy =>
  typeof item === 'object' &&
  item !== null &&
  typeof (item as Record<string, unknown>).label === 'string' &&
  typeof (item as Record<string, unknown>).description === 'string' &&
  Array.isArray((item as Record<string, unknown>).commits)

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
  return (parsed.strategies as unknown[]).filter(isCommitStrategy)
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
      const strategies = arr.filter(isCommitStrategy)
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
