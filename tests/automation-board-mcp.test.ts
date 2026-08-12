import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  buildSessionTranscriptText,
  buildWorkspaceSessionsText,
  callWorkspaceAdminTool,
  resolveWorkspaceAdminCommandFromToolCall,
  workspaceAdminMcpToolDefinitions,
} from '../server/automation-board-mcp.js'
import {
  createWorkspaceAdminBridge,
  type WorkspaceAdminTranscriptEntry,
} from '../server/automation-board-bridge.ts'
import {
  buildWorkspaceAdminClaudeMcpConfig,
  buildWorkspaceAdminCodexRuntimeArgs,
  getWorkspaceAdminInstruction,
  workspaceAdminMcpColumnIdEnvKey,
  workspaceAdminMcpSelfCardIdEnvKey,
  workspaceAdminMcpServerName,
  workspaceAdminMcpTokenEnvKey,
  workspaceAdminMcpUrlEnvKey,
} from '../server/automation-board-runtime.ts'
import { createWorkspaceAdminRuntime } from '../server/automation-board-session.ts'
import {
  workspaceAdminCommandSchema,
  workspaceSessionMirrorSchema,
  type ChatRequest,
  type WorkspaceAdminCommand,
  type WorkspaceSessionMirror,
} from '../shared/schema.ts'

const lastActivityAt = '2026-08-11T02:00:00.000Z'
const nowMs = Date.parse(lastActivityAt) + 42 * 60_000

const buildMirror = (overrides?: Partial<WorkspaceSessionMirror>): WorkspaceSessionMirror =>
  workspaceSessionMirrorSchema.parse({
    columnId: 'col-1',
    workspacePath: 'D:\\Git\\chill-vibe',
    generatedAt: '2026-08-11T02:42:00.000Z',
    boardCardIds: ['board-1'],
    sessions: [
      {
        cardId: 'item-running',
        title: '登录页',
        provider: 'codex',
        model: 'gpt-5.4',
        status: 'streaming',
        board: {
          boardCardId: 'board-1',
          lane: 'running',
          requirement: '把登录页的错误提示改成中文',
          startedAt: '2026-08-11T01:30:00.000Z',
        },
        lastActivityAt,
        lastMessagePreview: '正在读 login.ts…',
        messageCount: 12,
      },
      {
        cardId: 'item-standby',
        title: '设置页',
        status: 'idle',
        board: {
          boardCardId: 'board-1',
          lane: 'standby',
          requirement: '给设置页补一个主题切换',
        },
      },
      {
        // 普通 tab 会话：v2 的作用域从"某一张看板"扩到"整个工作区列"。
        cardId: 'tab-chat',
        title: '随手聊',
        provider: 'claude',
        model: 'claude-opus-5',
        status: 'idle',
        isTab: true,
      },
      {
        // 请求方自己：必须被 SELF_CARD_ID 过滤掉。
        cardId: 'self-card',
        title: '监工',
        status: 'streaming',
        isTab: true,
      },
    ],
    ...overrides,
  })

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

test('workspace admin MCP exposes exactly the five session tools with closed input schemas', () => {
  assert.deepEqual(
    workspaceAdminMcpToolDefinitions.map((tool) => tool.name),
    [
      'list_sessions',
      'read_session',
      'move_session_to_lane',
      'send_session_message',
      'set_session_wake_timer',
    ],
  )

  for (const tool of workspaceAdminMcpToolDefinitions) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must close its schema`)
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`)
  }

  const listTool = workspaceAdminMcpToolDefinitions[0]
  assert.equal(listTool?.inputSchema.required, undefined, 'list_sessions takes no required args')
  assert.deepEqual(listTool?.inputSchema.properties, {})

  const nudgeTool = workspaceAdminMcpToolDefinitions.find(
    (tool) => tool.name === 'send_session_message',
  )
  assert.match(nudgeTool?.description ?? '', /鞭策/, 'the nudge tool must name the 鞭策 semantics')

  const moveTool = workspaceAdminMcpToolDefinitions.find(
    (tool) => tool.name === 'move_session_to_lane',
  )
  assert.match(moveTool?.description ?? '', /running/, 'move must explain that running starts execution')
  assert.match(moveTool?.description ?? '', /interrupt/i, 'move must explain that standby/done interrupts')
  // 目标看板由渲染端解析，模型必须被告知这条规则，否则它会以为自己能选看板。
  assert.match(moveTool?.description ?? '', /already on a board/i)
  assert.match(moveTool?.description ?? '', /first board card/i)
  assert.match(moveTool?.description ?? '', /fails/i)
})

