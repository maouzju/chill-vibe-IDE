import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { AppLanguage, ChatMessage } from '../../shared/schema'
import { openExternalLink, openMessageLocalLink } from '../api'
import type { StructuredToolGroupItem } from './chat-card-parsing'

// Module-level constants prevent ReactMarkdown from re-initializing its plugin
// pipeline on every render (new array identity = new pipeline).
const REMARK_PLUGINS = [remarkGfm]
const markdownComponentsCache = new Map<string, ReturnType<typeof createMarkdownComponents>>()

export const isLocalMessageLinkHref = (href: string | null | undefined) => {
  const value = href?.trim() ?? ''

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return false
  }

  if (/^file:\/\//i.test(value)) {
    return true
  }

  if (/^[a-z]:[\\/]/i.test(value)) {
    return true
  }

  return !/^[a-z][a-z\d+.-]*:/i.test(value)
}

const isExternalMessageLinkHref = (href: string | null | undefined) => {
  const value = href?.trim() ?? ''

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return false
  }

  return !isLocalMessageLinkHref(value) && /^[a-z][a-z\d+.-]*:/i.test(value)
}

type LinkClickEvent = {
  preventDefault: () => void
}

type SafeInlineNode =
  | string
  | {
      kind: 'strong' | 'em' | 'code'
      children: SafeInlineNode[]
    }
  | {
      kind: 'br'
    }

type SafeHtmlTableCell = {
  kind: 'td' | 'th'
  style?: CSSProperties
  children: SafeInlineNode[]
}

type SafeHtmlTable = SafeHtmlTableCell[][]

type MarkdownRenderChunk =
  | {
      kind: 'markdown'
      content: string
    }
  | {
      kind: 'table'
      table: SafeHtmlTable
    }

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00A0',
  quot: '"',
}

const MAX_SAFE_HTML_TABLE_ROWS = 80
const MAX_SAFE_HTML_TABLE_CELLS = 12

const decodeHtmlEntities = (value: string) =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (entity, body: string) => {
    const normalizedBody = body.toLowerCase()

    if (normalizedBody.startsWith('#x')) {
      const codePoint = Number.parseInt(normalizedBody.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }

    if (normalizedBody.startsWith('#')) {
      const codePoint = Number.parseInt(normalizedBody.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }

    return HTML_ENTITY_MAP[normalizedBody] ?? entity
  })

const extractHtmlAttribute = (attributes: string, name: string) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>` + '`' + '=]+))'
  const match = attributes.match(new RegExp(pattern, 'i'))

  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '') : null
}

const readSafeCssColor = (rawValue: string | null) => {
  const value = rawValue?.trim() ?? ''

  if (/^#[\da-f]{3,4}$/i.test(value) || /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) {
    return value
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbMatch) {
    const parts = rgbMatch[1]?.split(',').map((part) => part.trim()) ?? []
    const expectedLength = value.toLowerCase().startsWith('rgba') ? 4 : 3
    const rgbParts = parts.slice(0, 3).map((part) => Number.parseInt(part, 10))
    const alphaPart = parts[3]

    if (
      parts.length === expectedLength &&
      rgbParts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
      (alphaPart === undefined || /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(alphaPart))
    ) {
      return value
    }
  }

  return null
}

const readSafeCssLength = (rawValue: string | null) => {
  const value = rawValue?.trim() ?? ''

  if (
    /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?px$/i.test(value) ||
    /^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?(?:rem|em)$/i.test(value) ||
    /^(?:100|[1-9]?\d)(?:\.\d{1,2})?%$/.test(value)
  ) {
    return value
  }

  if (/^(?:0|[1-9]\d{0,3})$/.test(value)) {
    return `${value}px`
  }

  return null
}

