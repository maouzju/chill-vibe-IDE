import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  boardMcpToolDefinitions,
  buildBoardItemTranscriptText,
  buildBoardItemsText,
  callAutomationBoardTool,
  resolveBoardCommandFromToolCall,
} from '../server/automation-board-mcp.js'
import {
  createAutomationBoardBridge,
  type AutomationBoardTranscriptEntry,
} from '../server/automation-board-bridge.ts'
import {
  automationBoardMcpBoardIdEnvKey,
  automationBoardMcpServerName,
  automationBoardMcpTokenEnvKey,
  automationBoardMcpUrlEnvKey,
  buildAutomationBoardClaudeMcpConfig,
  buildAutomationBoardCodexRuntimeArgs,
  getAutomationBoardSupervisorInstruction,
} from '../server/automation-board-runtime.ts'
import {
  automationBoardCommandSchema,
  automationBoardMirrorSchema,
  type AutomationBoardCommand,
  type AutomationBoardMirror,
} from '../shared/schema.ts'

const lastActivityAt = '2026-08-11T02:00:00.000Z'
const nowMs = Date.parse(lastActivityAt) + 42 * 60_000

const buildMirror = (overrides?: Partial<AutomationBoardMirror>): AutomationBoardMirror =>
  automationBoardMirrorSchema.parse({
    boardCardId: 'board-1',
    columnId: 'col-1',
    workspacePath: 'D:\\Git\\chill-vibe',
    generatedAt: '2026-08-11T02:42:00.000Z',
    supervisorCardId: 'supervisor-1',
    supervisorStatus: 'idle',
    items: [
      {
        cardId: 'item-running',
        lane: 'running',
        requirement: '把登录页的错误提示改成中文',
        title: '登录页',
        provider: 'codex',
        model: 'gpt-5.4',
        status: 'streaming',
        startedAt: '2026-08-11T01:30:00.000Z',
        lastActivityAt,
        lastMessagePreview: '正在读 login.ts…',
        messageCount: 12,
      },
      {
        cardId: 'item-standby',
        lane: 'standby',
        requirement: '给设置页补一个主题切换',
        status: 'idle',
      },
    ],
    ...overrides,
  })

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

test('board MCP exposes exactly the five board-domain tools with closed input schemas', () => {
  assert.deepEqual(
    boardMcpToolDefinitions.map((tool) => tool.name),
    [
      'list_board_items',
      'read_board_item',
      'move_board_item',
      'send_board_item_message',
      'set_board_item_wake_timer',
    ],
  )

  for (const tool of boardMcpToolDefinitions) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must close its schema`)
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`)
  }

  const listTool = boardMcpToolDefinitions[0]
  assert.equal(listTool?.inputSchema.required, undefined, 'list_board_items takes no required args')
  assert.deepEqual(listTool?.inputSchema.properties, {})

  const nudgeTool = boardMcpToolDefinitions.find((tool) => tool.name === 'send_board_item_message')
  assert.match(nudgeTool?.description ?? '', /鞭策/, 'the nudge tool must name the 鞭策 semantics')
  const moveTool = boardMcpToolDefinitions.find((tool) => tool.name === 'move_board_item')
  assert.match(moveTool?.description ?? '', /running/, 'move must explain that running starts execution')
  assert.match(moveTool?.description ?? '', /interrupt/i, 'move must explain that standby/done interrupts')
})

// ---------------------------------------------------------------------------
// resolveBoardCommandFromToolCall
// ---------------------------------------------------------------------------

test('resolveBoardCommandFromToolCall builds schema-valid commands for each write tool', () => {
  const move = resolveBoardCommandFromToolCall('move_board_item', { cardId: 'item-running', lane: 'done' }, 'board-1')
  assert.deepEqual(move.command, {
    type: 'board-move-item',
    boardCardId: 'board-1',
    cardId: 'item-running',
    lane: 'done',
  })

  const nudge = resolveBoardCommandFromToolCall(
    'send_board_item_message',
    { cardId: 'item-running', message: '半小时没动静了，接着做' },
    'board-1',
  )
  assert.deepEqual(nudge.command, {
    type: 'board-send-item-message',
    boardCardId: 'board-1',
    cardId: 'item-running',
    message: '半小时没动静了，接着做',
  })

  const wake = resolveBoardCommandFromToolCall(
    'set_board_item_wake_timer',
    { cardId: 'item-running', mode: 'duration', durationMinutes: 15 },
    'board-1',
  )
  assert.deepEqual(wake.command, {
    type: 'board-set-item-wake-timer',
    boardCardId: 'board-1',
    cardId: 'item-running',
    mode: 'duration',
    durationMinutes: 15,
  })

  // The whole point of the resolver is that the renderer receives a command the
  // shared schema accepts; a drifted literal must fail here, not at runtime.
  for (const resolution of [move, nudge, wake]) {
    const parsed = automationBoardCommandSchema.safeParse(resolution.command)
    assert.equal(parsed.success, true, `command must satisfy the shared schema: ${JSON.stringify(resolution)}`)
  }
})

