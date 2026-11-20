import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const protocolVersion = '2025-03-26'
const imageAttachmentMetaKey = 'imageAttachments'
const archiveRecallContextPathEnvKey = 'CHILL_VIBE_ARCHIVE_RECALL_FILE'
const archiveRecallAttachmentsDirEnvKey = 'CHILL_VIBE_ARCHIVE_RECALL_ATTACHMENTS_DIR'
const genericImagePattern = /image|img|screenshot|photo|picture|diagram|screen/i
const genericLogPattern = /log|error|ci|command|trace|stderr|stdout/i
const maxInlineAttachmentBytes = 2 * 1024 * 1024
const maxInlineAttachmentsPerMessage = 3

const searchToolName = 'search_compacted_history'
const readToolName = 'read_compacted_history'

const toolDefinitions = [
  {
    name: searchToolName,
    description:
      "Search the current thread's compacted history hidden behind the latest /compact boundary. Use this when the user refers to an earlier hidden screenshot, log, or message.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The earlier screenshot, log, error, or message you want to find.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: readToolName,
    description:
      "Read one archived message from the current thread's compacted history and inline its attached images when available.",
    inputSchema: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'The archived message id returned by search_compacted_history.',
        },
      },
      required: ['itemId'],
      additionalProperties: false,
    },
  },
]

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const parseImageAttachments = (message) => {
  const raw = message?.meta?.[imageAttachmentMetaKey]
  if (typeof raw !== 'string' || !raw.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(
          (attachment) =>
            attachment
            && typeof attachment === 'object'
            && typeof attachment.id === 'string'
            && typeof attachment.fileName === 'string'
            && typeof attachment.mimeType === 'string'
            && typeof attachment.sizeBytes === 'number',
        )
      : []
  } catch {
    return []
  }
}