// ---------------------------------------------------------------------------
// resolveWorkspaceAdminCommandFromToolCall
// ---------------------------------------------------------------------------

test('resolveWorkspaceAdminCommandFromToolCall builds schema-valid commands for each write tool', () => {
  const move = resolveWorkspaceAdminCommandFromToolCall(
    'move_session_to_lane',
    { cardId: 'item-running', lane: 'done' },
    'col-1',
  )
  assert.deepEqual(move.command, {
    type: 'admin-move-session-to-lane',
    columnId: 'col-1',
    cardId: 'item-running',
    lane: 'done',
  })

  const nudge = resolveWorkspaceAdminCommandFromToolCall(
    'send_session_message',
    { cardId: 'item-running', message: '半小时没动静了，接着做' },
    'col-1',
  )
  assert.deepEqual(nudge.command, {
    type: 'admin-send-session-message',
    columnId: 'col-1',
    cardId: 'item-running',
    message: '半小时没动静了，接着做',
  })

  const wake = resolveWorkspaceAdminCommandFromToolCall(
    'set_session_wake_timer',
    { cardId: 'item-running', mode: 'duration', durationMinutes: 15 },
    'col-1',
  )
  assert.deepEqual(wake.command, {
    type: 'admin-set-session-wake-timer',
    columnId: 'col-1',
    cardId: 'item-running',
    mode: 'duration',
    durationMinutes: 15,
  })

  // The whole point of the resolver is that the renderer receives a command the
  // shared schema accepts; a drifted literal must fail here, not at runtime.
  for (const resolution of [move, nudge, wake]) {
    const parsed = workspaceAdminCommandSchema.safeParse(resolution.command)
    assert.equal(parsed.success, true, `command must satisfy the shared schema: ${JSON.stringify(resolution)}`)
  }
})

test('resolveWorkspaceAdminCommandFromToolCall defaults the duration mode and omits it for the waiting modes', () => {
  const defaulted = resolveWorkspaceAdminCommandFromToolCall(
    'set_session_wake_timer',
    { cardId: 'item-running', mode: 'duration' },
    'col-1',
  )
  assert.deepEqual(defaulted.command, {
    type: 'admin-set-session-wake-timer',
    columnId: 'col-1',
    cardId: 'item-running',
    mode: 'duration',
    durationMinutes: 30,
  })

  const waiting = resolveWorkspaceAdminCommandFromToolCall(
    'set_session_wake_timer',
    { cardId: 'item-running', mode: 'left-tab' },
    'col-1',
  )
  assert.deepEqual(waiting.command, {
    type: 'admin-set-session-wake-timer',
    columnId: 'col-1',
    cardId: 'item-running',
    mode: 'left-tab',
  })
  assert.equal(workspaceAdminCommandSchema.safeParse(waiting.command).success, true)
})

test('resolveWorkspaceAdminCommandFromToolCall rejects bad arguments instead of forwarding them', () => {
  const noCardId = resolveWorkspaceAdminCommandFromToolCall('move_session_to_lane', { lane: 'done' }, 'col-1')
  assert.equal(noCardId.command, undefined)
  assert.match(noCardId.error ?? '', /cardId/)

  const badLane = resolveWorkspaceAdminCommandFromToolCall(
    'move_session_to_lane',
    { cardId: 'item-running', lane: 'finished' },
    'col-1',
  )
  assert.equal(badLane.command, undefined)
  assert.match(badLane.error ?? '', /standby, running, done/)

  const emptyMessage = resolveWorkspaceAdminCommandFromToolCall(
    'send_session_message',
    { cardId: 'item-running', message: '   ' },
    'col-1',
  )
  assert.equal(emptyMessage.command, undefined)
  assert.match(emptyMessage.error ?? '', /message/)

  const badMode = resolveWorkspaceAdminCommandFromToolCall(
    'set_session_wake_timer',
    { cardId: 'item-running', mode: 'someday' },
    'col-1',
  )
  assert.equal(badMode.command, undefined)
  assert.match(badMode.error ?? '', /mode must be one of/)

  // Out-of-range durations must not be silently clamped into a different ask.
  const badDuration = resolveWorkspaceAdminCommandFromToolCall(
    'set_session_wake_timer',
    { cardId: 'item-running', mode: 'duration', durationMinutes: 0 },
    'col-1',
  )
  assert.equal(badDuration.command, undefined)
  assert.match(badDuration.error ?? '', /durationMinutes/)

  const unknownTool = resolveWorkspaceAdminCommandFromToolCall(
    'delete_session',
    { cardId: 'item-running' },
    'col-1',
  )
  assert.equal(unknownTool.command, undefined)
  assert.match(unknownTool.error ?? '', /Unknown workspace admin write tool/)

  // 没有 columnId = 这个会话根本没被授予超管权限：写工具整组不可用。
  const noColumn = resolveWorkspaceAdminCommandFromToolCall(
    'move_session_to_lane',
    { cardId: 'item-running', lane: 'done' },
    '',
  )
  assert.equal(noColumn.command, undefined)
  assert.match(noColumn.error ?? '', /no workspace admin access/)
})

