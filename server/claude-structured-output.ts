import { basename } from 'node:path'

import type {
  AppLanguage,
  StreamActivity,
  StreamTodoItem,
  StreamTodoPriority,
  StreamTodoStatus,
} from '../shared/schema.js'
import { buildSyntheticPatch, finalizeStructuredEditedFile } from './structured-edits.js'

type ClaudeStructuredStreamEvent = ({ type: 'activity' } & StreamActivity)[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key] : undefined

const readFirstString = (record: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = readString(record, key)

    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

const truncate = (value: string, max = 80) =>
  value.length > max ? `${value.slice(0, max)}...` : value

const extractClaudeLocalCommandOutput = (content: string) => {
  const matches = [...content.matchAll(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g)]
  const output = matches
    .map((match) => match[2].trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()

  return output || null
}

const summarizeClaudeToolUse = (
  language: AppLanguage,
  toolName: string,
  input: Record<string, unknown>,
) => {
  switch (toolName) {
    case 'Read': {
      const filePath = readString(input, 'file_path')
      return language === 'en'
        ? filePath
          ? `Read ${basename(filePath)}`
          : 'Read file'
        : filePath
          ? `读取 ${basename(filePath)}`
          : '读取文件'
    }
    case 'Glob': {
      const pattern = readString(input, 'pattern')
      return language === 'en'
        ? pattern
          ? `Search files: ${truncate(pattern)}`
          : 'Search files'
        : pattern
          ? `搜索文件: ${truncate(pattern)}`
          : '搜索文件'
    }
    case 'Grep': {
      const pattern = readString(input, 'pattern')
      return language === 'en'
        ? pattern
          ? `Search text: ${truncate(pattern)}`
          : 'Search text'
        : pattern
          ? `搜索文本: ${truncate(pattern)}`
          : '搜索文本'
    }
    case 'WebFetch': {
      const url = readString(input, 'url')
      return language === 'en'
        ? url
          ? `Read web page: ${truncate(url)}`
          : 'Read web page'
        : url
          ? `读取网页: ${truncate(url)}`
          : '读取网页'
    }
    case 'WebSearch': {
      const query = readString(input, 'query')
      return language === 'en'
        ? query
          ? `Web search: ${truncate(query)}`
          : 'Web search'
        : query
          ? `网页搜索: ${truncate(query)}`
          : '网页搜索'
    }
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const filePath = readString(input, 'file_path')
      return language === 'en'
        ? filePath
          ? `Edit ${basename(filePath)}`
          : 'Edit file'
        : filePath
          ? `编辑 ${basename(filePath)}`
          : '编辑文件'
    }
    case 'TodoWrite':
      return language === 'en' ? 'Update todo list' : '更新任务列表'
    case 'EnterPlanMode':
      return language === 'en' ? 'Enter plan mode' : '进入计划模式'
    default:
      return language === 'en' ? `Use tool: ${toolName}` : `使用工具: ${toolName}`
  }
}

const extractToolInput = (
  toolName: string,
  input: Record<string, unknown>,
): Record<string, string> | undefined => {
  const result: Record<string, string> = {}

  const addString = (key: string) => {
    const value = readString(input, key)
    if (value) result[key] = value
  }

  const addNumber = (key: string) => {
    const value = input[key]
    if (typeof value === 'number') result[key] = String(value)
  }

  switch (toolName) {
    case 'Read':
      addString('file_path')
      addNumber('offset')
      addNumber('limit')
      break
    case 'Glob':
      addString('pattern')
      addString('path')
      break
    case 'Grep':
      addString('pattern')
      addString('glob')
      addString('path')
      break
    case 'Bash':
      addString('command')
      addString('description')
      break
    case 'WebFetch':
      addString('url')
      break
    case 'WebSearch':
      addString('query')
      break
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
    case 'MultiEdit':
      addString('file_path')
      break
    default:
      break
  }

  return Object.keys(result).length > 0 ? result : undefined
}

const isClaudeCommandTool = (toolName: string) =>
  toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell'

const isClaudeEditTool = (toolName: string) =>
  toolName === 'Write' ||
  toolName === 'Edit' ||
  toolName === 'NotebookEdit' ||
  toolName === 'MultiEdit'

const normalizeTodoStatus = (value: string | undefined): StreamTodoStatus | null => {
  switch (value?.trim().toLowerCase()) {
    case 'pending':
    case 'todo':
    case 'open':
      return 'pending'
    case 'in_progress':
    case 'in-progress':
    case 'active':
    case 'doing':
    case 'running':
      return 'in_progress'
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed'
    default:
      return null
  }
}

const normalizeTodoPriority = (value: string | undefined): StreamTodoPriority | undefined => {
  switch (value?.trim().toLowerCase()) {
    case 'low':
      return 'low'
    case 'medium':
    case 'med':
    case 'normal':
      return 'medium'
    case 'high':
    case 'urgent':
      return 'high'
    default:
      return undefined
  }
}

const parseClaudeTodoItems = (input: Record<string, unknown>): StreamTodoItem[] | null => {
  const rawItems = Array.isArray(input.todos)
    ? input.todos
    : Array.isArray(input.items)
      ? input.items
      : Array.isArray(input.task_list)
        ? input.task_list
        : Array.isArray(input.taskList)
          ? input.taskList
          : null

  if (!rawItems) {
    return null
  }

  const items: StreamTodoItem[] = []

  for (const [index, entry] of rawItems.entries()) {
    if (!isRecord(entry)) {
      continue
    }

    const content =
      readFirstString(entry, ['content', 'title', 'task', 'text']) ??
      readFirstString(entry, ['activeForm', 'active_form', 'description'])
    const status = normalizeTodoStatus(readFirstString(entry, ['status', 'state']))

    if (!content || !status) {
      continue
    }

    items.push({
      id:
        readFirstString(entry, ['id', 'todo_id', 'todoId', 'task_id', 'taskId']) ??
        `todo-${index + 1}`,
      content,
      status,
      ...(readFirstString(entry, ['activeForm', 'active_form'])
        ? { activeForm: readFirstString(entry, ['activeForm', 'active_form'])! }
        : {}),
      ...(normalizeTodoPriority(readFirstString(entry, ['priority']))
        ? { priority: normalizeTodoPriority(readFirstString(entry, ['priority']))! }
        : {}),
    })
  }

  return items
}

const buildClaudeEditedFiles = (
  toolName: string,
  input: Record<string, unknown>,
): Extract<StreamActivity, { kind: 'edits' }>['files'] => {
  const path = readFirstString(input, ['file_path', 'path', 'notebook_path'])

  if (!path) {
    return []
  }

  if (toolName === 'Write') {
    const content = readFirstString(input, ['content', 'new_string', 'new_str'])

    if (content === undefined) {
      return []
    }

    const file = finalizeStructuredEditedFile({
      path,
      kind: 'added',
      patch: buildSyntheticPatch(null, content),
    })

    return file ? [file] : []
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    const patch = edits
      .map((entry) => {
        if (!isRecord(entry)) {
          return ''
        }

        return buildSyntheticPatch(
          readFirstString(entry, ['old_string', 'old_str']) ?? null,
          readFirstString(entry, ['new_string', 'new_str']) ?? null,
        )
      })
      .filter(Boolean)
      .join('\n')

    if (!patch) {
      return []
    }

    const file = finalizeStructuredEditedFile({
      path,
      kind: 'modified',
      patch,
    })

    return file ? [file] : []
  }

  const oldContent = readFirstString(input, ['old_string', 'old_str']) ?? null
  const newContent =
    readFirstString(input, ['new_string', 'new_str', 'content', 'new_content']) ?? null
  const patch = buildSyntheticPatch(oldContent, newContent)

  if (!patch) {
    return []
  }

  const file = finalizeStructuredEditedFile({
    path,
    kind: oldContent === null ? 'added' : newContent === null ? 'deleted' : 'modified',
    patch,
  })

  return file ? [file] : []
}

// Tag pairs that must never reach the chat UI as raw text. `ask-user-question`
// is our own convention for rendering choice cards. `function_calls` is the
// container Claude wraps a real tool invocation in, and `invoke` is the tool
// call itself — the model sometimes emits the bare `<invoke …>…</invoke>`
// *without* the outer `<function_calls>` wrapper, so that form must be stripped
// on its own too. When a tool call is typed as prose instead of a structured
// tool_use block, this raw XML (with nested invoke/parameter tags) would
// otherwise leak verbatim and then fail to parse in the chat bubble.
//
// `bodyStartsWith` lists the byte sequences that legitimately follow the open
// tag in a *real* block: an ask-user card is always `<ask-user-question>{...`,
// a wrapped tool call is always `<function_calls><invoke ...`, and a bare
// invoke is always `<invoke …>` (an attribute space) or `<invoke>` (immediate
// close). When the open tag is instead followed by anything else — a backtick,
// punctuation, prose — the model is merely *talking about* the tag, so it must
// pass through untouched rather than swallow the surrounding explanation.
const STRIPPED_TAG_PAIRS = [
  {
    open: '<ask-user-question>',
    close: '</ask-user-question>',
    bodyStartsWith: ['{'],
    toolCall: false,
    allowLeadingWhitespace: false,
  },
  {
    open: '<function_calls>',
    close: '</function_calls>',
    bodyStartsWith: ['<invoke'],
    toolCall: true,
    // Real Claude output pretty-prints the wrapper, e.g.
    // `<function_calls>\n  <invoke …>`, so the `<invoke` body marker is not
    // flush against the container. Tolerate whitespace between the two or the
    // wrapper leaks (and the inner `<parameter>` text with it).
    allowLeadingWhitespace: true,
  },
  {
    open: '<invoke',
    close: '</invoke>',
    bodyStartsWith: [' ', '>'],
    toolCall: true,
    allowLeadingWhitespace: false,
  },
  {
    // If Claude's malformed text loses the outer wrapper/invoke tag, the nested
    // parameter can still leak by itself. ReactMarkdown hides `<parameter ...>`
    // but renders the inner value (`count`), so strip attribute-bearing
    // parameter blocks as tool-call internals too. A plain `<parameter>` mention
    // is not treated as a real block unless it is backtick-prefixed prose, so
    // ordinary explanations are not swallowed just for naming the tag.
    open: '<parameter',
    close: '</parameter>',
    bodyStartsWith: [' ', '\t', '\n', '\r'],
    toolCall: true,
    allowLeadingWhitespace: false,
  },
] as const

type StrippedTagPair = (typeof STRIPPED_TAG_PAIRS)[number]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whether the text immediately following an open tag marks the start of a real
// block (vs. the tag name merely being mentioned in prose). When the body has
// not arrived yet (`rest` is empty) we optimistically treat it as a real block
// so the streaming path keeps buffering until the next delta disambiguates.
// Partial matches count too: a body of `<inv` is still a viable prefix of
// `<invoke` and must keep buffering rather than be released early.
const bodyLooksLikeRealBlock = (pair: StrippedTagPair, rest: string): boolean => {
  const candidate = pair.allowLeadingWhitespace ? rest.replace(/^\s+/, '') : rest

  if (candidate.length === 0) {
    return true
  }

  return pair.bodyStartsWith.some((prefix) => {
    const probe = candidate.slice(0, prefix.length)
    return probe === prefix.slice(0, probe.length)
  })
}

const isBacktickPrefixedTagMention = (text: string, openTagIndex: number): boolean =>
  openTagIndex > 0 && text[openTagIndex - 1] === '`'

const stripCompletedBlocks = (text: string): string => {
  let result = text
  for (const { open, close, bodyStartsWith, allowLeadingWhitespace } of STRIPPED_TAG_PAIRS) {
    const body = bodyStartsWith.map(escapeRegExp).join('|')
    const leadingWhitespace = allowLeadingWhitespace ? '\\s*' : ''
    result = result.replace(
      new RegExp(
        `${escapeRegExp(open)}${leadingWhitespace}(?:${body})[\\s\\S]*?${escapeRegExp(close)}`,
        'g',
      ),
      '',
    )
  }
  return result
}

export const stripClaudeAskUserXmlBlocks = (text: string) => stripCompletedBlocks(text)

// Returns the index at which a *partial* open tag (for any stripped tag pair)
// begins at the very end of `text`, or -1 when the tail cannot be the start of
// one. This lets the incremental stripper hold back a few trailing characters
// that might still grow into an opening tag instead of leaking e.g. `<ask` or
// `<function` to the UI. When several tags could match, the earliest start
// index wins so the longest possible prefix is retained.
const findTrailingOpenTagPrefix = (text: string): number => {
  let earliest = -1

  for (const { open } of STRIPPED_TAG_PAIRS) {
    const maxLen = Math.min(open.length - 1, text.length)

    for (let len = maxLen; len > 0; len -= 1) {
      if (text.endsWith(open.slice(0, len))) {
        const start = text.length - len
        if (earliest === -1 || start < earliest) {
          earliest = start
        }
        break
      }
    }
  }

  return earliest
}

// Locate the earliest complete open tag among all stripped tag pairs.
const findEarliestOpenTag = (
  text: string,
): { index: number; pair: StrippedTagPair } | null => {
  let best: { index: number; pair: StrippedTagPair } | null = null

  for (const pair of STRIPPED_TAG_PAIRS) {
    const index = text.indexOf(pair.open)
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, pair }
    }
  }

  return best
}