const parseSafeTableCellStyle = (attributes: string): CSSProperties | undefined => {
  const styleAttribute = extractHtmlAttribute(attributes, 'style')
  const nextStyle: CSSProperties = {}

  if (styleAttribute) {
    for (const declaration of styleAttribute.split(';')) {
      const separatorIndex = declaration.indexOf(':')
      if (separatorIndex < 0) {
        continue
      }

      const property = declaration.slice(0, separatorIndex).trim().toLowerCase()
      const value = declaration.slice(separatorIndex + 1).trim()

      if (property === 'background' || property === 'background-color') {
        const color = readSafeCssColor(value)
        if (color) {
          nextStyle.backgroundColor = color
        }
      } else if (property === 'color') {
        const color = readSafeCssColor(value)
        if (color) {
          nextStyle.color = color
        }
      } else if (property === 'width') {
        const width = readSafeCssLength(value)
        if (width) {
          nextStyle.width = width
        }
      } else if (property === 'height') {
        const height = readSafeCssLength(value)
        if (height) {
          nextStyle.height = height
        }
      }
    }
  }

  const backgroundAttribute = readSafeCssColor(extractHtmlAttribute(attributes, 'bgcolor'))
  const widthAttribute = readSafeCssLength(extractHtmlAttribute(attributes, 'width'))
  const heightAttribute = readSafeCssLength(extractHtmlAttribute(attributes, 'height'))

  if (backgroundAttribute) {
    nextStyle.backgroundColor = nextStyle.backgroundColor ?? backgroundAttribute
  }

  if (widthAttribute) {
    nextStyle.width = nextStyle.width ?? widthAttribute
  }

  if (heightAttribute) {
    nextStyle.height = nextStyle.height ?? heightAttribute
  }

  return Object.keys(nextStyle).length > 0 ? nextStyle : undefined
}

const pushSafeInlineText = (target: SafeInlineNode[], text: string) => {
  if (!text) {
    return
  }

  target.push(decodeHtmlEntities(text))
}

const parseSafeInlineHtml = (html: string): SafeInlineNode[] => {
  const cleanedHtml = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  const root: SafeInlineNode[] = []
  const stack: Array<{ kind: 'root' | 'strong' | 'em' | 'code'; children: SafeInlineNode[] }> = [
    { kind: 'root', children: root },
  ]
  const tagPattern = /<\/?(?:b|strong|i|em|code|br)\b[^>]*>|<[^>]+>/gi
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(cleanedHtml)) !== null) {
    pushSafeInlineText(stack.at(-1)!.children, cleanedHtml.slice(cursor, match.index))

    const tag = match[0]
    const tagName = tag.match(/^<\/?\s*([a-z][\da-z-]*)/i)?.[1]?.toLowerCase()
    const isClosingTag = /^<\//.test(tag)
    const isAllowedTag = tagName && ['b', 'strong', 'i', 'em', 'code', 'br'].includes(tagName)

    if (isAllowedTag && tagName === 'br' && !isClosingTag) {
      stack.at(-1)!.children.push({ kind: 'br' })
    } else if (isAllowedTag && !isClosingTag) {
      const kind = tagName === 'b' || tagName === 'strong'
        ? 'strong'
        : tagName === 'i' || tagName === 'em'
          ? 'em'
          : 'code'
      const node: Extract<SafeInlineNode, { children: SafeInlineNode[] }> = { kind, children: [] }
      stack.at(-1)!.children.push(node)
      stack.push(node)
    } else if (isAllowedTag && isClosingTag) {
      const kind = tagName === 'b' || tagName === 'strong'
        ? 'strong'
        : tagName === 'i' || tagName === 'em'
          ? 'em'
          : tagName === 'code'
            ? 'code'
            : null
      const matchingIndex = kind
        ? stack.findLastIndex((entry) => entry.kind === kind)
        : -1

      if (matchingIndex > 0) {
        stack.length = matchingIndex
      }
    }

    cursor = tagPattern.lastIndex
  }

  pushSafeInlineText(stack.at(-1)!.children, cleanedHtml.slice(cursor))

  return root
}