// ---------------------------------------------------------------------------
// Snapshot → text rendering
// ---------------------------------------------------------------------------

test('buildWorkspaceSessionsText renders board membership, tab sessions and a silence duration', () => {
  const text = buildWorkspaceSessionsText(buildMirror(), nowMs, 'self-card')

  assert.match(text, /item-running/)
  assert.match(text, /lane running/)
  assert.match(text, /把登录页的错误提示改成中文/, 'the ORIGINAL requirement must be visible')
  assert.match(text, /lane standby/)
  assert.match(text, /给设置页补一个主题切换/)
  // 普通 tab 会话也在作用域内，并且要能被一眼分辨出来。
  assert.match(text, /tab-chat/)
  assert.match(text, /standalone tab session/)
  // 请求方自己绝不出现，否则模型会给自己发鞭策。
  assert.doesNotMatch(text, /self-card/)

  assert.match(text, /silent for 42 minutes/)
  assert.match(text, /Started at: 2026-08-11T01:30:00\.000Z/)
  assert.match(text, /Last message: 正在读 login\.ts…/)
  assert.match(text, /board standby 1, board running 1, board done 0, standalone tabs 1/)
  // 换道的目标看板由应用解析，清单里要给出本列有哪些看板。
  assert.match(text, /board-1/)

  // Same mirror, later clock ⇒ larger silence. Nothing may be read from the
  // wall clock inside the pure function.
  const later = buildWorkspaceSessionsText(buildMirror(), nowMs + 18 * 60_000, 'self-card')
  assert.match(later, /silent for 60 minutes/)
})

test('buildWorkspaceSessionsText survives a missing lastActivityAt, an empty workspace and no board', () => {
  const text = buildWorkspaceSessionsText(buildMirror(), nowMs, 'self-card')
  assert.match(text, /no activity recorded yet \(silence unknown\)/)

  const empty = buildWorkspaceSessionsText(buildMirror({ sessions: [] }), nowMs, 'self-card')
  assert.match(empty, /col-1/)
  assert.match(empty, /no other sessions/)
  assert.doesNotMatch(empty, /silent for/)

  const boardless = buildWorkspaceSessionsText(buildMirror({ boardCardIds: [] }), nowMs, 'self-card')
  assert.match(boardless, /no automation board card/)

  assert.match(buildWorkspaceSessionsText(null, nowMs, 'self-card'), /no other sessions/)
})

test('buildSessionTranscriptText renders each entry and the empty case', () => {
  const entries: WorkspaceAdminTranscriptEntry[] = [
    { id: 'm-1', role: 'user', content: '把登录页的错误提示改成中文', createdAt: '2026-08-11T01:30:00.000Z' },
    { id: 'm-2', role: 'assistant', content: '读取 login.ts', kind: 'tool', createdAt: '2026-08-11T01:31:00.000Z' },
  ]

  const text = buildSessionTranscriptText('item-running', entries)
  assert.match(text, /item-running/)
  assert.match(text, /\[1\] user at 2026-08-11T01:30:00\.000Z/)
  assert.match(text, /\[2\] assistant \(tool\) at 2026-08-11T01:31:00\.000Z/)
  assert.match(text, /把登录页的错误提示改成中文/)
  assert.match(text, /读取 login\.ts/)

  assert.match(buildSessionTranscriptText('item-standby', []), /no transcript entries yet/)
})

