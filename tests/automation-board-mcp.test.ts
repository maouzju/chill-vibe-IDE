import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

test('workspace admin MCP exposes exactly the seven session tools with closed input schemas', () => {
  assert.deepEqual(
    workspaceAdminMcpToolDefinitions.map((tool) => tool.name),
    [
      'list_sessions',
      'read_session',
      'create_session',
      'move_session_to_lane',
      'send_session_message',
      'set_session_wake_timer',
      'wake_me_when_sessions_finish',
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
  // 自己的 cardId 永远不在 list_sessions 里，所以"归档我自己"只能靠省略 cardId，
  // 而模型只会从工具描述里知道这条路存在。
  assert.deepEqual(moveTool?.inputSchema.required, ['lane'])
  assert.match(moveTool?.description ?? '', /omit cardId/i)
  assert.match(moveTool?.description ?? '', /yourself/i)

  // create_session 是唯一一个目标卡还不存在的工具：requirement 必填，cardId 不该出现。
  const createTool = workspaceAdminMcpToolDefinitions.find((tool) => tool.name === 'create_session')
  assert.deepEqual(createTool?.inputSchema.required, ['requirement'])
  assert.deepEqual(
    Object.keys(createTool?.inputSchema.properties ?? {}).sort(),
    ['lane', 'model', 'provider', 'requirement'],
  )
  const createProps = (createTool?.inputSchema.properties ?? {}) as Record<
    string,
    { enum?: string[] } | undefined
  >
  // 新建即完成没有语义，done 不能出现在可选泳道里（AC4）。
  assert.deepEqual(createProps.lane?.enum, ['standby', 'running'])
  // 超管权限不可自我传染：这个工具绝不能让模型给新卡开 adminAccess（AC13）。
  assert.equal(createProps.adminAccess, undefined)
  // 空工作区正是它存在的理由，模型必须被告知没有看板时会落成普通 tab（AC10/AC14）。
  assert.match(createTool?.description ?? '', /tab/i)
  assert.match(createTool?.description ?? '', /running/)

  // 等待工具作用于**调用者自己**：唤醒时发给自己的 note 必填，cardId 绝不能出现在参数里
  // （谁被唤醒由 SELF_CARD_ID 决定，不给模型冒充别人的机会，AC8）。
  const awaitTool = workspaceAdminMcpToolDefinitions.find(
    (tool) => tool.name === 'wake_me_when_sessions_finish',
  )
  assert.deepEqual(awaitTool?.inputSchema.required, ['note'])
  assert.deepEqual(
    Object.keys(awaitTool?.inputSchema.properties ?? {}).sort(),
    ['cardIds', 'note', 'timeoutMinutes'],
  )
  // 兜底超时不是可选的设计冗余：被打断 / 报错 / 从没开跑的目标永远不发完成广播（AC4）。
  assert.match(awaitTool?.description ?? '', /timeoutMinutes/)
  // 模型必须被告知"注册完就结束本回合"，否则它仍会原地轮询 list_sessions。
  assert.match(awaitTool?.description ?? '', /end your turn|finish your turn/i)
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

test('resolveWorkspaceAdminCommandFromToolCall lets the caller archive itself by omitting cardId', () => {
  // 超管自己被 SELF_CARD_ID 过滤出 list_sessions，所以它手里永远没有自己的
  // cardId —— 不给一条免 cardId 的自移路径，它就永远无法把自己归档。
  const self = resolveWorkspaceAdminCommandFromToolCall(
    'move_session_to_lane',
    { lane: 'done' },
    'col-1',
    'self-card',
  )
  assert.deepEqual(self.command, {
    type: 'admin-move-session-to-lane',
    columnId: 'col-1',
    cardId: 'self-card',
    lane: 'done',
  })
  assert.equal(workspaceAdminCommandSchema.safeParse(self.command).success, true)

  // 自移只开放 done：自移 running 会给自己重发需求形成自我重入，自移 standby
  // 则是把自己停在一条没人会来启动的道上。两者都不是"归档"，宁可报错。
  for (const lane of ['running', 'standby']) {
    const rejected = resolveWorkspaceAdminCommandFromToolCall(
      'move_session_to_lane',
      { lane },
      'col-1',
      'self-card',
    )
    assert.equal(rejected.command, undefined, `self-move to ${lane} must not be forwarded`)
    assert.match(rejected.error ?? '', /done/)
  }

  // 拿不到自己是谁时不能猜：没有 SELF_CARD_ID 仍旧退回"cardId 必填"。
  const unknownSelf = resolveWorkspaceAdminCommandFromToolCall(
    'move_session_to_lane',
    { lane: 'done' },
    'col-1',
    '',
  )
  assert.equal(unknownSelf.command, undefined)
  assert.match(unknownSelf.error ?? '', /cardId/)
})

test('callWorkspaceAdminTool archives the caller and tells it to stop talking', async () => {
  const harness = createToolHarness()
  const result = await callWorkspaceAdminTool('move_session_to_lane', { lane: 'done' }, harness.context)

  assert.equal(result.isError, false)
  assert.deepEqual(harness.posted, [
    {
      type: 'admin-move-session-to-lane',
      columnId: 'col-1',
      cardId: 'self-card',
      lane: 'done',
    },
  ])
  // 把自己移到 done 会中断自己这一回合，所以这条文案绝不能像别的写工具那样
  // 引导模型"再调一次 list_sessions 确认" —— 那次调用根本等不到结果。
  assert.match(result.content[0]?.text ?? '', /END YOUR TURN|end your turn/i)
  assert.doesNotMatch(result.content[0]?.text ?? '', /call list_sessions again to verify/i)
})

test('resolveWorkspaceAdminCommandFromToolCall builds a schema-valid create command without a cardId', () => {
  const full = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    {
      requirement: '把首页的加载动画换成骨架屏',
      lane: 'standby',
      provider: 'claude',
      model: 'claude-sonnet-5',
    },
    'col-1',
  )
  assert.deepEqual(full.command, {
    type: 'admin-create-session',
    columnId: 'col-1',
    requirement: '把首页的加载动画换成骨架屏',
    lane: 'standby',
    provider: 'claude',
    model: 'claude-sonnet-5',
  })

  // 省略 lane 就是"建了就开跑"：超管建卡的意图默认是派活，不是排队。
  const defaulted = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    { requirement: '跑一遍回归' },
    'col-1',
  )
  assert.deepEqual(defaulted.command, {
    type: 'admin-create-session',
    columnId: 'col-1',
    requirement: '跑一遍回归',
    lane: 'running',
  })

  for (const resolution of [full, defaulted]) {
    const parsed = workspaceAdminCommandSchema.safeParse(resolution.command)
    assert.equal(
      parsed.success,
      true,
      `create command must satisfy the shared schema: ${JSON.stringify(resolution)}`,
    )
  }
})

test('resolveWorkspaceAdminCommandFromToolCall rejects bad create arguments', () => {
  // 这条是本次改动最容易踩空的一处：create 是唯一没有 cardId 的写工具，
  // 统一的 "cardId is required" 前置校验必须给它让路，否则它永远建不成卡。
  const missingRequirement = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    { lane: 'running' },
    'col-1',
  )
  assert.equal(missingRequirement.command, undefined)
  assert.match(missingRequirement.error ?? '', /requirement/)
  assert.doesNotMatch(missingRequirement.error ?? '', /cardId/)

  const blankRequirement = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    { requirement: '   ' },
    'col-1',
  )
  assert.equal(blankRequirement.command, undefined)
  assert.match(blankRequirement.error ?? '', /requirement/)

  // done 必须报错而不是被静默降级：模型看不到 UI，静默纠正会让它带着错误的
  // 世界模型继续决策。
  const doneLane = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    { requirement: '随便做点什么', lane: 'done' },
    'col-1',
  )
  assert.equal(doneLane.command, undefined)
  assert.match(doneLane.error ?? '', /standby, running/)

  const badProvider = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    { requirement: '随便做点什么', provider: 'gemini' },
    'col-1',
  )
  assert.equal(badProvider.command, undefined)
  assert.match(badProvider.error ?? '', /provider/)

  const noColumn = resolveWorkspaceAdminCommandFromToolCall(
    'create_session',
    { requirement: '随便做点什么' },
    '',
  )
  assert.equal(noColumn.command, undefined)
  assert.match(noColumn.error ?? '', /no workspace admin access/)
})

