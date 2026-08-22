import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CLAUDE_MODEL,
  STICKYNOTE_TOOL_MODEL,
} from '../shared/models.ts'
import type { BoardColumn, ChatCard, ChatMessage, SessionHistoryEntry } from '../shared/schema.ts'
import {
  buildStatsHeatColumns,
  buildStatsMonthLabels,
  computeStatsMetrics,
  statsRangeDayCounts,
  statsWeekdayRows,
  toLocalDayKey,
} from '../src/stats-card-metrics.ts'

const localIso = (dayKey: string, hour = 12, minute = 0) => {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString()
}

const message = (overrides: Partial<ChatMessage> & { createdAt: string }): ChatMessage => ({
  id: overrides.id ?? `m-${overrides.createdAt}-${Math.round(Math.random() * 1e9)}`,
  role: overrides.role ?? 'assistant',
  content: overrides.content ?? 'hello',
  createdAt: overrides.createdAt,
  ...(overrides.meta ? { meta: overrides.meta } : {}),
})

const card = (overrides: Partial<ChatCard> = {}): ChatCard =>
  ({
    id: 'card-1',
    title: 'Chat',
    providerSessions: {},
    status: 'idle',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: 'medium',
    thinkingEnabled: true,
    planMode: false,
    autoUrgeActive: false,
    autoUrgeProfileId: 'auto-urge-default',
    collapsed: false,
    unread: false,
    draft: '',
    draftAttachments: [],
    queuedSends: [],
    stickyNote: '',
    brainstorm: {
      prompt: '',
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL,
      answerCount: 6,
      answers: [],
      failedAnswers: [],
    },
    messages: [],
    ...overrides,
  }) as ChatCard

const column = (cards: ChatCard[], overrides: Partial<BoardColumn> = {}): BoardColumn =>
  ({
    id: overrides.id ?? 'column-1',
    title: overrides.title ?? 'Workspace',
    provider: overrides.provider ?? 'codex',
    workspacePath: overrides.workspacePath ?? 'D:/repo/one',
    model: overrides.model ?? DEFAULT_CODEX_MODEL,
    layout: { type: 'pane', id: 'pane-1', tabs: cards.map((entry) => entry.id), activeTabId: cards[0]?.id ?? '' },
    cards: Object.fromEntries(cards.map((entry) => [entry.id, entry])),
    ...overrides,
  }) as BoardColumn

const historyEntry = (overrides: Partial<SessionHistoryEntry> & { archivedAt: string }): SessionHistoryEntry =>
  ({
    id: overrides.id ?? `history-${overrides.archivedAt}`,
    title: overrides.title ?? 'Archived chat',
    provider: overrides.provider ?? 'codex',
    model: overrides.model ?? DEFAULT_CODEX_MODEL,
    workspacePath: overrides.workspacePath ?? 'D:/repo/one',
    messages: overrides.messages ?? [],
    messageCount: overrides.messageCount,
    usageTotals: overrides.usageTotals,
    archivedAt: overrides.archivedAt,
  }) as SessionHistoryEntry

const now = new Date(2026, 7, 16, 15, 0, 0, 0) // 2026-08-16 local

const compute = (input: {
  columns?: BoardColumn[]
  sessionHistory?: SessionHistoryEntry[]
  rangeDays?: number
}) =>
  computeStatsMetrics({
    columns: input.columns ?? [],
    sessionHistory: input.sessionHistory ?? [],
    now,
    rangeDays: input.rangeDays ?? 90,
  })

test('empty board yields a fully zeroed but well-formed report', () => {
  const metrics = compute({})

  assert.equal(metrics.days.length, 90)
  assert.equal(metrics.days[metrics.days.length - 1].date, '2026-08-16')
  assert.equal(metrics.maxCount, 0)
  assert.equal(metrics.totalSessions, 0)
  assert.equal(metrics.totalMessages, 0)
  assert.equal(metrics.currentStreak, 0)
  assert.equal(metrics.longestStreak, 0)
  assert.equal(metrics.activeDays, 0)
  assert.equal(metrics.tokens, null)
  assert.ok(metrics.days.every((day) => day.count === 0 && day.level === 0))
})

