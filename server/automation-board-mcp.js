import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const protocolVersion = '2025-03-26'

const boardMcpUrlEnvKey = 'CHILL_VIBE_BOARD_MCP_URL'
const boardMcpTokenEnvKey = 'CHILL_VIBE_BOARD_MCP_TOKEN'
const boardMcpBoardIdEnvKey = 'CHILL_VIBE_BOARD_MCP_BOARD_ID'

const listToolName = 'list_board_items'
const readToolName = 'read_board_item'
const moveToolName = 'move_board_item'
const sendToolName = 'send_board_item_message'
const wakeToolName = 'set_board_item_wake_timer'

const defaultTranscriptLimit = 20
const maxTranscriptLimit = 60
const minWakeDurationMinutes = 1
const maxWakeDurationMinutes = 7 * 24 * 60
const defaultWakeDurationMinutes = 30

// 这个文件由 process.execPath 直接当普通 Node 脚本 spawn（不经 tsx），所以
// 不能 import shared/schema.ts —— lane / wake mode 的字面量只能在这里重复一份。
// 唯一的防线是 tests/automation-board-mcp.test.ts 把生成的 command 拿去过
// automationBoardCommandSchema：字面量一旦漂移，那条断言立刻红。
const boardLanes = ['standby', 'running', 'done']
const wakeTimerModes = ['duration', 'workspace-agents', 'left-tab']

export const boardMcpToolDefinitions = [
  {
    name: listToolName,
    description:
      'List every requirement on the automation board you supervise: its cardId, lane (standby/running/done), the ORIGINAL requirement text, run status, when it started, when it last produced output, how many minutes it has been silent, and a preview of its last message. Call this first, and call it again after any write tool to confirm the result.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: readToolName,
    description:
      "Read the most recent transcript entries for one board requirement so you can judge whether the agent actually delivered it or is stuck. Use this before nudging or before moving an item to done.",
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The board item cardId returned by list_board_items.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: maxTranscriptLimit,
          default: defaultTranscriptLimit,
          description: 'How many recent transcript entries to read (default 20, max 60).',
        },
      },
      required: ['cardId'],
      additionalProperties: false,
    },
  },
  {
    name: moveToolName,
    description:
      'Move one board requirement to another lane. Moving to "running" starts execution (a fresh requirement is sent, an item with history is continued). Moving to "standby" or "done" interrupts execution if it is still running. Move a requirement to "done" only when it has genuinely been delivered.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The board item cardId returned by list_board_items.',
        },
        lane: {
          type: 'string',
          enum: boardLanes,
          description: 'standby = parked, running = executing, done = delivered.',
        },
      },
      required: ['cardId', 'lane'],
      additionalProperties: false,
    },
  },
  {
    name: sendToolName,
    description:
      'Send a message into one board requirement\'s own chat. This is how you 鞭策 (nudge / push) that agent: the message appears in that requirement\'s conversation exactly as if the user had typed it, so write it as an instruction addressed to that agent. Use it to demand progress from an agent that has gone silent, or to correct a wrong direction.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The board item cardId returned by list_board_items.',
        },
        message: {
          type: 'string',
          description: 'The instruction to deliver into that requirement\'s chat.',
        },
      },
      required: ['cardId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: wakeToolName,
    description:
      'Arm a wake timer on one board requirement so it resumes later instead of being nagged now. mode "duration" means "check back after N minutes" (durationMinutes, default 30). mode "workspace-agents" waits until every other agent in this workspace has finished. mode "left-tab" waits until the requirement above it in the same lane has finished. Prefer this over repeated nudging when an agent is legitimately waiting on sub-tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The board item cardId returned by list_board_items.',
        },
        mode: {
          type: 'string',
          enum: wakeTimerModes,
          description: 'duration = check back after N minutes; workspace-agents / left-tab = wait for others.',
        },
        durationMinutes: {
          type: 'number',
          minimum: minWakeDurationMinutes,
          maximum: maxWakeDurationMinutes,
          description: 'Minutes to wait when mode is "duration" (default 30).',
        },
      },
      required: ['cardId', 'mode'],
      additionalProperties: false,
    },
  },
]

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const readStringArg = (args, key) => normalizeText(args?.[key])

