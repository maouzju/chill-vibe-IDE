import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const protocolVersion = '2025-03-26'

const adminMcpUrlEnvKey = 'CHILL_VIBE_ADMIN_MCP_URL'
const adminMcpTokenEnvKey = 'CHILL_VIBE_ADMIN_MCP_TOKEN'
const adminMcpColumnIdEnvKey = 'CHILL_VIBE_ADMIN_MCP_COLUMN_ID'
const adminMcpSelfCardIdEnvKey = 'CHILL_VIBE_ADMIN_MCP_SELF_CARD_ID'

const listToolName = 'list_sessions'
const readToolName = 'read_session'
const moveToolName = 'move_session_to_lane'
const sendToolName = 'send_session_message'
const wakeToolName = 'set_session_wake_timer'

const defaultTranscriptLimit = 20
const maxTranscriptLimit = 60
const minWakeDurationMinutes = 1
const maxWakeDurationMinutes = 7 * 24 * 60
const defaultWakeDurationMinutes = 30

// 这个文件由 process.execPath 直接当普通 Node 脚本 spawn（不经 tsx），所以
// 不能 import shared/schema.ts —— lane / wake mode 的字面量只能在这里重复一份。
// 唯一的防线是 tests/automation-board-mcp.test.ts 把生成的 command 拿去过
// workspaceAdminCommandSchema：字面量一旦漂移，那条断言立刻红。
const boardLanes = ['standby', 'running', 'done']
const wakeTimerModes = ['duration', 'workspace-agents', 'left-tab']