test('day keys use local time so late-night work stays on the same day', () => {
  // 23:30 local on 2026-08-16 is already 2026-08-17 in UTC for CST(+8).
  assert.equal(toLocalDayKey(new Date(2026, 7, 16, 23, 30)), '2026-08-16')
  assert.equal(toLocalDayKey(new Date(2026, 7, 16, 0, 5)), '2026-08-16')
})

test('live card messages are bucketed by their own createdAt', () => {
  const metrics = compute({
    columns: [
      column([
        card({
          id: 'card-1',
          messages: [
            message({ createdAt: localIso('2026-08-16') }),
            message({ createdAt: localIso('2026-08-16', 9) }),
            message({ createdAt: localIso('2026-08-14') }),
          ],
        }),
      ]),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day.count]))
  assert.equal(byDay.get('2026-08-16'), 2)
  assert.equal(byDay.get('2026-08-15'), 0)
  assert.equal(byDay.get('2026-08-14'), 1)
  assert.equal(metrics.totalMessages, 3)
  assert.equal(metrics.activeSessions, 1)
  assert.equal(metrics.totalSessions, 1)
})

test('archived sessions contribute messageCount on their archivedAt day', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({ archivedAt: localIso('2026-08-10'), messageCount: 12 }),
      historyEntry({ id: 'h2', archivedAt: localIso('2026-08-10', 20), messageCount: 3 }),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day.count]))
  assert.equal(byDay.get('2026-08-10'), 15)
  assert.equal(metrics.archivedSessions, 2)
  assert.equal(metrics.totalMessages, 15)

  const sessionsOnDay = metrics.days.find((day) => day.date === '2026-08-10')?.sessions
  assert.equal(sessionsOnDay, 2)
})

test('archived sessions without messageCount fall back to their preview messages', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({
        archivedAt: localIso('2026-08-12'),
        messages: [message({ createdAt: localIso('2026-08-12') }), message({ createdAt: localIso('2026-08-12') })],
      }),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day.count]))
  assert.equal(byDay.get('2026-08-12'), 2)
})

test('tool cards are not counted as sessions and their messages are ignored', () => {
  const metrics = compute({
    columns: [
      column([
        card({ id: 'chat', messages: [message({ createdAt: localIso('2026-08-16') })] }),
        card({
          id: 'note',
          model: STICKYNOTE_TOOL_MODEL,
          messages: [message({ createdAt: localIso('2026-08-16') })],
        }),
      ]),
    ],
  })

  assert.equal(metrics.activeSessions, 1)
  assert.equal(metrics.totalMessages, 1)
})

test('provider breakdown counts live and archived sessions together', () => {
  const metrics = compute({
    columns: [
      column([
        card({ id: 'a', provider: 'codex' }),
        card({ id: 'b', provider: 'claude', model: DEFAULT_CLAUDE_MODEL }),
      ]),
    ],
    sessionHistory: [historyEntry({ archivedAt: localIso('2026-08-15'), provider: 'claude' })],
  })

  assert.deepEqual(metrics.byProvider, { codex: 1, claude: 2 })
})

test('recent windows count sessions, not messages', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({ id: 'h-today', archivedAt: localIso('2026-08-16'), messageCount: 40 }),
      historyEntry({ id: 'h-6d', archivedAt: localIso('2026-08-11'), messageCount: 1 }),
      historyEntry({ id: 'h-20d', archivedAt: localIso('2026-07-28'), messageCount: 1 }),
      historyEntry({ id: 'h-60d', archivedAt: localIso('2026-06-15'), messageCount: 1 }),
    ],
  })

  assert.equal(metrics.sessionsLast7, 2)
  assert.equal(metrics.sessionsLast30, 3)
  assert.equal(metrics.totalSessions, 4)
})

test('streaks measure consecutive active days ending today', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({ id: 'd0', archivedAt: localIso('2026-08-16'), messageCount: 1 }),
      historyEntry({ id: 'd1', archivedAt: localIso('2026-08-15'), messageCount: 1 }),
      historyEntry({ id: 'd2', archivedAt: localIso('2026-08-14'), messageCount: 1 }),
      // gap on 08-13
      historyEntry({ id: 'd4', archivedAt: localIso('2026-08-12'), messageCount: 1 }),
      historyEntry({ id: 'd5', archivedAt: localIso('2026-08-11'), messageCount: 1 }),
      historyEntry({ id: 'd6', archivedAt: localIso('2026-08-10'), messageCount: 1 }),
      historyEntry({ id: 'd7', archivedAt: localIso('2026-08-09'), messageCount: 1 }),
    ],
  })

  assert.equal(metrics.currentStreak, 3)
  assert.equal(metrics.longestStreak, 4)
  assert.equal(metrics.activeDays, 7)
})