// ---------------------------------------------------------------------------
// callWorkspaceAdminTool with injected IO
// ---------------------------------------------------------------------------

type ToolHarness = {
  context: Parameters<typeof callWorkspaceAdminTool>[2]
  posted: WorkspaceAdminCommand[]
  sessionRequests: Array<{ cardId: string; limit: number }>
}

const createToolHarness = (options?: {
  mirror?: WorkspaceSessionMirror | null
  entries?: WorkspaceAdminTranscriptEntry[] | null
  delivery?: { accepted: boolean; reason?: string }
}): ToolHarness => {
  const posted: WorkspaceAdminCommand[] = []
  const sessionRequests: Array<{ cardId: string; limit: number }> = []

  return {
    posted,
    sessionRequests,
    context: {
      columnId: 'col-1',
      selfCardId: 'self-card',
      nowMs,
      fetchWorkspace: async () => (options?.mirror === undefined ? buildMirror() : options.mirror),
      fetchSession: async (cardId, limit) => {
        sessionRequests.push({ cardId, limit })
        return options?.entries === undefined ? [] : options.entries
      },
      postCommand: async (command) => {
        posted.push(command)
        return options?.delivery ?? { accepted: true }
      },
    },
  }
}

test('callWorkspaceAdminTool renders fetched workspace data for the read tools', async () => {
  const harness = createToolHarness({
    entries: [{ id: 'm-1', role: 'assistant', content: '已经改完并跑过测试', createdAt: lastActivityAt }],
  })

  const list = await callWorkspaceAdminTool('list_sessions', {}, harness.context)
  assert.equal(list.isError, false)
  assert.equal(list.content[0]?.type, 'text')
  assert.match(list.content[0]?.text ?? '', /silent for 42 minutes/)
  assert.match(list.content[0]?.text ?? '', /把登录页的错误提示改成中文/)
  assert.doesNotMatch(list.content[0]?.text ?? '', /self-card/)

  const read = await callWorkspaceAdminTool(
    'read_session',
    { cardId: 'item-running', limit: 999 },
    harness.context,
  )
  assert.equal(read.isError, false)
  assert.match(read.content[0]?.text ?? '', /已经改完并跑过测试/)
  // An unbounded transcript must never leave the app (pitfall 183).
  assert.deepEqual(harness.sessionRequests, [{ cardId: 'item-running', limit: 60 }])
})

test('callWorkspaceAdminTool reports an unavailable workspace and unknown session as errors', async () => {
  const noMirror = createToolHarness({ mirror: null })
  const listResult = await callWorkspaceAdminTool('list_sessions', {}, noMirror.context)
  assert.equal(listResult.isError, true)
  assert.match(listResult.content[0]?.text ?? '', /not available/i)

  const noSession = createToolHarness({ entries: null })
  const readResult = await callWorkspaceAdminTool('read_session', { cardId: 'ghost' }, noSession.context)
  assert.equal(readResult.isError, true)
  assert.match(readResult.content[0]?.text ?? '', /ghost/)

  const missingArg = createToolHarness()
  const noCardId = await callWorkspaceAdminTool('read_session', {}, missingArg.context)
  assert.equal(noCardId.isError, true)
  assert.equal(missingArg.sessionRequests.length, 0)

  const unknown = await callWorkspaceAdminTool('rm_rf', {}, missingArg.context)
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0]?.text ?? '', /Unknown workspace admin tool/)
})

test('callWorkspaceAdminTool posts the resolved command and reports delivery, not effect', async () => {
  const harness = createToolHarness()

  const nudge = await callWorkspaceAdminTool(
    'send_session_message',
    { cardId: 'item-running', message: '继续，别停' },
    harness.context,
  )
  assert.equal(nudge.isError, false)
  assert.match(nudge.content[0]?.text ?? '', /delivered/i)
  assert.match(
    nudge.content[0]?.text ?? '',
    /list_sessions/,
    'delivery is not confirmation — the model must be told to re-check',
  )

  const move = await callWorkspaceAdminTool(
    'move_session_to_lane',
    { cardId: 'item-running', lane: 'done' },
    harness.context,
  )
  assert.equal(move.isError, false)

  const wake = await callWorkspaceAdminTool(
    'set_session_wake_timer',
    { cardId: 'item-standby', mode: 'duration', durationMinutes: 45 },
    harness.context,
  )
  assert.equal(wake.isError, false)

  assert.deepEqual(harness.posted, [
    { type: 'admin-send-session-message', columnId: 'col-1', cardId: 'item-running', message: '继续，别停' },
    { type: 'admin-move-session-to-lane', columnId: 'col-1', cardId: 'item-running', lane: 'done' },
    {
      type: 'admin-set-session-wake-timer',
      columnId: 'col-1',
      cardId: 'item-standby',
      mode: 'duration',
      durationMinutes: 45,
    },
  ])
})