test('resolveWorkspaceAdminCommandFromToolCall points the await command at the caller itself', () => {
  const full = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    {
      cardIds: ['item-running', 'item-standby'],
      note: '三张卡都跑完了，逐个 read_session 验收，通过就 move 到 done',
      timeoutMinutes: 90,
    },
    'col-1',
    'self-card',
  )
  assert.deepEqual(full.command, {
    type: 'admin-await-sessions',
    columnId: 'col-1',
    cardId: 'self-card',
    targetCardIds: ['item-running', 'item-standby'],
    note: '三张卡都跑完了，逐个 read_session 验收，通过就 move 到 done',
    timeoutMinutes: 90,
  })

  // 省略 cardIds = 等本工作区当前所有其它 agent 会话。空数组交给渲染端解析：
  // 哪些卡算"其它 agent"是 state 的事实，模型手里的镜像随时可能过期。
  const defaulted = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    { note: '回来收活' },
    'col-1',
    'self-card',
  )
  assert.deepEqual(defaulted.command, {
    type: 'admin-await-sessions',
    columnId: 'col-1',
    cardId: 'self-card',
    targetCardIds: [],
    note: '回来收活',
    timeoutMinutes: 60,
  })

  for (const resolution of [full, defaulted]) {
    const parsed = workspaceAdminCommandSchema.safeParse(resolution.command)
    assert.equal(
      parsed.success,
      true,
      `await command must satisfy the shared schema: ${JSON.stringify(resolution)}`,
    )
  }
})

