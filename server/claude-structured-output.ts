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

const claudeAskUserTagPattern = /<ask-user-question>\s*([\s\S]+?)\s*<\/ask-user-question>/g

export const stripClaudeAskUserXmlBlocks = (text: string) =>
  text.replace(claudeAskUserTagPattern, '')

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
  let lastWrittenFile: string | null = null

  return (event: unknown): ClaudeStructuredStreamEvent => {
    if (!isRecord(event)) {
      return []
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

      if (!output || !lastCommand) {
        return []
      }

      const completedCommand = {
        type: 'activity' as const,
        itemId: lastCommand.itemId,
        kind: 'command' as const,
        status: 'completed' as const,
        command: lastCommand.command,
        output,
        exitCode: null,
      }

      lastCommand = null
      return [completedCommand]
    }

    return []
  }
}
