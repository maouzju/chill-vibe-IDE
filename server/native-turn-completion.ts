import fs from 'fs'

import { findClaudeSessionFile, findCodexRolloutFile } from './session-fork.js'

// Fact-check for stream recovery: before auto-resuming a "recoverable" Claude
// stream error, ask the CLI's own on-disk session transcript whether the last
// turn actually finished. A flaky relay can eat or corrupt the terminal result
// event after the reply already completed; resuming such a turn silently wakes
// the model with an empty continuation and it invents follow-up work. The
// native jsonl is the authority the relay cannot touch.
//
// Classification is deliberately fail-open: anything we cannot read or map
// confidently returns 'unknown' and the caller keeps the existing resume
// behavior, so a genuinely interrupted turn is never stranded.

export type NativeTurnCompletion = 'completed' | 'incomplete' | 'unknown'

export type NativeTailReadOptions = {
  initialWindowBytes?: number
  maxWindowBytes?: number
}

const DEFAULT_INITIAL_TAIL_WINDOW_BYTES = 64 * 1024
const DEFAULT_MAX_TAIL_WINDOW_BYTES = 8 * 1024 * 1024

// 症状：断线恢复要问一次"上一轮真的答完了吗"，但这里曾整读 <sessionId>.jsonl /
// rollout-*.jsonl 再 split('\n')；长期会话可达数十到数百 MiB，而三个调用方
// (server/index.ts、electron/backend.ts、server/providers.ts 的卡流超时定时器)
// 全在热路径，Electron 主进程因此在最该响应的时刻停顿并冲一次内存峰值。
// 根因：两个 classify* 都是从尾部倒序扫、遇到第一条实质条目就返回，真正需要的
// 只有文件末尾（Claude 典型 1-3 行）；整读的 99.99% 字节从未被看过。
// 为什么不能固定只读最后 N KB：Codex 的 task_started 可能被一整轮 response_item
// 顶到离尾部很远，固定窗口会把"还在跑"误判成读不到，所以窗口必须成倍回退扩大。
//
// 半行安全（本改动最大风险点，回归钉在 tests/native-turn-completion.test.ts 的
// 两个 window-boundary sweep）：窗口起点若不在文件开头就无条件丢掉第一行。
// 两层保证——① JSON 对象的真后缀永远多出闭合花括号，JSON.parse 必失败，半行天然
// 是惰性的；② 即便丢掉的是一条完整行也不会错判：classify 倒序返回第一条实质
// 条目，窗口里任何更靠后的行有结论就早已返回，丢掉最靠前那行只可能把结论降级成
// 'unknown'，而 'unknown' 会触发扩窗重读，绝不会把结论翻成另一个值。
const readNativeSessionTailVerdict = async (
  sourcePath: string,
  classify: (sourceContent: string) => NativeTurnCompletion,
  options: NativeTailReadOptions,
): Promise<NativeTurnCompletion> => {
  const initialWindowBytes = Math.max(
    1,
    Math.floor(options.initialWindowBytes ?? DEFAULT_INITIAL_TAIL_WINDOW_BYTES),
  )
  const maxWindowBytes = Math.max(
    initialWindowBytes,
    Math.floor(options.maxWindowBytes ?? DEFAULT_MAX_TAIL_WINDOW_BYTES),
  )

  const handle = await fs.promises.open(sourcePath, 'r')
  try {
    const { size } = await handle.stat()
    let windowBytes = initialWindowBytes

    for (;;) {
      const requestedBytes = Math.min(windowBytes, size)
      const windowStart = size - requestedBytes
      const buffer = Buffer.allocUnsafe(requestedBytes)
      let filled = 0
      while (filled < requestedBytes) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          requestedBytes - filled,
          windowStart + filled,
        )
        if (bytesRead <= 0) {
          break
        }
        filled += bytesRead
      }

      let sourceContent = buffer.subarray(0, filled).toString('utf8')
      if (windowStart > 0) {
        // A window that does not start at byte 0 can begin mid-line (and even
        // mid-UTF-8-sequence; the replacement chars stay inside that same first
        // line), so the fragment is dropped rather than parsed.
        const firstLineBreak = sourceContent.indexOf('\n')
        sourceContent = firstLineBreak === -1 ? '' : sourceContent.slice(firstLineBreak + 1)
      }

      const verdict = classify(sourceContent)
      if (verdict !== 'unknown' || windowStart === 0 || windowBytes >= maxWindowBytes) {
        return verdict
      }
      windowBytes = Math.min(windowBytes * 2, maxWindowBytes)
    }
  } finally {
    await handle.close()
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const tryParseJson = (line: string): unknown | null => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

type SubstantiveTail =
  | { role: 'assistant'; blocks: Array<Record<string, unknown>>; stopReason: unknown }
  | { role: 'user' }

// Entries that carry conversation state, as opposed to CLI bookkeeping lines
// (ai-title, last-prompt, mode, attachment, system, queue-operation, ...),
// meta fillers, synthetic assistants, and sidechain (subagent) traffic.
const getSubstantiveEntry = (entry: unknown): SubstantiveTail | null => {
  if (!isRecord(entry) || entry.isSidechain === true || entry.isMeta === true) {
    return null
  }
  if (entry.type !== 'user' && entry.type !== 'assistant') {
    return null
  }
  const message = entry.message
  if (!isRecord(message)) {
    return null
  }

  if (entry.type === 'assistant') {
    if (message.model === '<synthetic>') {
      return null
    }
    const blocks = Array.isArray(message.content)
      ? message.content.filter(isRecord)
      : []
    return { role: 'assistant', blocks, stopReason: message.stop_reason }
  }

  if ('attachment' in entry) {
    return null
  }
  // Both a real user prompt (string or text blocks) and a tool_result rider
  // mean the turn is waiting on the model, so they classify the same way.
  return { role: 'user' }
}

export const classifyClaudeSessionTailCompletion = (
  sourceContent: string,
): NativeTurnCompletion => {
  const lines = sourceContent.split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line) {
      continue
    }
    const tail = getSubstantiveEntry(tryParseJson(line))
    if (!tail) {
      continue
    }

    if (tail.role === 'user') {
      return 'incomplete'
    }

    if (tail.blocks.some((block) => block.type === 'tool_use')) {
      return 'incomplete'
    }
    if (!tail.blocks.some((block) => block.type === 'text')) {
      // thinking-only or empty content: the model never finished speaking.
      return 'incomplete'
    }
    // A text tail with stop_reason tool_use means more tool work was coming.
    return tail.stopReason === 'tool_use' ? 'incomplete' : 'completed'
  }

  return 'unknown'
}