const parseSafeHtmlTable = (html: string): SafeHtmlTable | null => {
  if (!/^<table\b/i.test(html.trim())) {
    return null
  }

  const rows: SafeHtmlTable = []
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowPattern.exec(html)) !== null && rows.length < MAX_SAFE_HTML_TABLE_ROWS) {
    const rowHtml = rowMatch[1] ?? ''
    const cells: SafeHtmlTableCell[] = []
    const cellPattern = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi
    let cellMatch: RegExpExecArray | null

    while ((cellMatch = cellPattern.exec(rowHtml)) !== null && cells.length < MAX_SAFE_HTML_TABLE_CELLS) {
      const kind = cellMatch[1]?.toLowerCase() === 'th' ? 'th' : 'td'
      const attributes = cellMatch[2] ?? ''
      const children = parseSafeInlineHtml(cellMatch[3] ?? '')

      cells.push({
        kind,
        style: parseSafeTableCellStyle(attributes),
        children: children.length > 0 ? children : ['\u00A0'],
      })
    }

    if (cells.length > 0) {
      rows.push(cells)
    }
  }

  return rows.length > 0 ? rows : null
}

const isInsideMarkdownCodeFence = (content: string, index: number) => {
  const fencePattern = /^```/gm
  let insideFence = false
  let match: RegExpExecArray | null

  while ((match = fencePattern.exec(content)) !== null) {
    if (match.index >= index) {
      break
    }

    insideFence = !insideFence
  }

  return insideFence
}

const splitMarkdownAndSafeHtmlTables = (content: string): MarkdownRenderChunk[] => {
  const chunks: MarkdownRenderChunk[] = []
  const tablePattern = /<table\b[\s\S]*?<\/table>/gi
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tablePattern.exec(content)) !== null) {
    const tableHtml = match[0] ?? ''
    const table = !isInsideMarkdownCodeFence(content, match.index)
      ? parseSafeHtmlTable(tableHtml)
      : null

    if (!table) {
      continue
    }

    if (match.index > cursor) {
      chunks.push({ kind: 'markdown', content: content.slice(cursor, match.index) })
    }

    chunks.push({ kind: 'table', table })
    cursor = tablePattern.lastIndex
  }

  if (cursor < content.length) {
    chunks.push({ kind: 'markdown', content: content.slice(cursor) })
  }

  return chunks.length > 0 ? chunks : [{ kind: 'markdown', content }]
}

const renderSafeInlineNodes = (nodes: SafeInlineNode[], keyPrefix: string): ReactNode[] =>
  nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`

    if (typeof node === 'string') {
      return node
    }

    if (node.kind === 'br') {
      return <br key={key} />
    }

    if (node.kind === 'strong') {
      return <strong key={key}>{renderSafeInlineNodes(node.children, key)}</strong>
    }

    if (node.kind === 'em') {
      return <em key={key}>{renderSafeInlineNodes(node.children, key)}</em>
    }

    return <code key={key}>{renderSafeInlineNodes(node.children, key)}</code>
  })

const renderSafeHtmlTable = (table: SafeHtmlTable, keyPrefix: string) => (
  <table key={keyPrefix}>
    <tbody>
      {table.map((row, rowIndex) => (
        <tr key={`${keyPrefix}-row-${rowIndex}`}>
          {row.map((cell, cellIndex) => {
            const key = `${keyPrefix}-cell-${rowIndex}-${cellIndex}`
            const children = renderSafeInlineNodes(cell.children, key)

            return cell.kind === 'th' ? (
              <th key={key} style={cell.style}>{children}</th>
            ) : (
              <td key={key} style={cell.style}>{children}</td>
            )
          })}
        </tr>
      ))}
    </tbody>
  </table>
)

export const handleMessageLinkClick = async (
  event: LinkClickEvent,
  href: string | undefined,
  workspacePath?: string,
) => {
  const linkHref = href?.trim()

  if (!linkHref) {
    return false
  }

  if (isLocalMessageLinkHref(linkHref)) {
    event.preventDefault()
    await openMessageLocalLink(linkHref, workspacePath)
    return true
  }

  if (
    isExternalMessageLinkHref(linkHref)
    && typeof window !== 'undefined'
    && typeof window.electronAPI?.openExternalLink === 'function'
  ) {
    event.preventDefault()
    await openExternalLink(linkHref)
    return true
  }

  return false
}