const buildMessageSearchText = (message) => {
  const attachments = parseImageAttachments(message)
  return [
    normalizeText(message?.content),
    normalizeText(message?.meta?.kind),
    normalizeText(message?.meta?.structuredData),
    attachments.map((attachment) => attachment.fileName).join(' '),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

const tokenizeQuery = (query) =>
  query
    .toLowerCase()
    .split(/[\s,.;:!?，。；：！？()（）\[\]{}<>\-_/]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)

const excerptText = (value, limit = 180) => {
  const text = normalizeText(value)
  if (!text) {
    return ''
  }

  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

const compareIsoDateDesc = (left, right) => (left > right ? -1 : left < right ? 1 : 0)

export const searchArchiveMessages = (snapshot, query, limit = 5) => {
  const normalizedQuery = normalizeText(query).toLowerCase()
  if (!snapshot || !Array.isArray(snapshot.messages) || !normalizedQuery) {
    return []
  }

  const genericImageQuery = genericImagePattern.test(query)
  const genericLogQuery = genericLogPattern.test(query)
  const queryTokens = tokenizeQuery(query)

  const ranked = snapshot.messages
    .map((message) => {
      const attachments = parseImageAttachments(message)
      const haystack = buildMessageSearchText(message)
      let score = 0

      if (haystack.includes(normalizedQuery)) {
        score += 120
      }

      for (const token of queryTokens) {
        if (haystack.includes(token)) {
          score += 24
        }
      }

      if (genericImageQuery && attachments.length > 0) {
        score += 80
      }

      if (genericLogQuery && (message?.meta?.kind === 'command' || message?.meta?.kind === 'tool')) {
        score += 40
      }

      return {
        itemId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        excerpt: excerptText(message.content || message?.meta?.structuredData || message?.meta?.kind || ''),
        attachmentNames: attachments.map((attachment) => attachment.fileName),
        score,
      }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareIsoDateDesc(left.createdAt, right.createdAt))

  const filtered =
    genericImageQuery && ranked.some((entry) => entry.attachmentNames.length > 0)
      ? ranked.filter((entry) => entry.attachmentNames.length > 0)
      : ranked

  return filtered.slice(0, Math.max(1, Math.min(Math.trunc(limit) || 5, 10)))
}

const findArchiveMessage = (snapshot, itemId) =>
  Array.isArray(snapshot?.messages)
    ? snapshot.messages.find((message) => message && message.id === itemId) ?? null
    : null

const buildSearchToolText = (query, results) => {
  if (results.length === 0) {
    return `No compacted history matched \"${query}\".`
  }

  const lines = [`Found ${results.length} matching compacted history item(s):`]
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. itemId: ${result.itemId}`)
    lines.push(`   Time: ${result.createdAt}`)
    lines.push(`   Role: ${result.role}`)
    if (result.attachmentNames.length > 0) {
      lines.push(`   Attachments: ${result.attachmentNames.join(', ')}`)
    }
    if (result.excerpt) {
      lines.push(`   Excerpt: ${result.excerpt}`)
    }
  }

  lines.push('Call read_compacted_history with an itemId to inspect the original archived message and inline images.')
  return lines.join('\n')
}

const buildReadText = (message, attachmentStatuses) => {
  const lines = [`itemId: ${message.id}`, `Time: ${message.createdAt}`, `Role: ${message.role}`]

  if (message?.meta?.kind) {
    lines.push(`Kind: ${message.meta.kind}`)
  }

  if (attachmentStatuses.length > 0) {
    lines.push('Attachments:')
    for (const status of attachmentStatuses) {
      lines.push(`- ${status}`)
    }
  }

  const content = normalizeText(message.content)
  if (content) {
    lines.push('Content:')
    lines.push(content)
  }

  const structuredData = normalizeText(message?.meta?.structuredData)
  if (structuredData) {
    lines.push('Structured data:')
    try {
      lines.push(JSON.stringify(JSON.parse(structuredData), null, 2))
    } catch {
      lines.push(structuredData)
    }
  }

  return lines.join('\n')
}

const readAttachmentAsBase64 = (attachmentsDir, attachment) => {
  const filePath = path.join(attachmentsDir, path.basename(attachment.id))
  const stat = fs.statSync(filePath, { throwIfNoEntry: false })
  if (!stat || !stat.isFile()) {
    return { status: `${attachment.fileName} (missing local file)`, content: null }
  }

  if (stat.size > maxInlineAttachmentBytes) {
    return { status: `${attachment.fileName} (too large to inline)`, content: null }
  }

  const data = fs.readFileSync(filePath).toString('base64')
  return {
    status: `${attachment.fileName} (image inlined)`,
    content: { type: 'image', data, mimeType: attachment.mimeType },
  }
}

const buildReadToolResult = async (snapshot, itemId, options = {}) => {
  const message = findArchiveMessage(snapshot, itemId)
  if (!message) {
    return {
      content: [{ type: 'text', text: `No compacted history item exists for itemId ${itemId}.` }],
      isError: true,
    }
  }

  const attachments = parseImageAttachments(message).slice(0, maxInlineAttachmentsPerMessage)
  const attachmentsDir = options.attachmentsDir || process.env[archiveRecallAttachmentsDirEnvKey] || ''
  const attachmentStatuses = []
  const imageContent = []

  for (const attachment of attachments) {
    if (!attachmentsDir) {
      attachmentStatuses.push(`${attachment.fileName} (attachments directory not configured)`)
      continue
    }

    const result = readAttachmentAsBase64(attachmentsDir, attachment)
    attachmentStatuses.push(result.status)
    if (result.content) {
      imageContent.push(result.content)
    }
  }

  return {
    content: [{ type: 'text', text: buildReadText(message, attachmentStatuses) }, ...imageContent],
    isError: false,
  }
}

export const callArchiveRecallTool = async (name, args, snapshot, options = {}) => {
  if (name === searchToolName) {
    const query = typeof args?.query === 'string' ? args.query : ''
    const limit = typeof args?.limit === 'number' ? args.limit : 5
    const results = searchArchiveMessages(snapshot, query, limit)
    return {
      content: [{ type: 'text', text: buildSearchToolText(query, results) }],
      isError: false,
    }
  }

  if (name === readToolName) {
    const itemId = typeof args?.itemId === 'string' ? args.itemId : ''
    return buildReadToolResult(snapshot, itemId, options)
  }

  return {
    content: [{ type: 'text', text: `Unknown archive recall tool: ${name}` }],
    isError: true,
  }
}

const loadSnapshotFromEnv = () => {
  const filePath = process.env[archiveRecallContextPathEnvKey]
  if (!filePath) {
    return { hiddenReason: 'compact', hiddenMessageCount: 0, messages: [] }
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return { hiddenReason: 'compact', hiddenMessageCount: 0, messages: [] }
  }
}

// 症状：Codex 压缩后注入本服务端，握手超时，search/read_compacted_history 从未可用。
// 根因（2026-11-20 审查）：这里原是 LSP 的 Content-Length 分帧，而 MCP stdio 是换行分帧的 JSON-RPC，
//   换行帧的 initialize 永远凑不出 \r\n\r\n 头，服务端一个字节都不回。同 automation-board-mcp.js 的 ADR，别改回去。
const sendMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const sendError = (id, code, message) => {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

const handleRequest = async (request, snapshot) => {
  if (request.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request?.params?.protocolVersion || protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'chill-vibe-archive-recall', version: '0.1.0' },
      },
    })
    return
  }

  if (request.method === 'notifications/initialized') {
    return
  }

  if (request.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: toolDefinitions },
    })
    return
  }

  if (request.method === 'tools/call') {
    const name = request?.params?.name
    const args = request?.params?.arguments
    const result = await callArchiveRecallTool(name, args, snapshot)
    sendMessage({
      jsonrpc: '2.0',
      id: request.id,
      result,
    })
    return
  }

  if (request.id !== undefined) {
    sendError(request.id, -32601, `Method not found: ${request.method}`)
  }
}

const startStdioServer = () => {
  const snapshot = loadSnapshotFromEnv()
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const payload = line.trim()
      if (!payload) continue

      let request
      try {
        request = JSON.parse(payload)
      } catch {
        continue
      }

      void handleRequest(request, snapshot)
    }
  })
}

const currentFilePath = fileURLToPath(import.meta.url)
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : ''

if (entryFilePath && currentFilePath === entryFilePath) {
  startStdioServer()
}