const clampTranscriptLimit = (raw) => {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) {
    return defaultTranscriptLimit
  }

  return Math.max(1, Math.min(Math.trunc(parsed), maxTranscriptLimit))
}

// 静默时长按注入的 nowMs 计算，绝不在这里读 Date.now() —— 监工要根据
// "超过半小时没下文"决定是否鞭策，这个判据必须可被单测钉死。
const describeSilence = (lastActivityAt, nowMs) => {
  const parsed = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN
  if (!Number.isFinite(parsed)) {
    return { text: 'no activity recorded yet (silence unknown)', minutes: null }
  }

  const minutes = Math.max(0, Math.floor((nowMs - parsed) / 60_000))
  return { text: `silent for ${minutes} minutes`, minutes }
}

const countByLane = (items) => {
  const counts = { standby: 0, running: 0, done: 0 }
  for (const item of items) {
    if (typeof counts[item?.lane] === 'number') {
      counts[item.lane] += 1
    }
  }
  return counts
}

export const buildBoardItemsText = (mirror, nowMs) => {
  const boardCardId = normalizeText(mirror?.boardCardId) || '(unknown board)'
  const items = Array.isArray(mirror?.items) ? mirror.items : []

  if (items.length === 0) {
    return `Automation board ${boardCardId} has no requirements yet. Nothing to supervise.`
  }

  const counts = countByLane(items)
  const workspace = normalizeText(mirror?.workspacePath)
  const lines = [
    `Automation board ${boardCardId}${workspace ? ` (workspace: ${workspace})` : ''} — ${items.length} requirement(s): standby ${counts.standby}, running ${counts.running}, done ${counts.done}.`,
    `Board snapshot taken at ${normalizeText(mirror?.generatedAt) || 'unknown time'}.`,
  ]

  for (const [index, item] of items.entries()) {
    const silence = describeSilence(item?.lastActivityAt, nowMs)
    lines.push('')
    lines.push(`${index + 1}. cardId: ${normalizeText(item?.cardId)}`)
    lines.push(`   Lane: ${normalizeText(item?.lane) || 'unknown'}`)
    lines.push(
      `   Status: ${normalizeText(item?.status) || 'unknown'}${item?.backgroundWorkPending ? ' (background work pending)' : ''}`,
    )
    lines.push(`   Requirement: ${normalizeText(item?.requirement) || '(empty requirement)'}`)
    if (normalizeText(item?.startedAt)) {
      lines.push(`   Started at: ${normalizeText(item.startedAt)}`)
    }
    if (normalizeText(item?.completedAt)) {
      lines.push(`   Completed at: ${normalizeText(item.completedAt)}`)
    }
    lines.push(
      `   Last activity: ${normalizeText(item?.lastActivityAt) || 'none'} — ${silence.text}`,
    )
    if (item?.wakeTimerActive) {
      lines.push(
        `   Wake timer: armed${normalizeText(item?.wakeTimerWakeAt) ? `, wakes at ${normalizeText(item.wakeTimerWakeAt)}` : ''}`,
      )
    }
    if (item?.repeatLoopActive) {
      lines.push('   Repeat loop: active')
    }
    if (normalizeText(item?.lastMessagePreview)) {
      lines.push(`   Last message: ${normalizeText(item.lastMessagePreview)}`)
    }
  }

  return lines.join('\n')
}

export const buildBoardItemTranscriptText = (cardId, entries) => {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) {
    return `Board item ${cardId} has no transcript entries yet.`
  }

  const lines = [`Recent transcript for board item ${cardId} (${list.length} entry/entries, oldest first):`]
  for (const [index, entry] of list.entries()) {
    const kind = normalizeText(entry?.kind)
    const createdAt = normalizeText(entry?.createdAt)
    const header = [`[${index + 1}]`, normalizeText(entry?.role) || 'unknown']
    if (kind) {
      header.push(`(${kind})`)
    }
    if (createdAt) {
      header.push(`at ${createdAt}`)
    }
    lines.push(header.join(' '))
    lines.push(normalizeText(entry?.content) || '(no text content)')
  }

  return lines.join('\n')
}

