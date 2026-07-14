import fs from 'fs'

import { findClaudeSessionFile } from './session-fork.js'

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
): Promise<NativeTurnCompletion> => {
  try {
    const sourcePath = findSessionFile(sessionId)
    if (!sourcePath) {
      return 'unknown'
    }
    return classifyClaudeSessionTailCompletion(await fs.promises.readFile(sourcePath, 'utf8'))
  } catch {
    return 'unknown'
  }
}
