import fs from 'fs'

import { findClaudeSessionFile } from './session-fork.js'

// 症状：会话"被诅咒"——停止过一次之后，再怎么继续都是
//   `API Error: 400 messages.N: system content must contain at least one block`，重试永远一样。
// 根因（2026-09-28 实测坐实）：用户停止后 CLI 往原生 jsonl 写一条 model="<synthetic>"、
//   正文「No response requested.」的假回复；之后任何新进程 --resume 这份存档，CLI 2.1.280
//   和 2.1.283 都会在它前面拼出一条 content=[] 的 system 消息，API 确定性 400。
//   全机扫描 34 个此类坏会话里 20 个带这条假回复；摘掉它后 3D-CONCEPT、rogue-td 两个
//   稳定复现的会话当场恢复。其余 14 个是停止后秒发时两个 CLI 并发写同一存档的瞬时竞态，
//   重放即可恢复，由 claude-session-pool 的"等旧进程退出再 --resume"处理。
// 为什么修存档而不是在代理层剔除空 system：cliRoutingEnabled 关着时流量直连中转，
//   不经本地代理；而且这条假回复本身没有任何信息量，摘掉不丢上下文。
// 只能在 spawn 之前调用：那时没有别的 CLI 进程在写这份文件。

const SYNTHETIC_MARKER = 'No response requested.'

const isSyntheticNoResponse = (entry: Record<string, unknown>) => {
  if (entry.type !== 'assistant') {
    return false
  }
  const message = entry.message as Record<string, unknown> | undefined
  if (!message || message.model !== '<synthetic>' || !Array.isArray(message.content)) {
    return false
  }
  return message.content.length > 0 && message.content.every((block) =>
    block && typeof block === 'object' &&
    (block as Record<string, unknown>).type === 'text' &&
    ((block as Record<string, unknown>).text as string | undefined)?.trim() === SYNTHETIC_MARKER)
}

export const stripSyntheticNoResponseEntries = (content: string) => {
  const lines = content.split('\n')
  const parsed = lines.map((raw) => {
    if (!raw.includes(SYNTHETIC_MARKER) && !raw.includes('"parentUuid"')) {
      return null
    }
    try {
      const value = JSON.parse(raw) as unknown
      return value && typeof value === 'object' ? value as Record<string, unknown> : null
    } catch {
      return null
    }
  })

  const replacedParent = new Map<string, unknown>()
  for (const entry of parsed) {
    if (entry && isSyntheticNoResponse(entry) && typeof entry.uuid === 'string') {
      replacedParent.set(entry.uuid, entry.parentUuid ?? null)
    }
  }
  if (replacedParent.size === 0) {
    return { content, removed: 0 }
  }

  const resolveParent = (parent: unknown) => {
    let current = parent
    const seen = new Set<string>()
    while (typeof current === 'string' && replacedParent.has(current) && !seen.has(current)) {
      seen.add(current)
      current = replacedParent.get(current)
    }
    return current
  }

  const output: string[] = []
  lines.forEach((raw, index) => {
    const entry = parsed[index]
    if (!entry) {
      output.push(raw)
      return
    }
    if (typeof entry.uuid === 'string' && replacedParent.has(entry.uuid)) {
      return
    }
    if (typeof entry.parentUuid === 'string' && replacedParent.has(entry.parentUuid)) {
      output.push(JSON.stringify({ ...entry, parentUuid: resolveParent(entry.parentUuid) }))
      return
    }
    output.push(raw)
  })

  return { content: output.join('\n'), removed: replacedParent.size }
}

// 返回摘掉的条数；任何读写失败都 fail-open 返回 0，照常 --resume。
export const repairClaudeSessionForResume = async (
  sessionId: string,
  findSessionFile: (sessionId: string) => string | null = findClaudeSessionFile,
): Promise<number> => {
  try {
    const filePath = findSessionFile(sessionId)
    if (!filePath) {
      return 0
    }
    const content = await fs.promises.readFile(filePath, 'utf8')
    if (!content.includes(SYNTHETIC_MARKER)) {
      return 0
    }
    const result = stripSyntheticNoResponseEntries(content)
    if (result.removed === 0) {
      return 0
    }
    const tempPath = `${filePath}.chill-vibe-repair.tmp`
    await fs.promises.writeFile(tempPath, result.content, 'utf8')
    await fs.promises.rename(tempPath, filePath)
    console.warn(`[claude-session-repair] removed ${result.removed} synthetic "No response requested." entries from ${sessionId}`)
    return result.removed
  } catch {
    return 0
  }
}