test('callWorkspaceAdminTool surfaces a rejected dispatch as an actionable error', async () => {
  const harness = createToolHarness({
    delivery: { accepted: false, reason: 'no desktop window is available to execute workspace admin commands' },
  })

  const result = await callWorkspaceAdminTool(
    'move_session_to_lane',
    { cardId: 'item-running', lane: 'done' },
    harness.context,
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /could NOT be delivered/)
  assert.match(result.content[0]?.text ?? '', /no desktop window/)
  assert.match(result.content[0]?.text ?? '', /Nothing changed/)
  assert.equal(harness.posted.length, 1, 'the command was attempted exactly once')
})

test('callWorkspaceAdminTool rejects a bad write argument before touching the bridge', async () => {
  const harness = createToolHarness()
  const result = await callWorkspaceAdminTool(
    'move_session_to_lane',
    { cardId: 'item-running', lane: 'archived' },
    harness.context,
  )

  assert.equal(result.isError, true)
  assert.equal(harness.posted.length, 0)
})

// ---------------------------------------------------------------------------
// Provider launch overrides
// ---------------------------------------------------------------------------

// Literal Windows strings, not path.join: posix `path` treats `D:/…` as
// relative, so building the expectation would diverge on Ubuntu CI (pitfall 94A).
const windowsScriptPath = 'D:\\Git\\chill-vibe\\server\\automation-board-mcp.js'
const windowsExecPath = 'C:\\Program Files\\Chill Vibe IDE\\Chill Vibe.exe'

const launchInput = {
  url: 'http://127.0.0.1:54321',
  token: 'deadbeef',
  columnId: 'col-1',
  selfCardId: 'self-card',
  scriptPath: windowsScriptPath,
  execPath: windowsExecPath,
  isElectron: true,
}

test('buildWorkspaceAdminCodexRuntimeArgs wires the MCP server, script and all four env keys', () => {
  const args = buildWorkspaceAdminCodexRuntimeArgs(launchInput)

  assert.ok(args.length % 2 === 0, 'runtime args must stay -c/value pairs')
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], '-c')
  }

  const values = args.filter((_, index) => index % 2 === 1)
  assert.ok(
    values.every((value) => value.startsWith(`mcp_servers.${workspaceAdminMcpServerName}.`)),
    'every override must target the workspace admin MCP server',
  )

  // TOML string values need doubled backslashes or the Windows path breaks.
  assert.ok(
    values.includes(
      `mcp_servers.${workspaceAdminMcpServerName}.command="C:\\\\Program Files\\\\Chill Vibe IDE\\\\Chill Vibe.exe"`,
    ),
    `command override missing/unescaped: ${values.join(' | ')}`,
  )
  assert.ok(
    values.includes(
      `mcp_servers.${workspaceAdminMcpServerName}.args=["D:\\\\Git\\\\chill-vibe\\\\server\\\\automation-board-mcp.js"]`,
    ),
    `args override missing/unescaped: ${values.join(' | ')}`,
  )

  assert.ok(values.includes(`mcp_servers.${workspaceAdminMcpServerName}.env.${workspaceAdminMcpUrlEnvKey}="http://127.0.0.1:54321"`))
  assert.ok(values.includes(`mcp_servers.${workspaceAdminMcpServerName}.env.${workspaceAdminMcpTokenEnvKey}="deadbeef"`))
  assert.ok(values.includes(`mcp_servers.${workspaceAdminMcpServerName}.env.${workspaceAdminMcpColumnIdEnvKey}="col-1"`))
  assert.ok(values.includes(`mcp_servers.${workspaceAdminMcpServerName}.env.${workspaceAdminMcpSelfCardIdEnvKey}="self-card"`))
  assert.ok(values.includes(`mcp_servers.${workspaceAdminMcpServerName}.env.ELECTRON_RUN_AS_NODE="1"`))
})