test('a streak that ended yesterday is still reported as current', () => {
  // GitHub keeps yesterday-anchored streaks alive until the day is over.
  const metrics = compute({
    sessionHistory: [
      historyEntry({ id: 'y1', archivedAt: localIso('2026-08-15'), messageCount: 1 }),
      historyEntry({ id: 'y2', archivedAt: localIso('2026-08-14'), messageCount: 1 }),
    ],
  })

  assert.equal(metrics.currentStreak, 2)
})

test('a streak that ended two days ago is broken', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({ id: 'z1', archivedAt: localIso('2026-08-14'), messageCount: 1 }),
      historyEntry({ id: 'z2', archivedAt: localIso('2026-08-13'), messageCount: 1 }),
    ],
  })

  assert.equal(metrics.currentStreak, 0)
  assert.equal(metrics.longestStreak, 2)
})

test('heat levels are relative to the busiest day in range', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({ id: 'busy', archivedAt: localIso('2026-08-16'), messageCount: 100 }),
      historyEntry({ id: 'quiet', archivedAt: localIso('2026-08-15'), messageCount: 1 }),
      historyEntry({ id: 'mid', archivedAt: localIso('2026-08-14'), messageCount: 60 }),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day.level]))
  assert.equal(metrics.maxCount, 100)
  assert.equal(byDay.get('2026-08-16'), 4)
  assert.equal(byDay.get('2026-08-15'), 1)
  assert.equal(byDay.get('2026-08-14'), 3)
  assert.equal(byDay.get('2026-08-13'), 0)
})

test('activity outside the selected range is excluded from the calendar but not from totals', () => {
  const metrics = compute({
    rangeDays: 30,
    sessionHistory: [
      historyEntry({ id: 'inside', archivedAt: localIso('2026-08-16'), messageCount: 2 }),
      historyEntry({ id: 'outside', archivedAt: localIso('2026-01-01'), messageCount: 500 }),
    ],
  })

  assert.equal(metrics.days.length, 30)
  assert.equal(metrics.maxCount, 2)
  assert.equal(metrics.totalSessions, 2)
  assert.equal(metrics.totalMessages, 502)
  assert.ok(metrics.days.every((day) => day.date >= '2026-07-18'))
})

test('malformed timestamps are skipped instead of throwing', () => {
  const metrics = compute({
    columns: [
      column([
        card({
          id: 'card-1',
          messages: [
            message({ createdAt: 'not-a-date' }),
            message({ createdAt: '' }),
            message({ createdAt: localIso('2026-08-16') }),
          ],
        }),
      ]),
    ],
    sessionHistory: [
      historyEntry({ id: 'bad', archivedAt: 'garbage', messageCount: 9 }),
      historyEntry({ id: 'good', archivedAt: localIso('2026-08-16'), messageCount: 1 }),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day.count]))
  assert.equal(byDay.get('2026-08-16'), 2)
  // The malformed archived entry still counts as a session, it just has no day.
  assert.equal(metrics.archivedSessions, 2)
})

test('token totals aggregate turn telemetry across a live card', () => {
  const metrics = compute({
    columns: [
      column([
        card({
          id: 'card-1',
          messages: [
            message({
              createdAt: localIso('2026-08-16'),
              meta: {
                turnUsageUsed: '12000',
                turnUsageSize: '200000',
                turnUsageInput: '9000',
                turnUsageOutput: '3000',
                turnUsageCacheRead: '500',
                turnUsageCacheCreation: '250',
                turnUsageCostUsd: '0.12',
              },
            }),
            message({
              createdAt: localIso('2026-08-16'),
              meta: {
                turnUsageUsed: '45000',
                turnUsageSize: '200000',
                turnUsageInput: '40000',
                turnUsageOutput: '5000',
              },
            }),
            message({ createdAt: localIso('2026-08-16') }),
          ],
        }),
      ]),
    ],
  })

  assert.ok(metrics.tokens)
  assert.equal(metrics.tokens?.turns, 2)
  assert.equal(metrics.tokens?.input, 49000)
  assert.equal(metrics.tokens?.output, 8000)
  assert.equal(metrics.tokens?.cacheRead, 500)
  assert.equal(metrics.tokens?.cacheCreation, 250)
  assert.equal(metrics.tokens?.peakUsed, 45000)
  assert.equal(metrics.tokens?.peakSize, 200000)
  assert.ok(Math.abs((metrics.tokens?.costUsd ?? 0) - 0.12) < 1e-9)
})

