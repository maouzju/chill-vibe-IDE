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
const createToolName = 'create_session'
const moveToolName = 'move_session_to_lane'
const sendToolName = 'send_session_message'
const wakeToolName = 'set_session_wake_timer'
const awaitToolName = 'wake_me_when_sessions_finish'

const defaultTranscriptLimit = 20
const maxTranscriptLimit = 60
const minWakeDurationMinutes = 1
const maxWakeDurationMinutes = 7 * 24 * 60
const defaultWakeDurationMinutes = 30
const defaultAwaitTimeoutMinutes = 60

// 这个文件由 process.execPath 直接当普通 Node 脚本 spawn（不经 tsx），所以
// 不能 import shared/schema.ts —— lane / wake mode 的字面量只能在这里重复一份。
// 唯一的防线是 tests/automation-board-mcp.test.ts 把生成的 command 拿去过
// workspaceAdminCommandSchema：字面量一旦漂移，那条断言立刻红。
const boardLanes = ['standby', 'running', 'done']
const creatableLanes = ['standby', 'running']
const providers = ['codex', 'claude']
const wakeTimerModes = ['duration', 'workspace-agents', 'left-tab']
const defaultCreateLane = 'running'

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
    name: createToolName,
    description:
      'Create a NEW session in this workspace and hand it a requirement. Use this when the work needs another agent — including when this workspace has no sessions at all yet, in which case the other tools have nothing to operate on. lane "running" (the default) creates the session and immediately sends the requirement as its first message; lane "standby" creates it with the requirement parked in its draft so you can start it later with move_session_to_lane. Where it lands is decided by the app: if this workspace has an automation board the session becomes a board item in that lane, otherwise it becomes an ordinary tab session. The new session does NOT inherit your admin access.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description:
            'The requirement for the new session, written as an instruction addressed to that agent.',
        },
        lane: {
          type: 'string',
          enum: creatableLanes,
          description: 'running = start it now (default), standby = park it with the requirement drafted.',
        },
        provider: {
          type: 'string',
          enum: providers,
          description: 'Which CLI runs the new session. Defaults to this workspace column\'s provider.',
        },
        model: {
          type: 'string',
          description: 'Model id for the new session. Defaults to this workspace column\'s model.',
        },
      },
      required: ['requirement'],
      additionalProperties: false,
    },
  },
  {
    name: moveToolName,
    description:
      'Move one session into an automation board lane. Moving to "running" starts execution (a fresh requirement is sent, a session with history is continued). Moving to "standby" or "done" interrupts execution if it is still running. Move a session to "done" only when its requirement has genuinely been delivered. The target board is decided by the app: if the session is already on a board that board is used, otherwise the first board card in this workspace is used; if this workspace has no board card at all the move fails. To archive YOURSELF once your own work is delivered, omit cardId and pass lane "done" — you are not in list_sessions so you have no cardId of your own. That move interrupts you, so END YOUR TURN right after it; omitting cardId is only allowed with lane "done".',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description:
            'The session cardId returned by list_sessions. Omit it to target yourself, which is only allowed with lane "done".',
        },
        lane: {
          type: 'string',
          enum: boardLanes,
          description: 'standby = parked, running = executing, done = delivered.',
        },
      },
      required: ['lane'],
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
  {
    name: awaitToolName,
    description:
      'Register the sessions you are waiting on and END YOUR TURN — you will be woken up automatically once they finish, and your note is delivered back to you as your next message. This is how supervising works: dispatch the work, register the wait, stop talking. Do NOT poll list_sessions in a loop instead; that burns your whole context and you still cannot outlast the agents you are supervising. cardIds defaults to every other session in this workspace. timeoutMinutes is a hard upper bound (default 60): a target that gets interrupted, errors out, or never starts will never report completion, so the wait always ends by then. Waking up does not end your supervision — register another wait whenever there is still work in flight.',
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description:
            'What future-you should do on waking, written as an instruction addressed to yourself (e.g. "read_session on card A and B, move whichever delivered to done"). It arrives as your next message, so it is the only thing you will know about why you woke up.',
        },
        cardIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The session cardIds to wait for, from list_sessions. Omit to wait for every other session in this workspace.',
        },
        timeoutMinutes: {
          type: 'number',
          minimum: minWakeDurationMinutes,
          maximum: maxWakeDurationMinutes,
          description: 'Wake up no later than this many minutes from now (default 60).',
        },
      },
      required: ['note'],
      additionalProperties: false,
    },
  },
]

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '')