test('buildWorkspaceAdminCodexRuntimeArgs adds ELECTRON_RUN_AS_NODE only on the Electron host', () => {
  const plainNode = buildWorkspaceAdminCodexRuntimeArgs({ ...launchInput, isElectron: false })
  assert.ok(!plainNode.some((value) => value.includes('ELECTRON_RUN_AS_NODE')))
  // The four workspace env keys must still be there.
  for (const key of [
    workspaceAdminMcpUrlEnvKey,
    workspaceAdminMcpTokenEnvKey,
    workspaceAdminMcpColumnIdEnvKey,
    workspaceAdminMcpSelfCardIdEnvKey,
  ]) {
    assert.ok(plainNode.some((value) => value.includes(`.env.${key}=`)), `${key} missing without Electron`)
  }
})

test('buildWorkspaceAdminClaudeMcpConfig nests the server under mcpServers with the same env', () => {
  const config = buildWorkspaceAdminClaudeMcpConfig(launchInput)

  assert.deepEqual(Object.keys(config.mcpServers), [workspaceAdminMcpServerName])
  const entry = config.mcpServers[workspaceAdminMcpServerName]
  assert.equal(entry?.command, windowsExecPath)
  assert.deepEqual(entry?.args, [windowsScriptPath])
  assert.deepEqual(entry?.env, {
    [workspaceAdminMcpUrlEnvKey]: 'http://127.0.0.1:54321',
    [workspaceAdminMcpTokenEnvKey]: 'deadbeef',
    [workspaceAdminMcpColumnIdEnvKey]: 'col-1',
    [workspaceAdminMcpSelfCardIdEnvKey]: 'self-card',
    ELECTRON_RUN_AS_NODE: '1',
  })

  // The JSON is handed to `claude --mcp-config <json>`, so it must serialize.
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config)

  const plainNode = buildWorkspaceAdminClaudeMcpConfig({ ...launchInput, isElectron: false })
  assert.equal(
    'ELECTRON_RUN_AS_NODE' in (plainNode.mcpServers[workspaceAdminMcpServerName]?.env ?? {}),
    false,
  )
})

test('getWorkspaceAdminInstruction names every tool in both languages', () => {
  const zh = getWorkspaceAdminInstruction('zh-CN')
  const en = getWorkspaceAdminInstruction('en')

  for (const text of [zh, en]) {
    for (const tool of workspaceAdminMcpToolDefinitions) {
      assert.match(text, new RegExp(tool.name), `instruction must mention ${tool.name}`)
    }
  }

  assert.match(zh, /鞭策/)
  assert.match(en, /鞭策/, 'the English text still has to define what 鞭策 maps to')
  assert.match(zh, /set_session_wake_timer/)
  assert.notEqual(zh, en)
})

// ---------------------------------------------------------------------------
// Permission boundary
// ---------------------------------------------------------------------------

const baseChatRequest = {
  provider: 'claude',
  model: 'claude-opus-5',
  prompt: 'hello',
  language: 'zh-CN',
  attachments: [],
} as unknown as ChatRequest

test('createWorkspaceAdminRuntime refuses a turn without adminAccess', async () => {
  // 权限边界：没有 `card.adminAccess` 的回合永远拿不到工作区工具，也因此
  // 绝不会把懒启动的桥接监听端口拉起来。
  assert.equal(await createWorkspaceAdminRuntime(baseChatRequest), null)
  assert.equal(
    await createWorkspaceAdminRuntime({ ...baseChatRequest, adminAccess: undefined }),
    null,
  )
})

// ---------------------------------------------------------------------------
// Loopback bridge
// ---------------------------------------------------------------------------

type BridgeHarness = {
  bridge: ReturnType<typeof createWorkspaceAdminBridge>
  dispatched: WorkspaceAdminCommand[]
  transcriptRequests: Array<{ cardId: string; limit: number }>
}