export const resolveBoardCommandFromToolCall = (name, args, boardCardId) => {
  const normalizedBoardCardId = normalizeText(boardCardId)
  if (!normalizedBoardCardId) {
    return { error: 'This session is not attached to an automation board, so write tools are unavailable.' }
  }

  const cardId = readStringArg(args, 'cardId')
  if (!cardId) {
    return { error: 'cardId is required. Call list_board_items to get the cardId of each requirement.' }
  }

  if (name === moveToolName) {
    const lane = readStringArg(args, 'lane')
    if (!boardLanes.includes(lane)) {
      return { error: `lane must be one of ${boardLanes.join(', ')}. Received: ${lane || '(missing)'}.` }
    }

    return { command: { type: 'board-move-item', boardCardId: normalizedBoardCardId, cardId, lane } }
  }

  if (name === sendToolName) {
    const message = readStringArg(args, 'message')
    if (!message) {
      return { error: 'message is required and must not be empty.' }
    }

    return {
      command: { type: 'board-send-item-message', boardCardId: normalizedBoardCardId, cardId, message },
    }
  }

  if (name === wakeToolName) {
    const mode = readStringArg(args, 'mode')
    if (!wakeTimerModes.includes(mode)) {
      return { error: `mode must be one of ${wakeTimerModes.join(', ')}. Received: ${mode || '(missing)'}.` }
    }

    if (mode !== 'duration') {
      return { command: { type: 'board-set-item-wake-timer', boardCardId: normalizedBoardCardId, cardId, mode } }
    }

    const rawDuration = args?.durationMinutes
    const durationMinutes = rawDuration === undefined || rawDuration === null
      ? defaultWakeDurationMinutes
      : Number(rawDuration)

    if (
      !Number.isFinite(durationMinutes)
      || durationMinutes < minWakeDurationMinutes
      || durationMinutes > maxWakeDurationMinutes
    ) {
      return {
        error: `durationMinutes must be a number between ${minWakeDurationMinutes} and ${maxWakeDurationMinutes}.`,
      }
    }

    return {
      command: {
        type: 'board-set-item-wake-timer',
        boardCardId: normalizedBoardCardId,
        cardId,
        mode,
        durationMinutes,
      },
    }
  }

  return { error: `Unknown automation board write tool: ${name}` }
}

const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
})

// 写工具返回的是"命令已投递"，不是"已生效"——与手机监工同语义：真正执行
// 的是渲染进程里的电脑端 handler，本进程无从得知结果，只能让模型再查一次。
const deliveredText = (action, cardId) =>
  `${action} for board item ${cardId} was delivered to the desktop app. Delivery is not confirmation that it took effect — call ${listToolName} again to verify the board state.`

export const callAutomationBoardTool = async (name, args, context) => {
  if (name === listToolName) {
    const mirror = await context.fetchBoard()
    if (!mirror) {
      return textResult(
        'The automation board is not available right now (the desktop app may have closed it). Try again shortly.',
        true,
      )
    }

    return textResult(buildBoardItemsText(mirror, context.nowMs ?? Date.now()))
  }

  if (name === readToolName) {
    const cardId = readStringArg(args, 'cardId')
    if (!cardId) {
      return textResult(`cardId is required. Call ${listToolName} first.`, true)
    }

    const entries = await context.fetchItem(cardId, clampTranscriptLimit(args?.limit))
    if (!entries) {
      return textResult(
        `No board item exists for cardId ${cardId}. Call ${listToolName} to get the current cardIds.`,
        true,
      )
    }

    return textResult(buildBoardItemTranscriptText(cardId, entries))
  }

  if (name === moveToolName || name === sendToolName || name === wakeToolName) {
    const resolved = resolveBoardCommandFromToolCall(name, args, context.boardCardId)
    if (resolved.error) {
      return textResult(resolved.error, true)
    }

    const outcome = await context.postCommand(resolved.command)
    if (!outcome?.accepted) {
      return textResult(
        `${name} for board item ${resolved.command.cardId} could NOT be delivered: ${outcome?.reason || 'the desktop app did not accept the command'}. The board is unchanged; try again shortly.`,
        true,
      )
    }

    return textResult(deliveredText(name, resolved.command.cardId))
  }

  return textResult(`Unknown automation board tool: ${name}`, true)
}