test('resolveBoardCommandFromToolCall defaults the duration mode and omits it for the waiting modes', () => {
  const defaulted = resolveBoardCommandFromToolCall(
    'set_board_item_wake_timer',
    { cardId: 'item-running', mode: 'duration' },
    'board-1',
  )
  assert.equal(defaulted.command?.type, 'board-set-item-wake-timer')
  assert.deepEqual(defaulted.command, {
    type: 'board-set-item-wake-timer',
    boardCardId: 'board-1',
    cardId: 'item-running',
    mode: 'duration',
    durationMinutes: 30,
  })

  const waiting = resolveBoardCommandFromToolCall(
    'set_board_item_wake_timer',
    { cardId: 'item-running', mode: 'left-tab' },
    'board-1',
  )
  assert.deepEqual(waiting.command, {
    type: 'board-set-item-wake-timer',
    boardCardId: 'board-1',
    cardId: 'item-running',
    mode: 'left-tab',
  })
  assert.equal(automationBoardCommandSchema.safeParse(waiting.command).success, true)
})

test('resolveBoardCommandFromToolCall rejects bad arguments instead of forwarding them', () => {
  const noCardId = resolveBoardCommandFromToolCall('move_board_item', { lane: 'done' }, 'board-1')
  assert.equal(noCardId.command, undefined)
  assert.match(noCardId.error ?? '', /cardId/)

  const badLane = resolveBoardCommandFromToolCall(
    'move_board_item',
    { cardId: 'item-running', lane: 'finished' },
    'board-1',
  )
  assert.equal(badLane.command, undefined)
  assert.match(badLane.error ?? '', /standby, running, done/)

  const emptyMessage = resolveBoardCommandFromToolCall(
    'send_board_item_message',
    { cardId: 'item-running', message: '   ' },
    'board-1',
  )
  assert.equal(emptyMessage.command, undefined)
  assert.match(emptyMessage.error ?? '', /message/)

  const badMode = resolveBoardCommandFromToolCall(
    'set_board_item_wake_timer',
    { cardId: 'item-running', mode: 'someday' },
    'board-1',
  )
  assert.equal(badMode.command, undefined)
  assert.match(badMode.error ?? '', /mode must be one of/)

  // Out-of-range durations must not be silently clamped into a different ask.
  const badDuration = resolveBoardCommandFromToolCall(
    'set_board_item_wake_timer',
    { cardId: 'item-running', mode: 'duration', durationMinutes: 0 },
    'board-1',
  )
  assert.equal(badDuration.command, undefined)
  assert.match(badDuration.error ?? '', /durationMinutes/)

  const unknownTool = resolveBoardCommandFromToolCall('delete_board_item', { cardId: 'item-running' }, 'board-1')
  assert.equal(unknownTool.command, undefined)
  assert.match(unknownTool.error ?? '', /Unknown automation board write tool/)

  const noBoard = resolveBoardCommandFromToolCall('move_board_item', { cardId: 'item-running', lane: 'done' }, '')
  assert.equal(noBoard.command, undefined)
  assert.match(noBoard.error ?? '', /not attached to an automation board/)
})

// ---------------------------------------------------------------------------
// Snapshot → text rendering
// ---------------------------------------------------------------------------

test('buildBoardItemsText renders the original requirement, the lane and a silence duration', () => {
  const text = buildBoardItemsText(buildMirror(), nowMs)

  assert.match(text, /item-running/)
  assert.match(text, /Lane: running/)
  assert.match(text, /把登录页的错误提示改成中文/, 'the ORIGINAL requirement must be visible')
  assert.match(text, /Lane: standby/)
  assert.match(text, /给设置页补一个主题切换/)
  // 监工的核心判据："超过半小时没下文" —— 分钟数必须来自注入的 nowMs。
  assert.match(text, /silent for 42 minutes/)
  assert.match(text, /Started at: 2026-08-11T01:30:00\.000Z/)
  assert.match(text, /Last message: 正在读 login\.ts…/)
  assert.match(text, /standby 1, running 1, done 0/)

  // Same mirror, later clock ⇒ larger silence. Nothing may be read from the
  // wall clock inside the pure function.
  const later = buildBoardItemsText(buildMirror(), nowMs + 18 * 60_000)
  assert.match(later, /silent for 60 minutes/)
})