const createBridgeHarness = (options?: {
  dispatchResult?: boolean
  dispatch?: (command: WorkspaceAdminCommand) => boolean | Promise<boolean>
}): BridgeHarness => {
  const dispatched: WorkspaceAdminCommand[] = []
  const transcriptRequests: Array<{ cardId: string; limit: number }> = []

  const bridge = createWorkspaceAdminBridge({
    readWorkspaceMirror: (columnId) => (columnId === 'col-1' ? buildMirror() : null),
    readSessionTranscript: async (cardId, limit) => {
      transcriptRequests.push({ cardId, limit })
      return cardId === 'item-running'
        ? [{ id: 'm-1', role: 'assistant', content: '干完了', createdAt: lastActivityAt }]
        : null
    },
    dispatchCommand: (command) => {
      dispatched.push(command)
      if (options?.dispatch) {
        return options.dispatch(command)
      }
      return options?.dispatchResult ?? true
    },
  })

  return { bridge, dispatched, transcriptRequests }
}

test('workspace admin bridge requires a bearer token on every route', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()

  try {
    const noToken = await fetch(`${info.url}/workspace?columnId=col-1`)
    assert.equal(noToken.status, 401)

    const wrongToken = await fetch(`${info.url}/workspace?columnId=col-1`, {
      headers: { Authorization: 'Bearer 00000000000000000000000000000000' },
    })
    assert.equal(wrongToken.status, 401)

    const rawQueryToken = await fetch(`${info.url}/workspace?columnId=col-1&token=${info.token}`)
    assert.equal(rawQueryToken.status, 401, 'a query-string token must not be accepted')

    const unauthenticatedWrite = await fetch(`${info.url}/command`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'admin-move-session-to-lane',
        columnId: 'col-1',
        cardId: 'item-running',
        lane: 'done',
      }),
    })
    assert.equal(unauthenticatedWrite.status, 401)
    assert.equal(harness.dispatched.length, 0)
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge serves the live mirror and 404s an unknown workspace', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()
  const auth = { Authorization: `Bearer ${info.token}` }

  try {
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'the bridge must only advertise loopback')

    const ok = await fetch(`${info.url}/workspace?columnId=col-1`, { headers: auth })
    assert.equal(ok.status, 200)
    const payload = (await ok.json()) as { mirror: WorkspaceSessionMirror }
    assert.equal(payload.mirror.columnId, 'col-1')
    assert.equal(payload.mirror.sessions.length, 4)
    assert.equal(payload.mirror.sessions[0]?.board?.requirement, '把登录页的错误提示改成中文')

    const unknown = await fetch(`${info.url}/workspace?columnId=nope`, { headers: auth })
    assert.equal(unknown.status, 404)

    const missingParam = await fetch(`${info.url}/workspace`, { headers: auth })
    assert.equal(missingParam.status, 400)

    const wrongRoute = await fetch(`${info.url}/whatever`, { headers: auth })
    assert.equal(wrongRoute.status, 404)
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge serves a session transcript with a clamped limit', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()
  const auth = { Authorization: `Bearer ${info.token}` }

  try {
    const ok = await fetch(`${info.url}/session?cardId=item-running&limit=999`, { headers: auth })
    assert.equal(ok.status, 200)
    const payload = (await ok.json()) as { entries: WorkspaceAdminTranscriptEntry[] }
    assert.equal(payload.entries.length, 1)
    assert.equal(payload.entries[0]?.content, '干完了')

    const defaulted = await fetch(`${info.url}/session?cardId=item-running`, { headers: auth })
    assert.equal(defaulted.status, 200)

    const floored = await fetch(`${info.url}/session?cardId=item-running&limit=-4`, { headers: auth })
    assert.equal(floored.status, 200)

    assert.deepEqual(harness.transcriptRequests, [
      { cardId: 'item-running', limit: 60 },
      { cardId: 'item-running', limit: 20 },
      { cardId: 'item-running', limit: 1 },
    ])

    const missing = await fetch(`${info.url}/session?cardId=ghost`, { headers: auth })
    assert.equal(missing.status, 404)

    const noCardId = await fetch(`${info.url}/session`, { headers: auth })
    assert.equal(noCardId.status, 400)
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge validates and forwards write commands', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }

  try {
    const command = {
      type: 'admin-send-session-message',
      columnId: 'col-1',
      cardId: 'item-running',
      message: '继续',
    }
    const accepted = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify(command),
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { accepted: true })
    assert.deepEqual(harness.dispatched, [command])

    const malformed = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'admin-move-session-to-lane',
        columnId: 'col-1',
        cardId: 'x',
        lane: 'archived',
      }),
    })
    assert.equal(malformed.status, 400)

    // v1 的命令形状必须被拒绝，否则旧渲染端能悄悄绕过新的作用域约束。
    const legacyShape = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'board-move-item',
        boardCardId: 'board-1',
        cardId: 'item-running',
        lane: 'done',
      }),
    })
    assert.equal(legacyShape.status, 400)

    const notJson = await fetch(`${info.url}/command`, { method: 'POST', headers, body: 'not json' })
    assert.equal(notJson.status, 400)

    const wrongMethod = await fetch(`${info.url}/command`, { headers })
    assert.equal(wrongMethod.status, 405)

    // Read routes stay read-only.
    const postRead = await fetch(`${info.url}/workspace?columnId=col-1`, { method: 'POST', headers })
    assert.equal(postRead.status, 405)

    assert.equal(harness.dispatched.length, 1, 'only the valid command may reach the renderer')
  } finally {
    await harness.bridge.stop()
  }
})