test('resolveWorkspaceAdminCommandFromToolCall rejects bad await arguments', () => {
  // 与 create 同一个坑（pitfall 294）：这条命令的目标是调用者自己，参数里没有
  // cardId，所以公共的 "cardId is required" 前置校验必须给它让路。只断言"报错了"
  // 挡不住这个 bug —— 它确实会报错，只是报错的理由是错的。
  const missingNote = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    { cardIds: ['item-running'] },
    'col-1',
    'self-card',
  )
  assert.equal(missingNote.command, undefined)
  assert.match(missingNote.error ?? '', /note/)
  assert.doesNotMatch(missingNote.error ?? '', /cardId is required/)

  const blankNote = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    { note: '   ' },
    'col-1',
    'self-card',
  )
  assert.equal(blankNote.command, undefined)
  assert.match(blankNote.error ?? '', /note/)

  const badTimeout = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    { note: '回来收活', timeoutMinutes: 0 },
    'col-1',
    'self-card',
  )
  assert.equal(badTimeout.command, undefined)
  assert.match(badTimeout.error ?? '', /timeoutMinutes/)

  const blankTarget = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    { note: '回来收活', cardIds: ['item-running', '  '] },
    'col-1',
    'self-card',
  )
  assert.equal(blankTarget.command, undefined)
  assert.match(blankTarget.error ?? '', /cardIds/)

  // 拿不到自己的 cardId 就无从知道该叫醒谁。静默换成"叫醒别人"是最坏的降级，
  // 所以这里必须失败而不是回退。
  const noSelf = resolveWorkspaceAdminCommandFromToolCall(
    'wake_me_when_sessions_finish',
    { note: '回来收活' },
    'col-1',
    '',
  )
  assert.equal(noSelf.command, undefined)
  assert.match(noSelf.error ?? '', /which session to wake/i)
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

test('callWorkspaceAdminTool posts a create command and still reports delivery, not effect', async () => {
  const harness = createToolHarness()

  const created = await callWorkspaceAdminTool(
    'create_session',
    { requirement: '接着把设置页做完', provider: 'claude', model: 'claude-sonnet-5' },
    harness.context,
  )

  assert.equal(created.isError, false)
  assert.match(created.content[0]?.text ?? '', /delivered/i)
  assert.match(
    created.content[0]?.text ?? '',
    /list_sessions/,
    'the new session only shows up in the mirror, so the model must re-check',
  )
  assert.deepEqual(harness.posted, [
    {
      type: 'admin-create-session',
      columnId: 'col-1',
      requirement: '接着把设置页做完',
      lane: 'running',
      provider: 'claude',
      model: 'claude-sonnet-5',
    },
  ])
})