test('buildBoardItemsText survives a missing lastActivityAt and an empty board', () => {
  const text = buildBoardItemsText(buildMirror(), nowMs)
  assert.match(text, /no activity recorded yet \(silence unknown\)/)

  const empty = buildBoardItemsText(buildMirror({ items: [] }), nowMs)
  assert.match(empty, /board-1/)
  assert.match(empty, /no requirements yet/)
  assert.doesNotMatch(empty, /silent for/)

  assert.match(buildBoardItemsText(null, nowMs), /no requirements yet/)
})

test('buildBoardItemTranscriptText renders each entry and the empty case', () => {
  const entries: AutomationBoardTranscriptEntry[] = [
    { id: 'm-1', role: 'user', content: '把登录页的错误提示改成中文', createdAt: '2026-08-11T01:30:00.000Z' },
    { id: 'm-2', role: 'assistant', content: '读取 login.ts', kind: 'tool', createdAt: '2026-08-11T01:31:00.000Z' },
  ]

  const text = buildBoardItemTranscriptText('item-running', entries)
  assert.match(text, /item-running/)
  assert.match(text, /\[1\] user at 2026-08-11T01:30:00\.000Z/)
  assert.match(text, /\[2\] assistant \(tool\) at 2026-08-11T01:31:00\.000Z/)
  assert.match(text, /把登录页的错误提示改成中文/)
  assert.match(text, /读取 login\.ts/)

  assert.match(buildBoardItemTranscriptText('item-standby', []), /no transcript entries yet/)
})

// ---------------------------------------------------------------------------
// callAutomationBoardTool with injected IO
// ---------------------------------------------------------------------------

type ToolHarness = {
  context: Parameters<typeof callAutomationBoardTool>[2]
  posted: AutomationBoardCommand[]
  itemRequests: Array<{ cardId: string; limit: number }>
}

const createToolHarness = (options?: {
  mirror?: AutomationBoardMirror | null
  entries?: AutomationBoardTranscriptEntry[] | null
  delivery?: { accepted: boolean; reason?: string }
}): ToolHarness => {
  const posted: AutomationBoardCommand[] = []
  const itemRequests: Array<{ cardId: string; limit: number }> = []

  return {
    posted,
    itemRequests,
    context: {
      boardCardId: 'board-1',
      nowMs,
      fetchBoard: async () => (options?.mirror === undefined ? buildMirror() : options.mirror),
      fetchItem: async (cardId, limit) => {
        itemRequests.push({ cardId, limit })
        return options?.entries === undefined ? [] : options.entries
      },
      postCommand: async (command) => {
        posted.push(command)
        return options?.delivery ?? { accepted: true }
      },
    },
  }
}

test('callAutomationBoardTool renders fetched board data for the read tools', async () => {
  const harness = createToolHarness({
    entries: [{ id: 'm-1', role: 'assistant', content: '已经改完并跑过测试', createdAt: lastActivityAt }],
  })

  const list = await callAutomationBoardTool('list_board_items', {}, harness.context)
  assert.equal(list.isError, false)
  assert.equal(list.content[0]?.type, 'text')
  assert.match(list.content[0]?.text ?? '', /silent for 42 minutes/)
  assert.match(list.content[0]?.text ?? '', /把登录页的错误提示改成中文/)

  const read = await callAutomationBoardTool(
    'read_board_item',
    { cardId: 'item-running', limit: 999 },
    harness.context,
  )
  assert.equal(read.isError, false)
  assert.match(read.content[0]?.text ?? '', /已经改完并跑过测试/)
  // An unbounded transcript must never leave the app (pitfall 183).
  assert.deepEqual(harness.itemRequests, [{ cardId: 'item-running', limit: 60 }])
})