const createHttpBoardContext = () => {
  const baseUrl = process.env[boardMcpUrlEnvKey] ?? ''
  const token = process.env[boardMcpTokenEnvKey] ?? ''
  const boardCardId = process.env[boardMcpBoardIdEnvKey] ?? ''
  const authHeaders = { Authorization: `Bearer ${token}` }

  return {
    boardCardId,
    fetchBoard: async () => {
      if (!baseUrl) {
        return null
      }

      try {
        const response = await fetch(
          `${baseUrl}/board?boardCardId=${encodeURIComponent(boardCardId)}`,
          { headers: authHeaders },
        )
        if (!response.ok) {
          return null
        }
        const payload = await response.json()
        return payload?.mirror ?? null
      } catch {
        return null
      }
    },
    fetchItem: async (cardId, limit) => {
      if (!baseUrl) {
        return null
      }

      try {
        const response = await fetch(
          `${baseUrl}/item?cardId=${encodeURIComponent(cardId)}&limit=${limit}`,
          { headers: authHeaders },
        )
        if (!response.ok) {
          return null
        }
        const payload = await response.json()
        return Array.isArray(payload?.entries) ? payload.entries : null
      } catch {
        return null
      }
    },
    postCommand: async (command) => {
      if (!baseUrl) {
        return { accepted: false, reason: 'the board bridge URL is not configured' }
      }

      try {
        const response = await fetch(`${baseUrl}/command`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        })
        if (response.status === 503) {
          return { accepted: false, reason: 'no desktop window is available to execute board commands' }
        }
        if (!response.ok) {
          return { accepted: false, reason: `the board bridge rejected the command (HTTP ${response.status})` }
        }
        return { accepted: true }
      } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : 'the board bridge is unreachable' }
      }
    },
  }
}

const sendMessage = (message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`)
  process.stdout.write(payload)
}

const sendError = (id, code, message) => {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
}

const handleRequest = async (request, context) => {
  if (request.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request?.params?.protocolVersion || protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'chill-vibe-automation-board', version: '0.1.0' },
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
      result: { tools: boardMcpToolDefinitions },
    })
    return
  }

  if (request.method === 'tools/call') {
    const name = request?.params?.name
    const args = request?.params?.arguments
    const result = await callAutomationBoardTool(name, args, context)
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
  const context = createHttpBoardContext()
  let buffer = Buffer.alloc(0)

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }

      const headerText = buffer.subarray(0, headerEnd).toString('utf8')
      const lengthMatch = headerText.match(/Content-Length: (\d+)/i)
      if (!lengthMatch) {
        buffer = Buffer.alloc(0)
        return
      }

      const contentLength = Number(lengthMatch[1])
      const messageEnd = headerEnd + 4 + contentLength
      if (buffer.length < messageEnd) {
        return
      }

      const payload = buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
      buffer = buffer.subarray(messageEnd)

      let request
      try {
        request = JSON.parse(payload)
      } catch {
        continue
      }

      void handleRequest(request, context)
    }
  })
}

// 直接入口守卫（pitfall 211）：被 import 时绝不能自己跑起来，否则单测一
// import 就变成启动一个真实的 stdio 服务器。
const currentFilePath = fileURLToPath(import.meta.url)
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : ''

if (entryFilePath && currentFilePath === entryFilePath) {
  startStdioServer()
}