test('callWorkspaceAdminTool posts an await command aimed at the caller itself', async () => {
  const harness = createToolHarness()

  const armed = await callWorkspaceAdminTool(
    'wake_me_when_sessions_finish',
    { cardIds: ['item-running'], note: '醒来先 read_session 验收 item-running' },
    harness.context,
  )

  assert.equal(armed.isError, false)
  assert.match(armed.content[0]?.text ?? '', /delivered/i)
  assert.deepEqual(harness.posted, [
    {
      type: 'admin-await-sessions',
      columnId: 'col-1',
      cardId: 'self-card',
      targetCardIds: ['item-running'],
      note: '醒来先 read_session 验收 item-running',
      timeoutMinutes: 60,
    },
  ])
})

test('callWorkspaceAdminTool refuses to wait on a cardId that is not in this workspace', async () => {
  const harness = createToolHarness()

  const result = await callWorkspaceAdminTool(
    'wake_me_when_sessions_finish',
    { cardIds: ['item-running', 'ghost-card'], note: '回来收活' },
    harness.context,
  )

  // 等一张不存在的卡 = 等到超时为止，而模型完全不知道自己在空等。镜像就在手边，
  // 这个错误必须当场报出来。
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /ghost-card/)
  assert.deepEqual(harness.posted, [])
})

test('callWorkspaceAdminTool refuses to wait when the workspace has no other session', async () => {
  const harness = createToolHarness({ mirror: buildMirror({ sessions: [] }) })

  const result = await callWorkspaceAdminTool(
    'wake_me_when_sessions_finish',
    { note: '回来收活' },
    harness.context,
  )

  // 没有可等的会话时注册等待只会等到超时，同样必须当场报错而不是静默投递。
  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /no other session/i)
  assert.deepEqual(harness.posted, [])
})