const readStringArg = (args, key) => normalizeText(args?.[key])

// "省略了这个参数" 和 "传了这个参数但值是空的" 必须分得开：readStringArg 把
// undefined / "" / "   " / null 一律压成 ''，凡是拿它的真假做分流的地方都会把
// 后者当成前者。undefined 仍算缺省（JSON-RPC 传不出 undefined，只有 JS 侧显式
// 写出来才有，而那与省略是同一个意思）。
const hasExplicitArg = (args, key) =>
  typeof args === 'object' && args !== null && key in args && args[key] !== undefined

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

export const resolveWorkspaceAdminCommandFromToolCall = (name, args, columnId, selfCardId) => {
  const normalizedColumnId = normalizeText(columnId)
  if (!normalizedColumnId) {
    return { error: 'This session has no workspace admin access, so the write tools are unavailable.' }
  }

  // create 之外的第二个「目标卡不是入参」的写工具，同样必须走在下面那道统一的
  // cardId 必填检查之前（pitfall 294）：它等待的是别人，唤醒的是**调用者自己**，
  // 而 self cardId 只能来自进程环境，模型手里根本没有这个值。
  if (name === awaitToolName) {
    const note = readStringArg(args, 'note')
    if (!note) {
      return {
        error:
          'note is required and must not be empty. It comes back to you as your next message, so it is the only thing you will know about why you woke up.',
      }
    }

    const self = normalizeText(selfCardId)
    if (!self) {
      return {
        error: 'This session cannot tell which session to wake, so it cannot register a wait.',
      }
    }

    const rawCardIds = args?.cardIds
    let targetCardIds = []
    if (rawCardIds !== undefined && rawCardIds !== null) {
      if (!Array.isArray(rawCardIds)) {
        return { error: `cardIds must be an array of session cardIds from ${listToolName}.` }
      }

      const normalized = rawCardIds.map((entry) => normalizeText(entry))
      if (normalized.some((entry) => !entry)) {
        return { error: `cardIds must not contain empty entries. Call ${listToolName} to get the current cardIds.` }
      }

      // 自己永远不在等待名单里：等自己结束就是等一个永远不会到达的事件 ——
      // 这条批次恰恰要在自己空闲之后才发车。
      targetCardIds = [...new Set(normalized.filter((entry) => entry !== self))]
    }

    const rawTimeout = args?.timeoutMinutes
    const timeoutMinutes = rawTimeout === undefined || rawTimeout === null
      ? defaultAwaitTimeoutMinutes
      : Number(rawTimeout)

    if (
      !Number.isFinite(timeoutMinutes)
      || timeoutMinutes < minWakeDurationMinutes
      || timeoutMinutes > maxWakeDurationMinutes
    ) {
      return {
        error: `timeoutMinutes must be a number between ${minWakeDurationMinutes} and ${maxWakeDurationMinutes}.`,
      }
    }

    return {
      command: {
        type: 'admin-await-sessions',
        columnId: normalizedColumnId,
        cardId: self,
        targetCardIds,
        note,
        timeoutMinutes,
      },
    }
  }

  // create 必须在 cardId 校验之前分流：它是唯一一个目标卡还不存在的写工具，
  // 落到下面那道统一检查里就会永远返回 "cardId is required" 而根本建不成卡。
  if (name === createToolName) {
    const requirement = readStringArg(args, 'requirement')
    if (!requirement) {
      return { error: 'requirement is required and must not be empty.' }
    }

    const rawLane = readStringArg(args, 'lane')
    const lane = rawLane || defaultCreateLane
    if (!creatableLanes.includes(lane)) {
      return {
        error: `lane must be one of ${creatableLanes.join(', ')} when creating a session. Received: ${rawLane || '(missing)'}. A brand new session cannot start out done.`,
      }
    }

    const provider = readStringArg(args, 'provider')
    if (provider && !providers.includes(provider)) {
      return { error: `provider must be one of ${providers.join(', ')}. Received: ${provider}.` }
    }

    const model = readStringArg(args, 'model')

    return {
      command: {
        type: 'admin-create-session',
        columnId: normalizedColumnId,
        requirement,
        lane,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    }
  }

  // 症状：超管干完活后报「拿不到自己的 cardId，没法把我自己这张卡移到已完成」，
  // 只能求用户手动拖（2026-08-17 用户实测）。根因：selectVisibleSessions 按
  // SELF_CARD_ID 把请求方自己滤出 list_sessions（防它给自己发鞭策），于是模型手里
  // 永远没有自己的 id，而这里的统一 cardId 必填检查又把它挡在门外。所以自移必须
  // 和 create / await 一样在这道检查之前分流，cardId 取自环境而不是模型入参。
  // 为什么只放开 done：自移 running 会给自己重发需求形成自我重入循环，自移
  // standby 是把自己停在一条没人会来启动的道上 —— 两者都不是"归档"。
  const explicitCardId = readStringArg(args, 'cardId')
  if (name === moveToolName) {
    const lane = readStringArg(args, 'lane')
    if (!boardLanes.includes(lane)) {
      return { error: `lane must be one of ${boardLanes.join(', ')}. Received: ${lane || '(missing)'}.` }
    }

    if (explicitCardId) {
      return {
        command: {
          type: 'admin-move-session-to-lane',
          columnId: normalizedColumnId,
          cardId: explicitCardId,
          lane,
        },
      }
    }

    // 症状：模型调 move_session_to_lane({ cardId: "", lane: "done" })（比如它想填的
    //   那个 id 取值失败成了空白）时，超管把自己中断并归档了，返回文案还是
    //   "END YOUR TURN NOW"，它意识不到搞错了目标。
    // 根因：cardId 从 required 里放宽后，自移分支只看 readStringArg 的真假，而空串
    //   与"没传"在它眼里完全一样，于是空值直接掉进了下面的 self 分支。
    // 为什么不能靠 lane 再拦一道：lane 本来就必须是 done 才走到这里，拦不住这一例；
    //   唯一能分开"没传"和"传了个空的"的信息就是键在不在 args 上。
    if (hasExplicitArg(args, 'cardId')) {
      return {
        error: `cardId was provided but empty. Pass a real cardId from ${listToolName}, or omit the cardId argument entirely if you really meant to archive yourself.`,
      }
    }

    if (lane !== 'done') {
      return {
        error: `cardId is required to move another session. Omitting it targets yourself, which is only allowed with lane "done". Call ${listToolName} to get the cardId of each session.`,
      }
    }

    const self = normalizeText(selfCardId)
    if (!self) {
      return { error: `cardId is required. Call ${listToolName} to get the cardId of each session.` }
    }

    return {
      command: { type: 'admin-move-session-to-lane', columnId: normalizedColumnId, cardId: self, lane },
      selfArchive: true,
    }
  }

  const cardId = explicitCardId
  if (!cardId) {
    return { error: `cardId is required. Call ${listToolName} to get the cardId of each session.` }
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

// create 没有 cardId（卡还不存在），await 的 cardId 是调用者自己，所以目标只能
// 按命令类型描述，否则这两条文案会渲染出 "for session undefined"。
const describeCommandTarget = (command) => {
  if (command?.type === 'admin-create-session') {
    return 'a new session'
  }
  if (command?.type === 'admin-await-sessions') {
    return 'yourself'
  }
  return `session ${command?.cardId}`
}

/**
 * 等一张不存在的卡 = 一直空等到超时，而模型完全不知道自己在空等（命令是单向
 * 投递的，渲染端没法把"这个 cardId 没有对应会话"回传）。镜像就在手边，所以这道
 * 校验放在投递之前，让模型当场看到自己写错了哪个 id。
 */
const validateAwaitTargets = async (command, context) => {
  const mirror = await context.fetchWorkspace()
  if (!mirror) {
    return textResult(
      'This workspace is not available right now (the desktop app may have closed it), so the wait was NOT registered. Try again shortly.',
      true,
    )
  }

  const knownIds = new Set(
    selectVisibleSessions(mirror, context.selfCardId)
      .map((session) => normalizeText(session?.cardId))
      .filter(Boolean),
  )

  const unknown = command.targetCardIds.filter((cardId) => !knownIds.has(cardId))
  if (unknown.length > 0) {
    return textResult(
      `No session exists in this workspace for cardId ${unknown.join(', ')}, so nothing was registered. Call ${listToolName} to get the current cardIds.`,
      true,
    )
  }

  if (command.targetCardIds.length === 0 && knownIds.size === 0) {
    return textResult(
      `This workspace has no other session to wait for, so nothing would ever wake you up and nothing was registered. Use ${createToolName} to dispatch work first.`,
      true,
    )
  }

  return null
}

// 写工具返回的是"命令已投递"，不是"已生效"——与手机监工同语义：真正执行
// 的是渲染进程里的电脑端 handler，本进程无从得知结果，只能让模型再查一次。
const deliveredText = (action, command, selfArchive = false) => {
  // 自我归档是第二条"投递成功之后该闭嘴"的命令：移到 done 会中断的正是调用者
  // 自己这一回合，那次"再查一遍确认"根本等不到结果。
  if (selfArchive) {
    return `${action} was delivered to the desktop app: your own card is being moved to done, which interrupts this turn. END YOUR TURN NOW — say what you delivered and stop. Do not call any more tools; you cannot observe your own archival from inside the turn it ends.`
  }

  // 等待是唯一一条"投递成功之后该闭嘴"的命令：再多说一句都会推进本回合，
  // 而模型必须结束回合才能被重新唤起。所以这条文案不引导它再查一次。
  if (command?.type === 'admin-await-sessions') {
    const scope = command.targetCardIds.length > 0
      ? `${command.targetCardIds.length} session(s)`
      : 'every other session in this workspace'
    return `${action} was delivered to the desktop app: you will be woken with your note once ${scope} finish, and in any case no later than ${command.timeoutMinutes} minutes from now. END YOUR TURN NOW — say what you are waiting for and stop. Do not keep calling tools; you cannot observe the finish from inside this turn, and staying awake only burns the context you will need when you wake up. On waking, call ${listToolName} first to see what actually happened.`
  }

  return `${action} for ${describeCommandTarget(command)} was delivered to the desktop app. Delivery is not confirmation that it took effect — call ${listToolName} again to verify the workspace state.`
}

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

  if (
    name === createToolName
    || name === moveToolName
    || name === sendToolName
    || name === wakeToolName
    || name === awaitToolName
  ) {
    const resolved = resolveWorkspaceAdminCommandFromToolCall(
      name,
      args,
      context.columnId,
      context.selfCardId,
    )
    if (resolved.error) {
      return textResult(resolved.error, true)
    }

    if (resolved.command.type === 'admin-await-sessions') {
      const rejection = await validateAwaitTargets(resolved.command, context)
      if (rejection) {
        return rejection
      }
    }

    const outcome = await context.postCommand(resolved.command)
    if (!outcome?.accepted) {
      const target = resolved.selfArchive ? 'yourself' : describeCommandTarget(resolved.command)
      return textResult(
        `${name} for ${target} could NOT be delivered: ${outcome?.reason || 'the desktop app did not accept the command'}. Nothing changed; try again shortly.`,
        true,
      )
    }

    return textResult(deliveredText(name, resolved.command, resolved.selfArchive === true))
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