export const workspaceAdminMcpToolDefinitions = [
  {
    name: listToolName,
    description:
      'List every session in this workspace: its cardId, title, provider/model, run status, whether it sits on an automation board (and in which lane) or is a standalone tab session, the ORIGINAL requirement for board items, when it started, when it last produced output, how many minutes it has been silent, and a preview of its last message. Your own session is excluded. Call this first, and call it again after any write tool to confirm the result.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: readToolName,
    description:
      'Read the most recent transcript entries for one session so you can judge whether that agent actually delivered or is stuck. Use this before nudging it or before moving it to done.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The session cardId returned by list_sessions.',
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
      'Move one session into an automation board lane. Moving to "running" starts execution (a fresh requirement is sent, a session with history is continued). Moving to "standby" or "done" interrupts execution if it is still running. Move a session to "done" only when its requirement has genuinely been delivered. The target board is decided by the app: if the session is already on a board that board is used, otherwise the first board card in this workspace is used; if this workspace has no board card at all the move fails.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The session cardId returned by list_sessions.',
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
      'Send a message into one session\'s own chat. This is how you 鞭策 (nudge / push) that agent: the message appears in that session\'s conversation exactly as if the user had typed it, so write it as an instruction addressed to that agent. Use it to demand progress from an agent that has gone silent, or to correct a wrong direction.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The session cardId returned by list_sessions.',
        },
        message: {
          type: 'string',
          description: 'The instruction to deliver into that session\'s chat.',
        },
      },
      required: ['cardId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: wakeToolName,
    description:
      'Arm a wake timer on one session so it resumes later instead of being nagged now. mode "duration" means "check back after N minutes" (durationMinutes, default 30). mode "workspace-agents" waits until every other agent in this workspace has finished. mode "left-tab" waits until the session before it has finished. Prefer this over repeated nudging when an agent is legitimately waiting on sub-tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The session cardId returned by list_sessions.',
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

// 静默时长按注入的 nowMs 计算，绝不在这里读 Date.now() —— 超管要根据
// "超过半小时没下文"决定是否鞭策，这个判据必须可被单测钉死。
const describeSilence = (lastActivityAt, nowMs) => {
  const parsed = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN
  if (!Number.isFinite(parsed)) {
    return { text: 'no activity recorded yet (silence unknown)', minutes: null }
  }

  const minutes = Math.max(0, Math.floor((nowMs - parsed) / 60_000))
  return { text: `silent for ${minutes} minutes`, minutes }
}

const countByLane = (sessions) => {
  const counts = { standby: 0, running: 0, done: 0, tab: 0 }
  for (const session of sessions) {
    const lane = session?.board?.lane
    if (typeof counts[lane] === 'number') {
      counts[lane] += 1
    } else {
      counts.tab += 1
    }
  }
  return counts
}

// 请求方自己绝不出现在清单里：否则模型会把自己列出来，再给自己发一条鞭策。
const selectVisibleSessions = (mirror, selfCardId) => {
  const sessions = Array.isArray(mirror?.sessions) ? mirror.sessions : []
  const self = normalizeText(selfCardId)
  return self ? sessions.filter((session) => normalizeText(session?.cardId) !== self) : sessions
}

export const buildWorkspaceSessionsText = (mirror, nowMs, selfCardId) => {
  const columnId = normalizeText(mirror?.columnId) || '(unknown workspace)'
  const sessions = selectVisibleSessions(mirror, selfCardId)

  if (sessions.length === 0) {
    return `Workspace ${columnId} has no other sessions right now. Nothing to supervise.`
  }

  const counts = countByLane(sessions)
  const workspace = normalizeText(mirror?.workspacePath)
  const boardCardIds = Array.isArray(mirror?.boardCardIds) ? mirror.boardCardIds : []
  const lines = [
    `Workspace ${columnId}${workspace ? ` (${workspace})` : ''} — ${sessions.length} session(s): board standby ${counts.standby}, board running ${counts.running}, board done ${counts.done}, standalone tabs ${counts.tab}.`,
    boardCardIds.length > 0
      ? `Automation board card(s) in this workspace: ${boardCardIds.join(', ')}.`
      : 'This workspace has no automation board card, so move_session_to_lane will fail here.',
    `Snapshot taken at ${normalizeText(mirror?.generatedAt) || 'unknown time'}.`,
  ]

  for (const [index, session] of sessions.entries()) {
    const silence = describeSilence(session?.lastActivityAt, nowMs)
    const board = session?.board
    lines.push('')
    lines.push(`${index + 1}. cardId: ${normalizeText(session?.cardId)}`)
    lines.push(`   Title: ${normalizeText(session?.title) || '(untitled)'}`)
    lines.push(
      `   Model: ${normalizeText(session?.provider) || 'unknown'}${normalizeText(session?.model) ? ` / ${normalizeText(session.model)}` : ''}`,
    )
    if (board) {
      lines.push(
        `   Board: ${normalizeText(board.boardCardId) || 'unknown board'}, lane ${normalizeText(board.lane) || 'unknown'}`,
      )
      lines.push(`   Requirement: ${normalizeText(board.requirement) || '(empty requirement)'}`)
      if (normalizeText(board.startedAt)) {
        lines.push(`   Started at: ${normalizeText(board.startedAt)}`)
      }
      if (normalizeText(board.completedAt)) {
        lines.push(`   Completed at: ${normalizeText(board.completedAt)}`)
      }
    } else {
      lines.push('   Board: none — this is a standalone tab session.')
    }
    lines.push(
      `   Status: ${normalizeText(session?.status) || 'unknown'}${session?.backgroundWorkPending ? ' (background work pending)' : ''}`,
    )
    lines.push(
      `   Last activity: ${normalizeText(session?.lastActivityAt) || 'none'} — ${silence.text}`,
    )
    if (session?.wakeTimerActive) {
      lines.push(
        `   Wake timer: armed${normalizeText(session?.wakeTimerWakeAt) ? `, wakes at ${normalizeText(session.wakeTimerWakeAt)}` : ''}`,
      )
    }
    if (session?.repeatLoopActive) {
      lines.push('   Repeat loop: active')
    }
    if (normalizeText(session?.lastMessagePreview)) {
      lines.push(`   Last message: ${normalizeText(session.lastMessagePreview)}`)
    }
  }

  return lines.join('\n')
}

export const buildSessionTranscriptText = (cardId, entries) => {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) {
    return `Session ${cardId} has no transcript entries yet.`
  }

  const lines = [`Recent transcript for session ${cardId} (${list.length} entry/entries, oldest first):`]
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

export const resolveWorkspaceAdminCommandFromToolCall = (name, args, columnId) => {
  const normalizedColumnId = normalizeText(columnId)
  if (!normalizedColumnId) {
    return { error: 'This session has no workspace admin access, so the write tools are unavailable.' }
  }

  const cardId = readStringArg(args, 'cardId')
  if (!cardId) {
    return { error: `cardId is required. Call ${listToolName} to get the cardId of each session.` }
  }

  if (name === moveToolName) {
    const lane = readStringArg(args, 'lane')
    if (!boardLanes.includes(lane)) {
      return { error: `lane must be one of ${boardLanes.join(', ')}. Received: ${lane || '(missing)'}.` }
    }

    return {
      command: { type: 'admin-move-session-to-lane', columnId: normalizedColumnId, cardId, lane },
    }
  }

  if (name === sendToolName) {
    const message = readStringArg(args, 'message')
    if (!message) {
      return { error: 'message is required and must not be empty.' }
    }

    return {
      command: {
        type: 'admin-send-session-message',
        columnId: normalizedColumnId,
        cardId,
        message,
      },
    }
  }

  if (name === wakeToolName) {
    const mode = readStringArg(args, 'mode')
    if (!wakeTimerModes.includes(mode)) {
      return { error: `mode must be one of ${wakeTimerModes.join(', ')}. Received: ${mode || '(missing)'}.` }
    }

    if (mode !== 'duration') {
      return {
        command: {
          type: 'admin-set-session-wake-timer',
          columnId: normalizedColumnId,
          cardId,
          mode,
        },
      }
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
        type: 'admin-set-session-wake-timer',
        columnId: normalizedColumnId,
        cardId,
        mode,
        durationMinutes,
      },
    }
  }

  return { error: `Unknown workspace admin write tool: ${name}` }
}

const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
})