test('callWorkspaceAdminTool rejects a bad create argument before touching the bridge', async () => {
  const harness = createToolHarness()
  const result = await callWorkspaceAdminTool('create_session', { requirement: '  ' }, harness.context)

  assert.equal(result.isError, true)
  assert.equal(harness.posted.length, 0)
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

  // 「你不在 list_sessions 里」这句话必须紧跟着自我归档的出口，否则模型只学到
  // 「我找不到自己」，然后回头找用户手动把自己那张卡拖进已完成。
  assert.match(zh, /不填 cardId/)
  assert.match(zh, /归档/)
  assert.match(en, /no cardId/i)
  assert.match(en, /archive your own card/i)
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

// MCP 的 stdio 绑定是**换行分隔**的 JSON-RPC（规范原文："the stdio binding is
// just newline-delimited JSON-RPC over a byte stream"），不是 LSP 的
// Content-Length 分帧。这条用例走真子进程握手，因为帧格式错的表现是"服务端
// 一个字节都不回"—— 任何只 import 纯函数的单测都看不见它。
test(
  'the stdio server speaks newline-delimited JSON-RPC so real MCP clients can connect',
  { timeout: 20_000 },
  async () => {
    const scriptPath = fileURLToPath(new URL('../server/automation-board-mcp.js', import.meta.url))
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [workspaceAdminMcpUrlEnvKey]: 'http://127.0.0.1:1',
        [workspaceAdminMcpTokenEnvKey]: 'token',
        [workspaceAdminMcpColumnIdEnvKey]: 'col-1',
        [workspaceAdminMcpSelfCardIdEnvKey]: 'self-card',
      },
    })

    try {
      const lines: string[] = []
      let pending = ''
      let resolveTwoLines = () => {}
      const twoLines = new Promise<void>((resolve) => {
        resolveTwoLines = resolve
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part)
          }
        }
        if (lines.length >= 2) {
          resolveTwoLines()
        }
      })

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'chill-vibe-test', version: '1.0.0' },
          },
        })}\n`,
      )
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)

      // 缺陷形态是"永不响应"，所以红阶段必须自己超时报错而不是挂死（pitfall 271/273）。
      await Promise.race([
        twoLines,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`stdio server never answered; raw stdout so far: ${JSON.stringify(pending)}`)),
            8_000,
          ).unref()
        }),
      ])

      const initialize = JSON.parse(lines[0]) as {
        id: number
        result?: { serverInfo?: { name?: string } }
      }
      assert.equal(initialize.id, 1)
      assert.equal(initialize.result?.serverInfo?.name, 'chill-vibe-workspace-admin')

      const toolsList = JSON.parse(lines[1]) as { id: number; result?: { tools?: { name: string }[] } }
      assert.equal(toolsList.id, 2)
      assert.deepEqual(
        (toolsList.result?.tools ?? []).map((tool) => tool.name).sort(),
        workspaceAdminMcpToolDefinitions.map((tool) => tool.name).sort(),
      )

      // 一个 Content-Length 头就足以让换行帧的客户端把整条流当垃圾丢掉。
      assert.ok(
        !lines.some((line) => line.includes('Content-Length')),
        'stdio frames must not carry LSP headers',
      )
    } finally {
      child.kill()
    }
  },
)

// create_session 的 lane 白名单在 automation-board-mcp.js 里是**抄写**的字面量
// （那个文件被当普通 Node 脚本 spawn，不能 import TS schema）。抄写漂移的表现是
// 命令在 bridge 的 zod 校验处被 400 掉，而只 import 纯函数的单测发现不了 ——
// 它断言的两边是同一份抄写。这条用例让真子进程生成的命令真的过一次共享 schema。
test(
  'create_session travels from a real stdio client through the bridge into a schema-valid command',
  { timeout: 20_000 },
  async () => {
    const harness = createBridgeHarness()
    const info = await harness.bridge.start()
    const scriptPath = fileURLToPath(new URL('../server/automation-board-mcp.js', import.meta.url))
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [workspaceAdminMcpUrlEnvKey]: info.url,
        [workspaceAdminMcpTokenEnvKey]: info.token,
        [workspaceAdminMcpColumnIdEnvKey]: 'col-1',
        [workspaceAdminMcpSelfCardIdEnvKey]: 'self-card',
      },
    })

    try {
      const lines: string[] = []
      let pending = ''
      let resolveAnswer = () => {}
      const answered = new Promise<void>((resolve) => {
        resolveAnswer = resolve
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part)
          }
        }
        if (lines.length >= 1) {
          resolveAnswer()
        }
      })

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'create_session',
            arguments: {
              requirement: '把设置页的保存按钮接上',
              lane: 'standby',
              provider: 'claude',
              model: 'claude-sonnet-5',
            },
          },
        })}\n`,
      )

      await Promise.race([
        answered,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`stdio server never answered; raw stdout so far: ${JSON.stringify(pending)}`)),
            8_000,
          ).unref()
        }),
      ])

      const call = JSON.parse(lines[0]) as {
        id: number
        result?: { isError?: boolean; content?: { text?: string }[] }
      }
      assert.equal(call.id, 7)
      assert.equal(call.result?.isError, false, `create_session must not error: ${lines[0]}`)
      assert.match(call.result?.content?.[0]?.text ?? '', /delivered/i)
      // cardId 还不存在，文案不能渲染成 "for session undefined"。
      assert.doesNotMatch(call.result?.content?.[0]?.text ?? '', /undefined/)

      assert.deepEqual(harness.dispatched, [
        {
          type: 'admin-create-session',
          columnId: 'col-1',
          requirement: '把设置页的保存按钮接上',
          lane: 'standby',
          provider: 'claude',
          model: 'claude-sonnet-5',
        },
      ])
    } finally {
      child.kill()
      await harness.bridge.stop()
    }
  },
)