// 同 remote-monitor：后端一旦搬进 utilityProcess，"哪个窗口收下了" 只有主进程
// 知道，dispatchCommand 必然是跨进程的异步调用。202/503 语义必须原样保住，
// 且 dispatcher 抛错时超管的 MCP 子进程要拿到明确响应而不是挂在那儿。
test('workspace admin bridge awaits an async dispatcher before answering', async () => {
  const harness = createBridgeHarness({
    dispatch: async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return command.type !== 'admin-move-session-to-lane'
    },
  })
  const info = await harness.bridge.start()
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }

  try {
    const delivered = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'admin-send-session-message',
        columnId: 'col-1',
        cardId: 'item-running',
        message: '继续',
      }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(delivered.status, 200, 'a promise that resolves true must still be accepted')
    assert.deepEqual(await delivered.json(), { accepted: true })

    const undelivered = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'admin-move-session-to-lane',
        columnId: 'col-1',
        cardId: 'item-running',
        lane: 'done',
      }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(undelivered.status, 503, 'a promise that resolves false must still mean 503')
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge answers when the dispatcher rejects', async () => {
  const harness = createBridgeHarness({
    dispatch: async () => {
      throw new Error('the desktop bridge is gone')
    },
  })
  const info = await harness.bridge.start()

  try {
    const response = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'admin-move-session-to-lane',
        columnId: 'col-1',
        cardId: 'item-running',
        lane: 'done',
      }),
      signal: AbortSignal.timeout(5000),
    })

    assert.equal(response.status, 503, 'a failed dispatch is an undelivered command, not accepted')
    const payload = (await response.json()) as { message?: string; accepted?: boolean }
    assert.notEqual(payload.accepted, true)
    assert.equal(typeof payload.message, 'string')
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge answers 503 when no renderer can execute the command', async () => {
  const harness = createBridgeHarness({ dispatchResult: false })
  const info = await harness.bridge.start()

  try {
    const response = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'admin-move-session-to-lane',
        columnId: 'col-1',
        cardId: 'item-running',
        lane: 'done',
      }),
    })

    assert.equal(response.status, 503)
    assert.equal(harness.dispatched.length, 1)
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge rejects a non-loopback Host header', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()

  try {
    // fetch() will not let us forge Host, and the point of the guard is DNS
    // rebinding, so drive the socket directly.
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: info.port,
          path: '/workspace?columnId=col-1',
          method: 'GET',
          headers: { Host: 'board.evil.example', Authorization: `Bearer ${info.token}` },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        },
      )
      request.on('error', reject)
      request.end()
    })

    assert.equal(status, 403)
  } finally {
    await harness.bridge.stop()
  }
})

test('workspace admin bridge start is idempotent and stop releases the port', async () => {
  const harness = createBridgeHarness()
  const first = await harness.bridge.start()
  const second = await harness.bridge.start()

  assert.equal(first.port, second.port)
  assert.equal(first.token, second.token)
  assert.equal(harness.bridge.status().running, true)
  assert.equal(harness.bridge.status().port, first.port)

  await harness.bridge.stop()

  assert.equal(harness.bridge.status().running, false)
  assert.equal(harness.bridge.status().url, undefined)
  await assert.rejects(
    fetch(`${first.url}/workspace?columnId=col-1`, { headers: { Authorization: `Bearer ${first.token}` } }),
  )
})