test('callAutomationBoardTool reports unavailable board and unknown item as errors', async () => {
  const noBoard = createToolHarness({ mirror: null })
  const listResult = await callAutomationBoardTool('list_board_items', {}, noBoard.context)
  assert.equal(listResult.isError, true)
  assert.match(listResult.content[0]?.text ?? '', /not available/i)

  const noItem = createToolHarness({ entries: null })
  const readResult = await callAutomationBoardTool('read_board_item', { cardId: 'ghost' }, noItem.context)
  assert.equal(readResult.isError, true)
  assert.match(readResult.content[0]?.text ?? '', /ghost/)

  const missingArg = createToolHarness()
  const noCardId = await callAutomationBoardTool('read_board_item', {}, missingArg.context)
  assert.equal(noCardId.isError, true)
  assert.equal(missingArg.itemRequests.length, 0)

  const unknown = await callAutomationBoardTool('rm_rf', {}, missingArg.context)
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0]?.text ?? '', /Unknown automation board tool/)
})

test('callAutomationBoardTool posts the resolved command and reports delivery, not effect', async () => {
  const harness = createToolHarness()

  const nudge = await callAutomationBoardTool(
    'send_board_item_message',
    { cardId: 'item-running', message: '继续，别停' },
    harness.context,
  )
  assert.equal(nudge.isError, false)
  assert.match(nudge.content[0]?.text ?? '', /delivered/i)
  assert.match(
    nudge.content[0]?.text ?? '',
    /list_board_items/,
    'delivery is not confirmation — the model must be told to re-check',
  )

  const move = await callAutomationBoardTool(
    'move_board_item',
    { cardId: 'item-running', lane: 'done' },
    harness.context,
  )
  assert.equal(move.isError, false)

  const wake = await callAutomationBoardTool(
    'set_board_item_wake_timer',
    { cardId: 'item-standby', mode: 'duration', durationMinutes: 45 },
    harness.context,
  )
  assert.equal(wake.isError, false)

  assert.deepEqual(harness.posted, [
    { type: 'board-send-item-message', boardCardId: 'board-1', cardId: 'item-running', message: '继续，别停' },
    { type: 'board-move-item', boardCardId: 'board-1', cardId: 'item-running', lane: 'done' },
    {
      type: 'board-set-item-wake-timer',
      boardCardId: 'board-1',
      cardId: 'item-standby',
      mode: 'duration',
      durationMinutes: 45,
    },
  ])
})

test('callAutomationBoardTool surfaces a rejected dispatch as an actionable error', async () => {
  const harness = createToolHarness({
    delivery: { accepted: false, reason: 'no desktop window is available to execute board commands' },
  })

  const result = await callAutomationBoardTool(
    'move_board_item',
    { cardId: 'item-running', lane: 'done' },
    harness.context,
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /could NOT be delivered/)
  assert.match(result.content[0]?.text ?? '', /no desktop window/)
  assert.match(result.content[0]?.text ?? '', /board is unchanged/)
  assert.equal(harness.posted.length, 1, 'the command was attempted exactly once')
})

test('callAutomationBoardTool rejects a bad write argument before touching the bridge', async () => {
  const harness = createToolHarness()
  const result = await callAutomationBoardTool(
    'move_board_item',
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
  boardCardId: 'board-1',
  scriptPath: windowsScriptPath,
  execPath: windowsExecPath,
  isElectron: true,
}

test('buildAutomationBoardCodexRuntimeArgs wires the MCP server, script and all three env keys', () => {
  const args = buildAutomationBoardCodexRuntimeArgs(launchInput)

  assert.ok(args.length % 2 === 0, 'runtime args must stay -c/value pairs')
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], '-c')
  }

  const values = args.filter((_, index) => index % 2 === 1)
  assert.ok(
    values.every((value) => value.startsWith(`mcp_servers.${automationBoardMcpServerName}.`)),
    'every override must target the board MCP server',
  )

  // TOML string values need doubled backslashes or the Windows path breaks.
  assert.ok(
    values.includes(
      `mcp_servers.${automationBoardMcpServerName}.command="C:\\\\Program Files\\\\Chill Vibe IDE\\\\Chill Vibe.exe"`,
    ),
    `command override missing/unescaped: ${values.join(' | ')}`,
  )
  assert.ok(
    values.includes(
      `mcp_servers.${automationBoardMcpServerName}.args=["D:\\\\Git\\\\chill-vibe\\\\server\\\\automation-board-mcp.js"]`,
    ),
    `args override missing/unescaped: ${values.join(' | ')}`,
  )

  assert.ok(values.includes(`mcp_servers.${automationBoardMcpServerName}.env.${automationBoardMcpUrlEnvKey}="http://127.0.0.1:54321"`))
  assert.ok(values.includes(`mcp_servers.${automationBoardMcpServerName}.env.${automationBoardMcpTokenEnvKey}="deadbeef"`))
  assert.ok(values.includes(`mcp_servers.${automationBoardMcpServerName}.env.${automationBoardMcpBoardIdEnvKey}="board-1"`))
  assert.ok(values.includes(`mcp_servers.${automationBoardMcpServerName}.env.ELECTRON_RUN_AS_NODE="1"`))
})