// 与上面那条同理：`wake_me_when_sessions_finish` 的默认超时、参数名、命令 tag 在
// `automation-board-mcp.js` 里都是**抄写**的字面量（那个文件被当普通 Node 脚本
// spawn，不能 import TS schema），而只 import 纯函数的单测断言的两边是同一份抄写。
// 这条让真子进程生成的命令真的过一次共享 zod schema —— 漂移的表现是 bridge 400，
// 在业务上就是"超管说它登记了等待，其实一次都没登记"。
test(
  'wake_me_when_sessions_finish travels from a real stdio client through the bridge into a schema-valid command',
  { timeout: 20_000 },
  async () => {
    const harness = createBridgeHarness()
    const info = await harness.bridge.start()
    const scriptPath = fileURLToPath(new URL('../server/automation-board-mcp.js', import.meta.url))
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [workspaceAdminMcpUrlEnvKey]: info.url,
        [workspaceAdminMcpTokenEnvKey]: info.token,
        [workspaceAdminMcpColumnIdEnvKey]: 'col-1',
        [workspaceAdminMcpSelfCardIdEnvKey]: 'self-card',
      },
    })

    try {
      const lines: string[] = []
      let pending = ''
      let resolveAnswer = () => {}
      const answered = new Promise<void>((resolve) => {
        resolveAnswer = resolve
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part)
          }
        }
        if (lines.length >= 1) {
          resolveAnswer()
        }
      })

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: {
            name: 'wake_me_when_sessions_finish',
            arguments: {
              cardIds: ['item-running'],
              note: '醒来先 read_session 验收 item-running',
            },
          },
        })}\n`,
      )

      await Promise.race([
        answered,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`stdio server never answered; raw stdout so far: ${JSON.stringify(pending)}`)),
            8_000,
          ).unref()
        }),
      ])

      const call = JSON.parse(lines[0]) as {
        id: number
        result?: { isError?: boolean; content?: { text?: string }[] }
      }
      assert.equal(call.id, 9)
      assert.equal(call.result?.isError, false, `await tool must not error: ${lines[0]}`)
      // 唤醒的是自己，文案不能渲染成 "for session undefined"。
      assert.doesNotMatch(call.result?.content?.[0]?.text ?? '', /undefined/)
      // 投递成功之后该闭嘴：模型必须结束回合才可能被重新唤起。
      assert.match(call.result?.content?.[0]?.text ?? '', /END YOUR TURN/i)

      assert.deepEqual(harness.dispatched, [
        {
          type: 'admin-await-sessions',
          columnId: 'col-1',
          cardId: 'self-card',
          targetCardIds: ['item-running'],
          note: '醒来先 read_session 验收 item-running',
          timeoutMinutes: 60,
        },
      ])
    } finally {
      child.kill()
      await harness.bridge.stop()
    }
  },
)

// 自我归档整条链只有在**真子进程**里才是完整的：目标 cardId 来自 SELF_CARD_ID 这个
// 环境变量，而只 import 纯函数的单测是自己把 selfCardId 当参数传进去的 —— 那种断言
// 证明不了 env 真的被读到。业务上的失败形态就是用户报的那句"拿不到自己的 cardId"。
test(
  'move_session_to_lane with no cardId archives the caller through a real stdio client',
  { timeout: 20_000 },
  async () => {
    const harness = createBridgeHarness()
    const info = await harness.bridge.start()
    const scriptPath = fileURLToPath(new URL('../server/automation-board-mcp.js', import.meta.url))
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [workspaceAdminMcpUrlEnvKey]: info.url,
        [workspaceAdminMcpTokenEnvKey]: info.token,
        [workspaceAdminMcpColumnIdEnvKey]: 'col-1',
        [workspaceAdminMcpSelfCardIdEnvKey]: 'self-card',
      },
    })

    try {
      const lines: string[] = []
      let pending = ''
      let resolveAnswer = () => {}
      const answered = new Promise<void>((resolve) => {
        resolveAnswer = resolve
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        const parts = pending.split('\n')
        pending = parts.pop() ?? ''
        for (const part of parts) {
          if (part.trim()) {
            lines.push(part)
          }
        }
        if (lines.length >= 1) {
          resolveAnswer()
        }
      })

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'move_session_to_lane', arguments: { lane: 'done' } },
        })}\n`,
      )

      await Promise.race([
        answered,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`stdio server never answered; raw stdout so far: ${JSON.stringify(pending)}`)),
            8_000,
          ).unref()
        }),
      ])

      const call = JSON.parse(lines[0]) as {
        id: number
        result?: { isError?: boolean; content?: { text?: string }[] }
      }
      assert.equal(call.id, 11)
      assert.equal(call.result?.isError, false, `self archive must not error: ${lines[0]}`)
      // 目标是自己，文案不能渲染成 "for session undefined"。
      assert.doesNotMatch(call.result?.content?.[0]?.text ?? '', /undefined/)
      assert.match(call.result?.content?.[0]?.text ?? '', /END YOUR TURN/i)

      assert.deepEqual(harness.dispatched, [
        {
          type: 'admin-move-session-to-lane',
          columnId: 'col-1',
          cardId: 'self-card',
          lane: 'done',
        },
      ])
    } finally {
      child.kill()
      await harness.bridge.stop()
    }
  },
)