export const getClaudeNativeTurnCompletion = async (
  sessionId: string,
  findSessionFile: (sessionId: string) => string | null = findClaudeSessionFile,
  tailReadOptions: NativeTailReadOptions = {},
): Promise<NativeTurnCompletion> => {
  try {
    const sourcePath = findSessionFile(sessionId)
    if (!sourcePath) {
      return 'unknown'
    }
    return await readNativeSessionTailVerdict(
      sourcePath,
      classifyClaudeSessionTailCompletion,
      tailReadOptions,
    )
  } catch {
    return 'unknown'
  }
}

// Codex rollout files record one authoritative task lifecycle per root turn.
// Sub-agent work lives in separate rollout files, so the latest root
// task_started/task_complete marker tells us whether resuming would continue an
// interrupted turn or wrongly wake an already-finished one.
export const classifyCodexSessionTailCompletion = (
  sourceContent: string,
): NativeTurnCompletion => {
  const lines = sourceContent.split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line) {
      continue
    }
    const entry = tryParseJson(line)
    if (!isRecord(entry) || !isRecord(entry.payload)) {
      continue
    }

    if (
      entry.type === 'response_item' &&
      entry.payload.type === 'message' &&
      entry.payload.role === 'user'
    ) {
      return 'incomplete'
    }
    if (entry.type !== 'event_msg') {
      continue
    }

    switch (entry.payload.type) {
      case 'task_complete':
        return 'completed'
      case 'task_started':
      case 'task_interrupted':
        return 'incomplete'
      default:
        continue
    }
  }

  return 'unknown'
}

export const getCodexNativeTurnCompletion = async (
  sessionId: string,
  findSessionFile: (sessionId: string) => string | null = findCodexRolloutFile,
  tailReadOptions: NativeTailReadOptions = {},
): Promise<NativeTurnCompletion> => {
  try {
    const sourcePath = findSessionFile(sessionId)
    if (!sourcePath) {
      return 'unknown'
    }
    return await readNativeSessionTailVerdict(
      sourcePath,
      classifyCodexSessionTailCompletion,
      tailReadOptions,
    )
  } catch {
    return 'unknown'
  }
}