test('buildAutomationBoardCodexRuntimeArgs adds ELECTRON_RUN_AS_NODE only on the Electron host', () => {
  const plainNode = buildAutomationBoardCodexRuntimeArgs({ ...launchInput, isElectron: false })
  assert.ok(!plainNode.some((value) => value.includes('ELECTRON_RUN_AS_NODE')))
  // The three board env keys must still be there.
  for (const key of [
    automationBoardMcpUrlEnvKey,
    automationBoardMcpTokenEnvKey,
    automationBoardMcpBoardIdEnvKey,
  ]) {
    assert.ok(plainNode.some((value) => value.includes(`.env.${key}=`)), `${key} missing without Electron`)
  }
})

test('buildAutomationBoardClaudeMcpConfig nests the server under mcpServers with the same env', () => {
  const config = buildAutomationBoardClaudeMcpConfig(launchInput)

  assert.deepEqual(Object.keys(config.mcpServers), [automationBoardMcpServerName])
  const entry = config.mcpServers[automationBoardMcpServerName]
  assert.equal(entry?.command, windowsExecPath)
  assert.deepEqual(entry?.args, [windowsScriptPath])
  assert.deepEqual(entry?.env, {
    [automationBoardMcpUrlEnvKey]: 'http://127.0.0.1:54321',
    [automationBoardMcpTokenEnvKey]: 'deadbeef',
    [automationBoardMcpBoardIdEnvKey]: 'board-1',
    ELECTRON_RUN_AS_NODE: '1',
  })

  // The JSON is handed to `claude --mcp-config <json>`, so it must serialize.
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config)

  const plainNode = buildAutomationBoardClaudeMcpConfig({ ...launchInput, isElectron: false })
  assert.equal(
    'ELECTRON_RUN_AS_NODE' in (plainNode.mcpServers[automationBoardMcpServerName]?.env ?? {}),
    false,
  )
})

test('getAutomationBoardSupervisorInstruction names every tool in both languages', () => {
  const zh = getAutomationBoardSupervisorInstruction('zh-CN')
  const en = getAutomationBoardSupervisorInstruction('en')

  for (const text of [zh, en]) {
    for (const tool of boardMcpToolDefinitions) {
      assert.match(text, new RegExp(tool.name), `instruction must mention ${tool.name}`)
    }
  }

  assert.match(zh, /鞭策/)
  assert.match(en, /鞭策/, 'the English text still has to define what 鞭策 maps to')
  assert.match(zh, /set_board_item_wake_timer/)
  assert.notEqual(zh, en)
})

// ---------------------------------------------------------------------------
// Loopback bridge
// ---------------------------------------------------------------------------

type BridgeHarness = {
  bridge: ReturnType<typeof createAutomationBoardBridge>
  dispatched: AutomationBoardCommand[]
  transcriptRequests: Array<{ cardId: string; limit: number }>
}

const createBridgeHarness = (options?: { dispatchResult?: boolean }): BridgeHarness => {
  const dispatched: AutomationBoardCommand[] = []
  const transcriptRequests: Array<{ cardId: string; limit: number }> = []

  const bridge = createAutomationBoardBridge({
    readBoardMirror: (boardCardId) => (boardCardId === 'board-1' ? buildMirror() : null),
    readItemTranscript: async (cardId, limit) => {
      transcriptRequests.push({ cardId, limit })
      return cardId === 'item-running'
        ? [{ id: 'm-1', role: 'assistant', content: '干完了', createdAt: lastActivityAt }]
        : null
    },
    dispatchCommand: (command) => {
      dispatched.push(command)
      return options?.dispatchResult ?? true
    },
  })

  return { bridge, dispatched, transcriptRequests }
}

test('automation board bridge requires a bearer token on every route', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()

  try {
    const noToken = await fetch(`${info.url}/board?boardCardId=board-1`)
    assert.equal(noToken.status, 401)

    const wrongToken = await fetch(`${info.url}/board?boardCardId=board-1`, {
      headers: { Authorization: 'Bearer 00000000000000000000000000000000' },
    })
    assert.equal(wrongToken.status, 401)

    const rawQueryToken = await fetch(`${info.url}/board?boardCardId=board-1&token=${info.token}`)
    assert.equal(rawQueryToken.status, 401, 'a query-string token must not be accepted')

    const unauthenticatedWrite = await fetch(`${info.url}/command`, {
      method: 'POST',
      body: JSON.stringify({ type: 'board-move-item', boardCardId: 'board-1', cardId: 'item-running', lane: 'done' }),
    })
    assert.equal(unauthenticatedWrite.status, 401)
    assert.equal(harness.dispatched.length, 0)
  } finally {
    await harness.bridge.stop()
  }
})