test('tokens stay null when no turn ever reported usage', () => {
  const metrics = compute({
    columns: [
      column([
        card({
          id: 'card-1',
          messages: [message({ createdAt: localIso('2026-08-16'), meta: { turnStopReason: 'end_turn' } })],
        }),
      ]),
    ],
  })

  assert.equal(metrics.tokens, null)
})

test('range presets stay ordered and bounded', () => {
  assert.deepEqual(statsRangeDayCounts, [90, 180, 365])
})

test('heatmap columns are whole weeks with the first one padded from Sunday', () => {
  const metrics = compute({ rangeDays: 30 })
  const columns = buildStatsHeatColumns(metrics.days)

  assert.ok(columns.every((column) => column.cells.length === statsWeekdayRows))

  // 2026-07-18 is a Saturday, so the first column has six leading pad cells.
  assert.equal(metrics.days[0].date, '2026-07-18')
  assert.deepEqual(columns[0].cells.slice(0, 6), [null, null, null, null, null, null])
  assert.equal(columns[0].cells[6]?.date, '2026-07-18')

  const flattened = columns.flatMap((column) => column.cells).filter(Boolean)
  assert.equal(flattened.length, metrics.days.length)
  assert.equal(flattened[flattened.length - 1]?.date, '2026-08-16')
})

test('heatmap columns pad the trailing week instead of dropping days', () => {
  const metrics = compute({ rangeDays: 10 })
  const columns = buildStatsHeatColumns(metrics.days)
  const lastColumn = columns[columns.length - 1]

  assert.equal(lastColumn.cells.length, statsWeekdayRows)
  assert.ok(lastColumn.cells.some((cell) => cell === null))
  assert.equal(
    columns.flatMap((column) => column.cells).filter(Boolean).length,
    10,
  )
})

test('empty day list produces no heatmap columns', () => {
  assert.deepEqual(buildStatsHeatColumns([]), [])
  assert.deepEqual(buildStatsMonthLabels([], []), [])
})

test('month labels appear once per month at the column where it starts', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const metrics = compute({ rangeDays: 90 })
  const labels = buildStatsMonthLabels(buildStatsHeatColumns(metrics.days), months)

  assert.deepEqual(
    labels.map((label) => label.label),
    ['May', 'Jun', 'Jul', 'Aug'],
  )
  assert.ok(labels.every((label, index) => index === 0 || label.columnIndex > labels[index - 1].columnIndex))
})

test('archived sessions contribute their recorded usage totals', () => {
  const metrics = compute({
    columns: [
      column([
        card({
          id: 'card-1',
          messages: [
            message({
              createdAt: localIso('2026-08-16'),
              meta: {
                turnUsageUsed: '12000',
                turnUsageSize: '200000',
                turnUsageInput: '9000',
                turnUsageOutput: '3000',
                turnUsageCostUsd: '0.10',
              },
            }),
          ],
        }),
      ]),
    ],
    sessionHistory: [
      historyEntry({
        archivedAt: localIso('2026-08-10'),
        messageCount: 20,
        usageTotals: {
          input: 30000,
          output: 4000,
          cacheRead: 1000,
          cacheCreation: 700,
          turns: 5,
          peakUsed: 90000,
          peakSize: 400000,
          costUsd: 0.9,
        },
      }),
    ],
  })

  assert.ok(metrics.tokens)
  assert.equal(metrics.tokens?.turns, 6)
  assert.equal(metrics.tokens?.input, 39000)
  assert.equal(metrics.tokens?.output, 7000)
  assert.equal(metrics.tokens?.cacheRead, 1000)
  assert.equal(metrics.tokens?.cacheCreation, 700)
  // 峰值是"单轮最高占用"，跨会话取最大值而不是求和，窗口大小要跟着那一轮走。
  assert.equal(metrics.tokens?.peakUsed, 90000)
  assert.equal(metrics.tokens?.peakSize, 400000)
  assert.ok(Math.abs((metrics.tokens?.costUsd ?? 0) - 1.0) < 1e-9)
})