// Streaming-safe variant of `stripClaudeAskUserXmlBlocks`. Claude's
// `--include-partial-messages` mode emits text one delta at a time, so a single
// block is split across many chunks. A naive `.replace()` per chunk would leak
// the raw XML because no individual chunk contains the whole tag. This stateful
// stripper buffers just enough trailing text to recognise any stripped tag
// across chunk boundaries and only releases content that is provably outside a
// stripped block.
export const createClaudeAskUserDeltaStripper = () => {
  let buffer = ''
  // How many real tool-call (`<function_calls>` / `<invoke>`) blocks have been
  // removed — whether they arrived complete or were dropped as a truncated block
  // on flush. The provider uses this to detect a turn whose only output was a
  // tool call typed as text (so nothing executed) and auto-resume it.
  let realToolCallBlockCount = 0

  return {
    // Feed a streamed delta; returns the text that is safe to forward now.
    push(text: string): string {
      buffer += text

      let safe = ''
      // Text up to this offset has been classified as safe-to-release; the
      // scan cursor advances past open tags that turn out to be prose so the
      // loop never revisits them.
      let scanFrom = 0

      for (;;) {
        const openTag = findEarliestOpenTag(buffer.slice(scanFrom))

        if (openTag === null) {
          // No complete open tag ahead. Release everything except a trailing
          // fragment that could still become an open tag once more deltas
          // arrive.
          const rest = buffer.slice(scanFrom)
          const prefixIndex = findTrailingOpenTagPrefix(rest)

          if (prefixIndex === -1) {
            safe += rest
            buffer = ''
          } else {
            safe += rest.slice(0, prefixIndex)
            buffer = rest.slice(prefixIndex)
          }

          break
        }

        const absoluteIndex = scanFrom + openTag.index
        const bodyStart = absoluteIndex + openTag.pair.open.length
        const body = buffer.slice(bodyStart)

        if (isBacktickPrefixedTagMention(buffer, absoluteIndex)) {
          safe += buffer.slice(scanFrom, bodyStart)
          scanFrom = bodyStart
          continue
        }

        if (!bodyLooksLikeRealBlock(openTag.pair, body)) {
          // The tag name is merely mentioned in prose (e.g. inside backticks).
          // Release the preceding text *and the open tag itself* verbatim, then
          // keep scanning what follows so a later genuine block can still be
          // stripped.
          safe += buffer.slice(scanFrom, bodyStart)
          scanFrom = bodyStart
          continue
        }

        // Everything before the open tag is outside the block and safe.
        safe += buffer.slice(scanFrom, absoluteIndex)
        buffer = buffer.slice(absoluteIndex)

        const closeIndex = buffer.indexOf(openTag.pair.close)

        if (closeIndex === -1) {
          // Real block whose close tag has not arrived yet: keep buffering.
          break
        }

        // Drop the whole completed block and keep scanning from the start.
        if (openTag.pair.toolCall) {
          realToolCallBlockCount += 1
        }
        buffer = buffer.slice(closeIndex + openTag.pair.close.length)
        scanFrom = 0
      }

      return safe
    },

    // Flush any residual buffered text at stream end. Completed blocks are
    // stripped, and a genuine but *unterminated* tool-call / ask-user block
    // (its body already looked like a real block, so push() held it back waiting
    // for a close tag that never came) is DROPPED rather than released. Such a
    // half-block is broken machine output, never user prose: releasing it
    // verbatim leaked `<parameter>` values like `count` into the chat, because
    // the renderer's ReactMarkdown drops the `<invoke>`/`<parameter>` tags but
    // keeps their inner text. A trailing *partial* open-tag prefix (a bare `<`
    // that never grew into a tag) is ordinary prose and is kept. Prose that
    // merely *names* a tag was already released during push() via
    // bodyLooksLikeRealBlock, so it never reaches flush held back.
    flush(): string {
      const remaining = buffer
      buffer = ''

      const stripped = stripCompletedBlocks(remaining)
      const openTag = findEarliestOpenTag(stripped)

      if (openTag) {
        const body = stripped.slice(openTag.index + openTag.pair.open.length)
        if (bodyLooksLikeRealBlock(openTag.pair, body)) {
          if (openTag.pair.toolCall) {
            realToolCallBlockCount += 1
          }
          return stripped.slice(0, openTag.index)
        }
      }

      return stripped
    },

    // Number of real tool-call blocks this stripper has removed across its
    // lifetime (completed during push or dropped as a truncated block on flush).
    consumedToolCallBlockCount(): number {
      return realToolCallBlockCount
    },
  }
}