test('automation board bridge serves the live mirror and 404s an unknown board', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()
  const auth = { Authorization: `Bearer ${info.token}` }

  try {
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'the bridge must only advertise loopback')

    const ok = await fetch(`${info.url}/board?boardCardId=board-1`, { headers: auth })
    assert.equal(ok.status, 200)
    const payload = (await ok.json()) as { mirror: AutomationBoardMirror }
    assert.equal(payload.mirror.boardCardId, 'board-1')
    assert.equal(payload.mirror.items.length, 2)
    assert.equal(payload.mirror.items[0]?.requirement, '把登录页的错误提示改成中文')

    const unknown = await fetch(`${info.url}/board?boardCardId=nope`, { headers: auth })
    assert.equal(unknown.status, 404)

    const missingParam = await fetch(`${info.url}/board`, { headers: auth })
    assert.equal(missingParam.status, 400)

    const wrongRoute = await fetch(`${info.url}/whatever`, { headers: auth })
    assert.equal(wrongRoute.status, 404)
  } finally {
    await harness.bridge.stop()
  }
})

test('automation board bridge serves an item transcript with a clamped limit', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()
  const auth = { Authorization: `Bearer ${info.token}` }

  try {
    const ok = await fetch(`${info.url}/item?cardId=item-running&limit=999`, { headers: auth })
    assert.equal(ok.status, 200)
    const payload = (await ok.json()) as { entries: AutomationBoardTranscriptEntry[] }
    assert.equal(payload.entries.length, 1)
    assert.equal(payload.entries[0]?.content, '干完了')

    const defaulted = await fetch(`${info.url}/item?cardId=item-running`, { headers: auth })
    assert.equal(defaulted.status, 200)

    const floored = await fetch(`${info.url}/item?cardId=item-running&limit=-4`, { headers: auth })
    assert.equal(floored.status, 200)

    assert.deepEqual(harness.transcriptRequests, [
      { cardId: 'item-running', limit: 60 },
      { cardId: 'item-running', limit: 20 },
      { cardId: 'item-running', limit: 1 },
    ])

    const missing = await fetch(`${info.url}/item?cardId=ghost`, { headers: auth })
    assert.equal(missing.status, 404)

    const noCardId = await fetch(`${info.url}/item`, { headers: auth })
    assert.equal(noCardId.status, 400)
  } finally {
    await harness.bridge.stop()
  }
})

test('automation board bridge validates and forwards write commands', async () => {
  const harness = createBridgeHarness()
  const info = await harness.bridge.start()
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' }

  try {
    const command = {
      type: 'board-send-item-message',
      boardCardId: 'board-1',
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
      body: JSON.stringify({ type: 'board-move-item', boardCardId: 'board-1', cardId: 'x', lane: 'archived' }),
    })
    assert.equal(malformed.status, 400)

    const notJson = await fetch(`${info.url}/command`, { method: 'POST', headers, body: 'not json' })
    assert.equal(notJson.status, 400)

    const wrongMethod = await fetch(`${info.url}/command`, { headers })
    assert.equal(wrongMethod.status, 405)

    // Read routes stay read-only.
    const postRead = await fetch(`${info.url}/board?boardCardId=board-1`, { method: 'POST', headers })
    assert.equal(postRead.status, 405)

    assert.equal(harness.dispatched.length, 1, 'only the valid command may reach the renderer')
  } finally {
    await harness.bridge.stop()
  }
})

test('automation board bridge answers 503 when no renderer can execute the command', async () => {
  const harness = createBridgeHarness({ dispatchResult: false })
  const info = await harness.bridge.start()

  try {
    const response = await fetch(`${info.url}/command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'board-move-item',
        boardCardId: 'board-1',
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

test('automation board bridge rejects a non-loopback Host header', async () => {
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
          path: '/board?boardCardId=board-1',
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

test('automation board bridge start is idempotent and stop releases the port', async () => {
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
    fetch(`${first.url}/board?boardCardId=board-1`, { headers: { Authorization: `Bearer ${first.token}` } }),
  )
})