test('archived-only usage still produces a report when no card is open', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({
        archivedAt: localIso('2026-08-12'),
        messageCount: 4,
        usageTotals: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheCreation: 0,
          turns: 1,
          peakUsed: 120,
          peakSize: 0,
          costUsd: 0,
        },
      }),
    ],
  })

  assert.ok(metrics.tokens)
  assert.equal(metrics.tokens?.turns, 1)
  assert.equal(metrics.tokens?.input, 100)
})

test('cost is the running total per session, summed across sessions', () => {
  // 2026-08-16 实测：turnUsageCostUsd 是**会话累计**，逐轮求和会把花费翻几倍。
  const costMessage = (cost: string) =>
    message({
      createdAt: localIso('2026-08-16'),
      meta: {
        turnUsageUsed: '10000',
        turnUsageSize: '200000',
        turnUsageInput: '1000',
        turnUsageOutput: '100',
        turnUsageCostUsd: cost,
      },
    })

  const metrics = compute({
    columns: [
      column(
        [
          card({ id: 'card-1', messages: [costMessage('1.00'), costMessage('2.50')] }),
          card({ id: 'card-2', messages: [costMessage('0.40'), costMessage('0.75')] }),
        ],
      ),
    ],
    sessionHistory: [
      historyEntry({
        archivedAt: localIso('2026-08-10'),
        messageCount: 4,
        usageTotals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          turns: 2,
          peakUsed: 5000,
          peakSize: 200000,
          costUsd: 3.25,
        },
      }),
    ],
  })

  // 2.50 (card-1 累计终值) + 0.75 (card-2) + 3.25 (归档) = 6.50
  assert.ok(Math.abs((metrics.tokens?.costUsd ?? 0) - 6.5) < 1e-9)
  // token 计数仍是逐轮求和：它们本来就是每轮各自的量。
  assert.equal(metrics.tokens?.input, 4000)
  assert.equal(metrics.tokens?.turns, 6)
})

test('a live session lands on the day it started, not on today', () => {
  const metrics = compute({
    columns: [
      column([
        card({
          id: 'card-1',
          messages: [
            message({ createdAt: localIso('2026-08-14', 9) }),
            message({ createdAt: localIso('2026-08-16', 10) }),
          ],
        }),
      ]),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day.sessions]))
  // 会话记在开始那天，消息各自记各自那天 —— 打开中的卡不再对日历的会话数贡献 0。
  assert.equal(byDay.get('2026-08-14'), 1)
  assert.equal(byDay.get('2026-08-16'), 0)
  assert.equal(metrics.maxSessions, 1)
})

test('a card without any message does not land on any day', () => {
  const metrics = compute({
    columns: [column([card({ id: 'blank', messages: [] })])],
  })

  assert.equal(metrics.activeSessions, 1)
  assert.ok(metrics.days.every((day) => day.sessions === 0))
  assert.equal(metrics.maxSessions, 0)
})

test('an archived session lands on the day it started, not on the day it was archived', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({
        archivedAt: localIso('2026-08-16', 18),
        messageCount: 12,
        // 送进渲染进程的预览是 head 4 + tail 4，所以 messages[0] 仍是全场最早那条。
        messages: [
          message({ createdAt: localIso('2026-08-13', 8) }),
          message({ createdAt: localIso('2026-08-16', 17) }),
        ],
      }),
    ],
  })

  const byDay = new Map(metrics.days.map((day) => [day.date, day]))
  assert.equal(byDay.get('2026-08-13')?.sessions, 1)
  assert.equal(byDay.get('2026-08-13')?.count, 12)
  assert.equal(byDay.get('2026-08-16')?.sessions, 0)
  assert.equal(byDay.get('2026-08-16')?.count, 0)
})