const createMarkdownComponents = (workspacePath?: string) => ({
  a: ({ href, ...props }: ComponentProps<'a'>) => {
    const isLocalLink = isLocalMessageLinkHref(href)

    return (
      <a
        {...props}
        href={href}
        target={isLocalLink ? undefined : '_blank'}
        rel={isLocalLink ? undefined : 'noreferrer'}
        onClick={(event) => {
          void handleMessageLinkClick(event, href, workspacePath).catch(() => undefined)
        }}
      />
    )
  },
})

const getMarkdownComponents = (workspacePath?: string) => {
  const cacheKey = workspacePath ?? ''
  const cached = markdownComponentsCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const components = createMarkdownComponents(workspacePath)
  markdownComponentsCache.set(cacheKey, components)
  return components
}

const renderPlainMarkdown = (content: string, workspacePath: string | undefined, key?: string) => (
  <ReactMarkdown
    key={key}
    remarkPlugins={REMARK_PLUGINS}
    components={getMarkdownComponents(workspacePath)}
  >
    {content}
  </ReactMarkdown>
)

export const renderMarkdown = (content: string, workspacePath?: string) => {
  const chunks = splitMarkdownAndSafeHtmlTables(content)

  if (chunks.length === 1 && chunks[0]?.kind === 'markdown') {
    return renderPlainMarkdown(chunks[0].content, workspacePath)
  }

  return (
    <>
      {chunks.map((chunk, index) => {
        const key = `markdown-chunk-${index}`

        if (chunk.kind === 'markdown') {
          return chunk.content ? renderPlainMarkdown(chunk.content, workspacePath, key) : null
        }

        return renderSafeHtmlTable(chunk.table, key)
      })}
    </>
  )
}

