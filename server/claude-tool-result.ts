// Claude 的 tool_result 块。
//
// 症状 — 命令卡永远显示"成功"、退出码徽标永不出现（`exitCode` 恒 null），并行 Bash
//   的输出还会互相顶掉。
// 根因 — tool_result 是 **user 事件里 content 数组的元素**，而解析器只在
//   `typeof message.content === 'string'` 时才往下走，于是整块（含 `is_error` 与
//   `tool_use_id`）从上线起一次都没被读过；命令配对退而求其次用了单槽 `lastCommand`。
// 2026-08-16 实测形状（claude 2.1.206）：
//   失败 { type:'tool_result', content:'Exit code 3', is_error:true, tool_use_id:'toolu_…' }
//   成功 { tool_use_id:'toolu_…', type:'tool_result', content:'hi', is_error:false }

export type ClaudeToolResult = {
  toolUseId: string
  isError: boolean
  text: string
  // 只对命令类工具有意义。CLI 不给结构化退出码，唯一来源是正文里的
  // "Exit code N"；读不出来就是 null——给非命令工具的失败编一个 1 会让
  // UI 显示一个假的退出码徽标。
  exitCode: number | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exitCodePattern = /(?:^|\n)\s*Exit code (\d+)\s*$/

const readToolResultText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  // content 也可能是内容块数组（长输出时 CLI 会拆块）。
  if (Array.isArray(value)) {
    return value
      .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('')
  }

  return ''
}

const resolveExitCode = (isError: boolean, text: string): number | null => {
  const matched = exitCodePattern.exec(text)
  if (matched) {
    const parsed = Number(matched[1])
    return Number.isFinite(parsed) ? parsed : null
  }

  return isError ? null : 0
}

/**
 * 从一条 `type: 'user'` 事件的 message 里取出全部 tool_result。
 *
 * 返回数组而不是单条：并行 Bash 是常态，调用方必须靠 `toolUseId` 配对，
 * 否则就会退回旧的单槽错配行为。
 */
export const parseClaudeToolResults = (message: unknown): ClaudeToolResult[] => {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return []
  }

  const results: ClaudeToolResult[] = []
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_result') {
      continue
    }

    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
    if (!toolUseId) {
      continue
    }

    const isError = block.is_error === true
    const text = readToolResultText(block.content)
    results.push({ toolUseId, isError, text, exitCode: resolveExitCode(isError, text) })
  }

  return results
}