test('an archived session with no usable start time falls back to its archived day', () => {
  const metrics = compute({
    sessionHistory: [
      historyEntry({ archivedAt: localIso('2026-08-11'), messageCount: 5 }),
      historyEntry({
        id: 'h-bad-start',
        archivedAt: localIso('2026-08-11', 20),
        messageCount: 2,
        messages: [message({ createdAt: 'not-a-date' })],
      }),
    ],
  })

  const day = metrics.days.find((entry) => entry.date === '2026-08-11')
  // 宁可落在偏晚的一天，也不让这一段从日历上消失。
  assert.equal(day?.sessions, 2)
  assert.equal(day?.count, 7)
})

test('an archived session stays recent by when it ended, not by when it started', () => {
  // 归档条目的日历归属日（开始日）不得回流到「最近 N 天」/ streak：一段 08-05 开工、
  // 今天才归档的会话，用户今天明明干了活。
  const metrics = compute({
    sessionHistory: [
      historyEntry({
        archivedAt: localIso('2026-08-16', 18),
        messageCount: 12,
        messages: [message({ createdAt: localIso('2026-08-05', 9) })],
      }),
    ],
  })

  // 日历仍按开始日着色（FR-3 的会话归日口径不受影响）。
  const byDay = new Map(metrics.days.map((day) => [day.date, day]))
  assert.equal(byDay.get('2026-08-05')?.sessions, 1)
  assert.equal(byDay.get('2026-08-05')?.count, 12)

  // 活跃/近期口径按会话收尾那天算。
  assert.equal(metrics.sessionsLast7, 1)
  assert.equal(metrics.sessionsLast30, 1)
  assert.equal(metrics.currentStreak, 1)
  assert.equal(metrics.activeDays, 1)
})

test('live and archived sessions enter the recent window from the same end of the session', () => {
  // 同一个计数器的两半不能一半读开始、一半读结束。
  const spanning = [message({ createdAt: localIso('2026-08-05', 9) }), message({ createdAt: localIso('2026-08-16', 9) })]
  const metrics = compute({
    columns: [column([card({ id: 'live', messages: spanning })])],
    sessionHistory: [
      historyEntry({
        id: 'h-spanning',
        archivedAt: localIso('2026-08-16', 18),
        messageCount: 2,
        messages: spanning,
      }),
    ],
  })

  assert.equal(metrics.sessionsLast7, 2)
  assert.equal(metrics.sessionsLast30, 2)
})

test('session levels use their own maximum so they are not flattened by message volume', () => {
  const busyDay = Array.from({ length: 40 }, () => message({ createdAt: localIso('2026-08-16', 10) }))
  const metrics = compute({
    columns: [
      column([
        card({ id: 'busy', messages: busyDay }),
        card({ id: 'quiet-a', messages: [message({ createdAt: localIso('2026-08-10', 9) })] }),
        card({ id: 'quiet-b', messages: [message({ createdAt: localIso('2026-08-10', 10) })] }),
        card({ id: 'quiet-c', messages: [message({ createdAt: localIso('2026-08-10', 11) })] }),
        card({ id: 'quiet-d', messages: [message({ createdAt: localIso('2026-08-10', 12) })] }),
      ]),
    ],
  })

  const quiet = metrics.days.find((day) => day.date === '2026-08-10')
  const busy = metrics.days.find((day) => day.date === '2026-08-16')

  assert.equal(quiet?.sessions, 4)
  assert.equal(metrics.maxSessions, 4)
  // 4 段会话那天在会话口径下是最深一档，尽管它只有 4 条消息、在消息口径下几乎看不见。
  assert.equal(quiet?.sessionLevel, 4)
  assert.equal(quiet?.level, 1)
  // 反过来，最忙那天只有 1 段会话。
  assert.equal(busy?.level, 4)
  assert.equal(busy?.sessionLevel, 1)
})

test('a day with no session at all stays at session level zero', () => {
  const metrics = compute({
    columns: [column([card({ id: 'card-1', messages: [message({ createdAt: localIso('2026-08-16') })] })])],
  })

  const idle = metrics.days.find((day) => day.date === '2026-08-15')
  assert.equal(idle?.sessions, 0)
  assert.equal(idle?.sessionLevel, 0)
})