const collapsePreviewWhitespace = (text: string) =>
  text
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const summarizeReasoningPreview = (text: string) => {
  const normalized = collapsePreviewWhitespace(
    text
      .replace(/```([\s\S]*?)```/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1'),
  )

  return normalized || collapsePreviewWhitespace(text)
}

export const getStructuredLabels = (language: AppLanguage) => {
  if (language === 'en') {
    return {
      shell: 'Shell',
      command: 'Command',
      shellOutput: 'Shell output',
      thinking: 'Thinking',
      details: 'Details',
      editedFiles: 'Edited files',
      ranCommands: (count: number) => `Ran ${count} command${count === 1 ? '' : 's'}`,
      usedTools: (count: number) => `Used ${count} tool${count === 1 ? '' : 's'}`,
      changedFiles: (count: number) => `${count} file${count === 1 ? '' : 's'} changed`,
      running: 'Running',
      completed: 'Completed',
      declined: 'Declined',
      viewDetails: 'View details',
      closeDetails: 'Close details',
      toolSummary: (toolName: string) => `${toolName} summary`,
      filePatch: (path: string) => `${path} patch`,
      openFile: (path: string) => `Open ${path}`,
      openDetails: (section: string) => `Open full ${section}`,
      exitCode: (code: number) => `Exit code ${code}`,
      changesSummary: 'Changes summary',
      tasks: 'Tasks',
      tasksCompleted: (completed: number, total: number) => `${completed} of ${total} completed`,
      noTasks: 'No active tasks',
      taskPending: 'Pending',
      taskInProgress: 'In progress',
      taskCompleted: 'Completed',
      priorityHigh: 'High priority',
      priorityMedium: 'Medium priority',
      priorityLow: 'Low priority',
      totalChanges: (files: number, added: number, removed: number) =>
        `${files} file${files === 1 ? '' : 's'} changed, ${added} insertion${added === 1 ? '' : 's'}(+), ${removed} deletion${removed === 1 ? '' : 's'}(-)`,
    }
  }

  return {
    shell: '\u7EC8\u7AEF',
    command: '\u547D\u4EE4',
    shellOutput: '\u7EC8\u7AEF\u8F93\u51FA',
    thinking: '\u601D\u8003\u4E2D',
    details: '\u8BE6\u60C5',
    editedFiles: '\u5DF2\u7F16\u8F91\u6587\u4EF6',
    ranCommands: (count: number) => `\u6267\u884C\u4E86 ${count} \u6761\u547D\u4EE4`,
    usedTools: (count: number) => `\u4F7F\u7528\u4E86 ${count} \u4E2A\u5DE5\u5177`,
    changedFiles: (count: number) => `\u5DF2\u53D8\u66F4 ${count} \u4E2A\u6587\u4EF6`,
    running: '\u8FDB\u884C\u4E2D',
    completed: '\u5DF2\u5B8C\u6210',
    declined: '\u5DF2\u62D2\u7EDD',
    viewDetails: '\u67E5\u770B\u5168\u90E8',
    closeDetails: '\u5173\u95ED\u8BE6\u60C5',
      toolSummary: (toolName: string) => `${toolName} \u6458\u8981`,
      filePatch: (path: string) => `${path} \u8865\u4E01`,
      openFile: (path: string) => `\u6253\u5F00 ${path}`,
      openDetails: (section: string) => `\u6253\u5F00${section}\u5168\u91CF\u8BE6\u60C5`,
    exitCode: (code: number) => `\u9000\u51FA\u7801 ${code}`,
    changesSummary: '\u53D8\u66F4\u6C47\u603B',
    tasks: '\u4EFB\u52A1',
    tasksCompleted: (completed: number, total: number) => `\u5DF2\u5B8C\u6210 ${completed}/${total}`,
    noTasks: '\u6682\u65E0\u4EFB\u52A1',
    taskPending: '\u5F85\u529E',
    taskInProgress: '\u8FDB\u884C\u4E2D',
    taskCompleted: '\u5DF2\u5B8C\u6210',
    priorityHigh: '\u9AD8\u4F18\u5148\u7EA7',
    priorityMedium: '\u4E2D\u4F18\u5148\u7EA7',
    priorityLow: '\u4F4E\u4F18\u5148\u7EA7',
    totalChanges: (files: number, added: number, removed: number) =>
      `\u5171\u53D8\u66F4 ${files} \u4E2A\u6587\u4EF6\uFF0C${added} \u884C\u63D2\u5165(+)\uFF0C${removed} \u884C\u5220\u9664(-)`,
  }
}

export type StructuredLabels = ReturnType<typeof getStructuredLabels>

const getStreamingActivityLabel = (kind: string, language: AppLanguage): string | null => {
  if (language === 'en') {
    switch (kind) {
      case 'reasoning': return 'Thinking'
      case 'command': return 'Running command'
      case 'tool': return 'Using tools'
      case 'edits': return 'Editing files'
      case 'todo': return 'Updating tasks'
      case 'ask-user': return 'Waiting for input'
      default: return null
    }
  }

  switch (kind) {
    case 'reasoning': return '\u601D\u8003\u4E2D'
    case 'command': return '\u6267\u884C\u547D\u4EE4\u4E2D'
    case 'tool': return '\u4F7F\u7528\u5DE5\u5177\u4E2D'
    case 'edits': return '\u7F16\u8F91\u6587\u4EF6\u4E2D'
    case 'todo': return '\u66F4\u65B0\u4EFB\u52A1\u4E2D'
    case 'ask-user': return '\u7B49\u5F85\u8F93\u5165'
    default: return null
  }
}

export const getStreamingLabel = (messages: ChatMessage[], language: AppLanguage): string => {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const currentTurnMessages = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages

  for (let i = currentTurnMessages.length - 1; i >= 0; i--) {
    const kind = currentTurnMessages[i].meta?.kind
    if (!kind) continue
    const label = getStreamingActivityLabel(kind, language)
    if (label) {
      return label
    }
  }

  return language === 'en' ? 'Writing' : '\u751F\u6210\u4E2D'
}

export const cleanCommandDisplay = (command: string) => {
  // Strip PowerShell wrapper: "...powershell.exe" -Command '...' or "..."
  const psMatchSingle = command.match(
    /^"[^"]*powershell(?:\.exe)?"[\s]+-(?:Command|c)\s+'([\s\S]+)'$/i,
  )
  if (psMatchSingle) return psMatchSingle[1]

  const psMatchDouble = command.match(
    /^"[^"]*powershell(?:\.exe)?"[\s]+-(?:Command|c)\s+"([\s\S]+)"$/i,
  )
  if (psMatchDouble) return psMatchDouble[1]

  // Strip cmd.exe wrapper: "...cmd.exe" /c "..."
  const cmdMatch = command.match(
    /^"[^"]*cmd(?:\.exe)?"[\s]+\/c\s+"([\s\S]+)"$/i,
  )
  if (cmdMatch) return cmdMatch[1]

  // Strip bash wrapper: /bin/bash -c "..." or bash -c "..."
  const bashMatch = command.match(
    /^(?:\/[^\s]*)?bash[\s]+-c\s+"([\s\S]+)"$/i,
  )
  if (bashMatch) return bashMatch[1]

  return command
}