// Claude occasionally emits the ask-user JSON with cosmetic deviations from
// strict JSON: smart/curly quotes around keys and string values, trailing
// commas before a closing bracket or brace, or markdown-style fencing. These
// are trivially normalisable before JSON.parse so the ask-user card still
// renders instead of leaking raw XML to the user.
const normaliseAskUserJsonText = (raw: string): string => {
  let text = raw.trim()

  // Strip a leading/trailing markdown code fence if present, e.g. ```json ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z0-9]*\s*\n?/, '')
    text = text.replace(/\s*```\s*$/, '')
    text = text.trim()
  }

  // Replace curly double and single quotes with ASCII quotes. JSON only
  // tolerates ASCII double quotes; smart quotes come from copy/paste or from
  // models that pretty-print their output.
  text = text
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")

  // Drop trailing commas inside arrays and objects: ",]" / ",}" (with optional
  // whitespace/newlines between the comma and the closer).
  text = text.replace(/,(\s*[\]}])/g, '$1')

  return text
}

const parseClaudeAskUserJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    // fall through to the normalised attempt
  }
  try {
    return JSON.parse(normaliseAskUserJsonText(raw))
  } catch {
    return null
  }
}

const parseClaudeAskUserXmlBlock = (
  messageId: string | undefined,
  text: string | undefined,
): Extract<StreamActivity, { kind: 'ask-user' }> | null => {
  if (!messageId || !text) {
    return null
  }

  const match = text.match(/<ask-user-question>\s*([\s\S]+?)\s*<\/ask-user-question>/)

  if (!match) {
    return null
  }

  try {
    const parsed = parseClaudeAskUserJson(match[1]!) as unknown

    if (parsed === null) {
      return null
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.options)) {
      return null
    }

    const question = readString(parsed, 'question')?.trim()

    if (!question) {
      return null
    }

    const options = parsed.options
      .map((entry) => {
        if (!isRecord(entry)) {
          return null
        }
        const label = readString(entry, 'label')?.trim()
        if (!label) {
          return null
        }
        return {
          label,
          description: readString(entry, 'description')?.trim() ?? '',
        }
      })
      .filter(
        (
          entry,
        ): entry is Extract<StreamActivity, { kind: 'ask-user' }>['options'][number] =>
          entry !== null,
      )

    if (options.length === 0) {
      return null
    }

    return {
      itemId: messageId,
      kind: 'ask-user',
      status: 'completed',
      header: readString(parsed, 'header')?.trim() ?? '',
      question,
      multiSelect: parsed.multiSelect === true,
      options,
    }
  } catch {
    return null
  }
}

export const createClaudeStructuredOutputParser = (language: AppLanguage) => {
  let lastCommand: { itemId: string; command: string } | null = null

  const settleLastCommand = (): Extract<StreamActivity, { kind: 'command' }> | null => {
    if (!lastCommand) {
      return null
    }

    const completedCommand = {
      itemId: lastCommand.itemId,
      kind: 'command' as const,
      status: 'completed' as const,
      command: lastCommand.command,
      output: '',
      exitCode: null,
    }

    lastCommand = null
    return completedCommand
  }
  let lastWrittenFile: string | null = null
  // Extended thinking arrives as partial-message stream events: a `thinking`
  // content block opens at index 0 (before the text answer), streams
  // `thinking_delta` chunks, then closes with `content_block_stop`. We
  // accumulate per block index and emit one completed `reasoning` activity on
  // close — the same shape Codex produces, so it renders through the identical
  // reasoning card. Empty thinking blocks (omitted display) emit nothing.
  let currentMessageId: string | null = null
  const thinkingBlocks = new Map<number, string>()

  const parseClaudeThinkingStreamEvent = (inner: unknown): ClaudeStructuredStreamEvent => {
    if (!isRecord(inner)) {
      return []
    }

    const innerType = readString(inner, 'type')

    if (innerType === 'message_start') {
      const message = isRecord(inner.message) ? inner.message : null
      const id = message ? readString(message, 'id') : undefined
      if (id) {
        currentMessageId = id
      }
      return []
    }

    if (innerType === 'content_block_start') {
      const block = isRecord(inner.content_block) ? inner.content_block : null
      if (block?.type === 'thinking' && typeof inner.index === 'number') {
        thinkingBlocks.set(inner.index, '')
      }
      return []
    }

    if (innerType === 'content_block_delta') {
      const delta = isRecord(inner.delta) ? inner.delta : null
      if (
        delta?.type === 'thinking_delta' &&
        typeof inner.index === 'number' &&
        thinkingBlocks.has(inner.index)
      ) {
        const chunk = typeof delta.thinking === 'string' ? delta.thinking : ''
        thinkingBlocks.set(inner.index, (thinkingBlocks.get(inner.index) ?? '') + chunk)
      }
      return []
    }

    if (innerType === 'content_block_stop') {
      const index = typeof inner.index === 'number' ? inner.index : null
      if (index === null || !thinkingBlocks.has(index)) {
        return []
      }

      const text = (thinkingBlocks.get(index) ?? '').trim()
      thinkingBlocks.delete(index)

      if (!text) {
        return []
      }

      return [
        {
          type: 'activity',
          itemId: `${currentMessageId ?? 'claude'}:thinking:${index}`,
          kind: 'reasoning',
          status: 'completed',
          text,
        },
      ]
    }

    return []
  }

  return (event: unknown): ClaudeStructuredStreamEvent => {
    if (!isRecord(event)) {
      return []
    }

    if (event.type === 'stream_event') {
      return parseClaudeThinkingStreamEvent(event.event)
    }

    if (event.type === 'assistant') {
      const message = isRecord(event.message) ? event.message : null
      const content = Array.isArray(message?.content) ? message.content : []
      const activities: ClaudeStructuredStreamEvent = []
      const messageId = readString(message ?? {}, 'id')

      for (const item of content) {
        if (isRecord(item) && item.type === 'text') {
          const askUser = parseClaudeAskUserXmlBlock(messageId, readString(item, 'text'))
          if (askUser) {
            activities.push({ type: 'activity', ...askUser })
          }
          continue
        }

        if (!isRecord(item) || item.type !== 'tool_use') {
          continue
        }

        const itemId = readString(item, 'id')
        const toolName = readString(item, 'name')
        const input = isRecord(item.input) ? item.input : {}

        if (!itemId || !toolName) {
          continue
        }

        if (isClaudeCommandTool(toolName)) {
          const command = readString(input, 'command') ?? ''
          const previousCommand = settleLastCommand()
          if (previousCommand) {
            activities.push({ type: 'activity', ...previousCommand })
          }
          lastCommand = { itemId, command }
          activities.push({
            type: 'activity',
            itemId,
            kind: 'command',
            status: 'in_progress',
            command,
            output: '',
            exitCode: null,
          })
          continue
        }

        if (isClaudeEditTool(toolName)) {
          const files = buildClaudeEditedFiles(toolName, input)

          if (files.length > 0) {
            lastWrittenFile = files[files.length - 1]!.path
            activities.push({
              type: 'activity',
              itemId,
              kind: 'edits',
              status: 'completed',
              files,
            })
            continue
          }
        }

        if (toolName === 'TodoWrite') {
          const items = parseClaudeTodoItems(input)

          if (items) {
            activities.push({
              type: 'activity',
              itemId,
              kind: 'todo',
              status: 'completed',
              items,
            })
            continue
          }
        }

        if (toolName === 'ExitPlanMode') {
          const planFile = lastWrittenFile ?? undefined
          activities.push({
            type: 'activity',
            itemId,
            kind: 'ask-user',
            status: 'completed',
            question: language === 'en' ? 'Plan is ready for review' : '计划已准备好，请审阅',
            header: language === 'en' ? 'Plan approval' : '计划审批',
            multiSelect: false,
            options: [
              { label: language === 'en' ? 'Approve plan' : '批准计划', description: '' },
              { label: language === 'en' ? 'Reject plan' : '拒绝计划', description: '' },
            ],
            planFile,
          })
          continue
        }

        if (toolName === 'AskUserQuestion') {
          const rawQuestions = Array.isArray(input.questions) ? input.questions : []
          const normalizedQuestions = rawQuestions
            .filter(isRecord)
            .map((raw) => {
              const question = typeof raw.question === 'string' ? raw.question.trim() : ''
              const options = Array.isArray(raw.options) ? raw.options : []
              const normalizedOptions = options
                .filter(isRecord)
                .map((opt) => ({
                  label: typeof opt.label === 'string' ? opt.label.trim() : '',
                  description: typeof opt.description === 'string' ? opt.description : '',
                }))
                .filter((opt) => opt.label)
              if (!question || normalizedOptions.length === 0) {
                return null
              }
              return {
                question,
                header: typeof raw.header === 'string' ? raw.header : '',
                multiSelect: raw.multiSelect === true,
                options: normalizedOptions,
              }
            })
            .filter(
              (
                entry,
              ): entry is {
                question: string
                header: string
                multiSelect: boolean
                options: { label: string; description: string }[]
              } => entry !== null,
            )

          if (normalizedQuestions.length > 0) {
            const first = normalizedQuestions[0]!
            activities.push({
              type: 'activity',
              itemId,
              kind: 'ask-user',
              status: 'completed',
              question: first.question,
              header: first.header,
              multiSelect: first.multiSelect,
              options: first.options,
              ...(normalizedQuestions.length > 1 ? { questions: normalizedQuestions } : {}),
            })
            continue
          }
        }

        activities.push({
          type: 'activity',
          itemId,
          kind: 'tool',
          status: 'completed',
          toolName,
          summary: summarizeClaudeToolUse(language, toolName, input),
          toolInput: extractToolInput(toolName, input),
        })
      }

      return activities
    }

    if (event.type === 'user') {
      const message = isRecord(event.message) ? event.message : null
      const content = typeof message?.content === 'string' ? message.content : ''
      const output = extractClaudeLocalCommandOutput(content)

      if (!lastCommand) {
        return []
      }

      const completedCommand = settleLastCommand()
      return completedCommand
        ? [
            {
              type: 'activity' as const,
              ...completedCommand,
              output: output ?? '',
            },
          ]
        : []
    }

    if (event.type === 'result') {
      const completedCommand = settleLastCommand()
      return completedCommand ? [{ type: 'activity' as const, ...completedCommand }] : []
    }

    return []
  }
}
