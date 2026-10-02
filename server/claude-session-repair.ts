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

// 症状：v0.20.32 起「停止后继续」反而更常红 `400 messages.N: system content must contain at least
//   one block`，续传自愈一轮轮重试仍是同一条（2026-09-29 另一台电脑现场，本机 30+ 个存档同型）。
// 根因（2026-09-29 抓包 + 反查 CLI 2.1.280 源码坐实）：CLI 的 per-turn-control beta 按每条回复
//   存下的 effort/perTurnEffort 推算「这一轮的档位」，档位与上一轮不同就在用户消息后塞一条
//   output_config 声明；紧跟的是 system 就合并进去，紧跟的是 assistant 就单独插一条 content=[]
//   的 system——中转站直接 400。--resume 时存档尾巴若是用户消息（停止留下的
//   「[Request interrupted by user]」、没回完的工具结果），CLI 会在它后面补一条不带 effort 的
//   合成回复，于是只要本次档位和历史不同（max→xhigh、开关 ultracode）就必中。上面摘合成回复
//   反而把尾巴还原成用户消息，自愈重起进程后原样复现——这就是"新版更严重"。
// 修法：只在尾巴悬空时摘掉历史回复上的档位戳，整段历史按本次档位算，不再有中途切换。
//   抓包验证 xhigh/max/low 三档恢复；尾巴是正常回复时不动（保住档位切换时的前缀缓存）。
// 为什么不设 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS：它连 prompt-caching-scope、
//   context-management 一起关，代价远大于摘几个元数据字段。
const TURN_EFFORT_KEYS = ['effort', 'perTurnEffort'] as const

const parseEntry = (raw: string) => {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

const hasToolUse = (entry: Record<string, unknown>) => {
  const content = (entry.message as Record<string, unknown> | undefined)?.content
  return Array.isArray(content) && content.some((block) =>
    block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use')
}

// 主链最后一条对话条目是用户消息、或是等不到结果的 tool_use 时，CLI resume 会替它补回复。
const transcriptTailDangles = (lines: string[]) => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = lines[index]
    if (!raw.trim()) {
      continue
    }
    const entry = parseEntry(raw)
    if (!entry || entry.isSidechain === true || (entry.type !== 'user' && entry.type !== 'assistant')) {
      continue
    }
    return entry.type === 'user' || hasToolUse(entry)
  }
  return false
}

export const stripTurnEffortsWhenTailDangles = (content: string) => {
  if (!content.includes('"perTurnEffort"') && !content.includes('"effort"')) {
    return { content, stripped: 0 }
  }
  const lines = content.split('\n')
  if (!transcriptTailDangles(lines)) {
    return { content, stripped: 0 }
  }

  let stripped = 0
  const output = lines.map((raw) => {
    if (!raw.includes('"effort"') && !raw.includes('"perTurnEffort"')) {
      return raw
    }
    const entry = parseEntry(raw)
    if (!entry || entry.type !== 'assistant' || !TURN_EFFORT_KEYS.some((key) => key in entry)) {
      return raw
    }
    const rest = { ...entry }
    for (const key of TURN_EFFORT_KEYS) {
      delete rest[key]
    }
    stripped += 1
    return JSON.stringify(rest)
  })

  return stripped === 0 ? { content, stripped: 0 } : { content: output.join('\n'), stripped }
}

// 症状：会话中途起每一轮都 `400 ... thinking: each thinking block must contain thinking`，
//   一条报错拖 4 个 request id，重试/续传永远一样（另一台电脑 2026-10-02 仍在复现）。
// 根因（2026-07/08 实证）：中转站把 thinking 正文剥成空串只留 signature，CLI 原样写进存档，
//   此后每轮回传必 400。签名对应原文、正文已丢无法补回，只能摘块；摘光的消息补非空占位，
//   不能补空串、也不能删整行（会断 parentUuid 链）。只能在 spawn 前调用。
const EMPTY_THINKING_PLACEHOLDER = '(thinking content unavailable)'

const isEmptyThinkingBlock = (block: unknown) => {
  const record = block as Record<string, unknown> | null
  return !!record && record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim() === ''
}

export const stripEmptyThinkingBlocks = (content: string) => {
  if (!content.includes('"thinking"')) {
    return { content, removed: 0 }
  }
  let removed = 0
  const output = content.split('\n').map((raw) => {
    if (!raw.includes('"type":"thinking"')) {
      return raw
    }
    const entry = parseEntry(raw)
    const message = entry?.message as Record<string, unknown> | undefined
    const blocks = message?.content
    if (!entry || !message || !Array.isArray(blocks) || !blocks.some(isEmptyThinkingBlock)) {
      return raw
    }
    const kept = blocks.filter((block) => !isEmptyThinkingBlock(block))
    removed += blocks.length - kept.length
    if (kept.length === 0) {
      kept.push({ type: 'text', text: EMPTY_THINKING_PLACEHOLDER })
    }
    return JSON.stringify({ ...entry, message: { ...message, content: kept } })
  })
  return removed === 0 ? { content, removed: 0 } : { content: output.join('\n'), removed }
}

// 返回修掉的条数（合成回复 + 档位戳 + 空 thinking 块）；任何读写失败都 fail-open 返回 0，照常 --resume。
export const repairClaudeSessionForResume = async (
  sessionId: string,
  findSessionFile: (sessionId: string) => string | null = findClaudeSessionFile,
): Promise<number> => {
  try {
    const filePath = findSessionFile(sessionId)
    if (!filePath) {
      return 0
    }
    const original = await fs.promises.readFile(filePath, 'utf8')
    const synthetic = original.includes(SYNTHETIC_MARKER)
      ? stripSyntheticNoResponseEntries(original)
      : { content: original, removed: 0 }
    const efforts = stripTurnEffortsWhenTailDangles(synthetic.content)
    const thinking = stripEmptyThinkingBlocks(efforts.content)
    if (synthetic.removed === 0 && efforts.stripped === 0 && thinking.removed === 0) {
      return 0
    }
    const tempPath = `${filePath}.chill-vibe-repair.tmp`
    await fs.promises.writeFile(tempPath, thinking.content, 'utf8')
    await fs.promises.rename(tempPath, filePath)
    console.warn(
      `[claude-session-repair] removed ${synthetic.removed} synthetic "No response requested." entries, stripped turn effort from ${efforts.stripped} replies and ${thinking.removed} empty thinking blocks in ${sessionId}`,
    )
    return synthetic.removed + efforts.stripped + thinking.removed
  } catch {
    return 0
  }
}