const readLeadingCommandToken = (command: string) => {
  const match = command.trim().match(/^"([^"]+)"|'([^']+)'|([^\s]+)/)

  if (!match) {
    return ''
  }

  return match[1] ?? match[2] ?? match[3] ?? ''
}

const normalizeCommandToken = (token: string) =>
  token
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    .toLowerCase() ?? ''

const formatCommandName = (token: string) =>
  token.replace(/(^|[-_])([a-z])/g, (_match, boundary: string, letter: string) => `${boundary}${letter.toUpperCase()}`)

const hasCommandInvocation = (command: string, tokenPattern: string) =>
  new RegExp(`(?:^|[\\s;|&(){}\\[\\]=])(?:${tokenPattern})(?=$|[\\s;|&(){}\\[\\]=])`, 'i').test(command)

export const summarizeCommandDisplay = (command: string, language: AppLanguage) => {
  const cleanedCommand = cleanCommandDisplay(command).trim()
  const baseCommand = normalizeCommandToken(readLeadingCommandToken(cleanedCommand))
  const en = language === 'en'
  const isRipgrepFileSearch = /(?:^|\s)--files(?:\s|$)/.test(cleanedCommand)

  if (hasCommandInvocation(cleanedCommand, 'git(?:\\.exe)?')) {
    return en ? 'Git command' : 'Git \u547D\u4EE4'
  }

  if (hasCommandInvocation(cleanedCommand, 'get-content|cat|type')) {
    return en ? 'Read file' : '\u8BFB\u53D6\u6587\u4EF6'
  }

  if (hasCommandInvocation(cleanedCommand, 'get-childitem|ls|dir')) {
    return en ? 'List files' : '\u67E5\u770B\u6587\u4EF6\u5217\u8868'
  }

  if (hasCommandInvocation(cleanedCommand, 'grep|findstr|select-string')) {
    return en ? 'Search text' : '\u641C\u7D22\u6587\u672C'
  }

  if (hasCommandInvocation(cleanedCommand, 'rg(?:\\.exe)?')) {
    return isRipgrepFileSearch
      ? en
        ? 'Search files'
        : '\u641C\u7D22\u6587\u4EF6'
      : en
        ? 'Search text'
        : '\u641C\u7D22\u6587\u672C'
  }

  if (hasCommandInvocation(cleanedCommand, 'pnpm|npm|yarn|bun')) {
    return en ? 'Package script' : '\u5305\u7BA1\u7406\u547D\u4EE4'
  }

  if (!baseCommand) {
    return en ? 'Shell command' : '\u7EC8\u7AEF\u547D\u4EE4'
  }

  const commandName = formatCommandName(baseCommand)
  return en ? `${commandName} command` : `${commandName} \u547D\u4EE4`
}

export const buildToolGroupSummary = (
  items: StructuredToolGroupItem[],
  language: AppLanguage,
): string => {
  const labels = getStructuredLabels(language)
  let commandCount = 0
  let toolCount = 0
  let editsFileCount = 0

  for (const item of items) {
    switch (item.kind) {
      case 'command':
        commandCount++
        break
      case 'tool':
        toolCount++
        break
      case 'edits':
        editsFileCount += item.data.files.length
        break
    }
  }

  const fragments: string[] = []
  if (commandCount > 0) fragments.push(labels.ranCommands(commandCount))
  if (editsFileCount > 0) fragments.push(labels.changedFiles(editsFileCount))
  if (toolCount > 0) fragments.push(labels.usedTools(toolCount))

  return fragments.join(language === 'en' ? ', ' : '\uFF0C')
}