// 写工具返回的是"命令已投递"，不是"已生效"——与手机监工同语义：真正执行
// 的是渲染进程里的电脑端 handler，本进程无从得知结果，只能让模型再查一次。
const deliveredText = (action, cardId) =>
  `${action} for session ${cardId} was delivered to the desktop app. Delivery is not confirmation that it took effect — call ${listToolName} again to verify the workspace state.`

export const callWorkspaceAdminTool = async (name, args, context) => {
  if (name === listToolName) {
    const mirror = await context.fetchWorkspace()
    if (!mirror) {
      return textResult(
        'This workspace is not available right now (the desktop app may have closed it). Try again shortly.',
        true,
      )
    }

    return textResult(
      buildWorkspaceSessionsText(mirror, context.nowMs ?? Date.now(), context.selfCardId),
    )
  }

  if (name === readToolName) {
    const cardId = readStringArg(args, 'cardId')
    if (!cardId) {
      return textResult(`cardId is required. Call ${listToolName} first.`, true)
    }

    const entries = await context.fetchSession(cardId, clampTranscriptLimit(args?.limit))
    if (!entries) {
      return textResult(
        `No session exists for cardId ${cardId}. Call ${listToolName} to get the current cardIds.`,
        true,
      )
    }

    return textResult(buildSessionTranscriptText(cardId, entries))
  }

  if (name === moveToolName || name === sendToolName || name === wakeToolName) {
    const resolved = resolveWorkspaceAdminCommandFromToolCall(name, args, context.columnId)
    if (resolved.error) {
      return textResult(resolved.error, true)
    }

    const outcome = await context.postCommand(resolved.command)
    if (!outcome?.accepted) {
      return textResult(
        `${name} for session ${resolved.command.cardId} could NOT be delivered: ${outcome?.reason || 'the desktop app did not accept the command'}. Nothing changed; try again shortly.`,
        true,
      )
    }

    return textResult(deliveredText(name, resolved.command.cardId))
  }

  return textResult(`Unknown workspace admin tool: ${name}`, true)
}

const createHttpWorkspaceContext = () => {
  const baseUrl = process.env[adminMcpUrlEnvKey] ?? ''
  const token = process.env[adminMcpTokenEnvKey] ?? ''
  const columnId = process.env[adminMcpColumnIdEnvKey] ?? ''
  const selfCardId = process.env[adminMcpSelfCardIdEnvKey] ?? ''
  const authHeaders = { Authorization: `Bearer ${token}` }

  return {
    columnId,
    selfCardId,
    fetchWorkspace: async () => {
      if (!baseUrl) {
        return null
      }

      try {
        const response = await fetch(
          `${baseUrl}/workspace?columnId=${encodeURIComponent(columnId)}`,
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
    fetchSession: async (cardId, limit) => {
      if (!baseUrl) {
        return null
      }

      try {
        const response = await fetch(
          `${baseUrl}/session?cardId=${encodeURIComponent(cardId)}&limit=${limit}`,
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
        return { accepted: false, reason: 'the workspace admin bridge URL is not configured' }
      }

      try {
        const response = await fetch(`${baseUrl}/command`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
        })
        if (response.status === 503) {
          return { accepted: false, reason: 'no desktop window is available to execute workspace admin commands' }
        }
        if (!response.ok) {
          return { accepted: false, reason: `the workspace admin bridge rejected the command (HTTP ${response.status})` }
        }
        return { accepted: true }
      } catch (error) {
        return { accepted: false, reason: error instanceof Error ? error.message : 'the workspace admin bridge is unreachable' }
      }
    },
  }
}

// 症状：Claude / Codex 两端都报 `Failed to connect: chill_vibe_workspace`，超管
// 权限从上线起就是死的（2026-08-13 实测：换行帧发 initialize，服务端一个字节
// 都不回）。根因：这里原来写的是 LSP 的 `Content-Length` 分帧，而 MCP 的 stdio
// 绑定是**换行分隔**的 JSON-RPC —— 规范原文 "the stdio binding is just
// newline-delimited JSON-RPC over a byte stream"。为什么不能"两种都收"：出站
// 只有一种格式，多写一个 Content-Length 头就把换行帧客户端的流污染成垃圾，
// 而 LSP 客户端在这里一个都不存在。JSON.stringify 会把内容里的换行转义掉，
// 所以一条消息永远落在一行里。
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

const handleRequest = async (request, context) => {
  if (request.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request?.params?.protocolVersion || protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'chill-vibe-workspace-admin', version: '0.1.0' },
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
      result: { tools: workspaceAdminMcpToolDefinitions },
    })
    return
  }

  if (request.method === 'tools/call') {
    const name = request?.params?.name
    const args = request?.params?.arguments
    const result = await callWorkspaceAdminTool(name, args, context)
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
  const context = createHttpWorkspaceContext()
  let pending = ''

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    pending += chunk

    // 一行 = 一条消息。最后一段可能是半条，留在 pending 里等下一个 chunk。
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''

    for (const line of lines) {
      const payload = line.trim()
      if (!payload) {
        continue
      }

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
