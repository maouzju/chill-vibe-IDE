import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { maxSessionHistoryPerWorkspace } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { getLocaleText } from '../shared/i18n.ts'
import type { BoardColumn, ChatCard, ChatMessage, SessionHistoryEntry } from '../shared/schema.ts'
import { computeStatsMetrics } from '../src/stats-card-metrics.ts'
import { StatsCardView } from '../src/components/StatsCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const now = new Date(2026, 7, 16, 15, 0, 0, 0)

const localIso = (dayKey: string, hour = 12) => {
  const [year, month, day] = dayKey.split('-').map(Number)
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString()
}

const message = (createdAt: string, meta?: Record<string, string>): ChatMessage => ({
  id: `m-${createdAt}-${meta ? 'u' : 'p'}`,
  role: 'assistant',
  content: 'reply',
  createdAt,
  ...(meta ? { meta } : {}),
})

const column = (messages: ChatMessage[]): BoardColumn =>
  ({
    id: 'column-1',
    title: 'Workspace',
    provider: 'codex',
    workspacePath: 'D:/repo/one',
    model: DEFAULT_CODEX_MODEL,
    layout: { type: 'pane', id: 'pane-1', tabs: ['card-1'], activeTabId: 'card-1' },
    cards: {
      'card-1': {
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
        messages,
      } as ChatCard,
    },
  }) as BoardColumn

const history = (
  archivedAt: string,
  messageCount: number,
  id: string,
  usageTotals?: SessionHistoryEntry['usageTotals'],
): SessionHistoryEntry =>
  ({
    id,
    title: 'Archived',
    provider: 'claude',
    model: 'claude-opus-5',
    workspacePath: 'D:/repo/one',
    messages: [],
    messageCount,
    usageTotals,
    archivedAt,
  }) as SessionHistoryEntry

const archivedUsage = (overrides: Partial<NonNullable<SessionHistoryEntry['usageTotals']>> = {}) => ({
  input: 1000,
  output: 200,
  cacheRead: 0,
  cacheCreation: 0,
  turns: 1,
  peakUsed: 1200,
  peakSize: 200000,
  costUsd: 0.01,
  ...overrides,
})

const renderWith = (
  options: {
    columns?: BoardColumn[]
    sessionHistory?: SessionHistoryEntry[]
    language?: 'zh-CN' | 'en'
  } = {},
) => {
  const metrics = computeStatsMetrics({
    columns: options.columns ?? [],
    sessionHistory: options.sessionHistory ?? [],
    now,
    rangeDays: 90,
  })

  return renderToStaticMarkup(
    React.createElement(StatsCardView, {
      language: options.language ?? 'zh-CN',
      metrics,
      rangeDays: 90 as const,
      onRangeChange: () => undefined,
    }),
  )
}

describe('stats card view', () => {
  it('renders a loading placeholder before the first computation lands', () => {
    const markup = renderToStaticMarkup(
      React.createElement(StatsCardView, {
        language: 'zh-CN' as const,
        metrics: null,
        rangeDays: 90 as const,
        onRangeChange: () => undefined,
      }),
    )

    assert.ok(markup.includes('stats-card is-loading'))
    assert.ok(markup.includes('stats-card-placeholder'))
  })

  // 症状（要防的）：「消息 / 500」这块砖下面挂一句「最近 7 天 · 3」，那个 3 其实是**会话数**，
  //   任何人都会读成"最近 7 天只有 3 条消息"；「活跃天数」那块同理会被读成天数。
  // 所以主值与副标题不同维度时，副标题的单位词不能省。
  it('spells out that the recent-window subtitles count sessions, not messages or days', () => {
    const columns = [column([message(localIso('2026-08-14'))])]

    const zh = renderWith({ columns })
    assert.ok(zh.includes('段会话'), 'the zh subtitle must name its unit')
    assert.equal(
      /最近 7 天 · \d+</.test(zh),
      false,
      'a bare trailing number reads as another count of the tile value',
    )

    const en = renderWith({ columns, language: 'en' })
    assert.ok(/Recent 7 days · \d+ sessions?</.test(en), 'the en subtitle must name its unit')
    assert.ok(/Recent 30 days · \d+ sessions?</.test(en), 'the active-days tile needs it too')
  })

  it('renders one heatmap cell per day in range plus the legend swatches', () => {
    const markup = renderWith({})
    const cells = markup.match(/class="stats-heatmap-cell/g) ?? []

    // 90 days padded out to whole weeks (14 columns × 7) + 5 legend swatches.
    assert.equal(cells.length, 14 * 7 + 5)
    assert.ok(markup.includes('data-stats-card'))
  })

  it('paints busy days with a hotter level than quiet ones', () => {
    const markup = renderWith({
      sessionHistory: [
        history(localIso('2026-08-16'), 100, 'busy'),
        history(localIso('2026-08-15'), 1, 'quiet'),
      ],
    })

    assert.ok(markup.includes('data-level="4"'), 'the busiest day must reach the top level')
    assert.ok(markup.includes('data-level="1"'), 'the quiet day must stay at the lowest non-zero level')
  })

  it('shows a tooltip carrying the real per-day numbers', () => {
    const markup = renderWith({ sessionHistory: [history(localIso('2026-08-16'), 7, 'busy')] })
    const text = getLocaleText('zh-CN')

    assert.ok(markup.includes(text.statsHeatmapTooltip('2026-08-16', 7, 1)))
    assert.ok(markup.includes('tabindex="0"'), 'real day cells must be keyboard reachable')
    assert.ok(markup.includes('aria-label='), 'screen readers need the same per-day detail')
    assert.ok(markup.includes('aria-hidden="true"'), 'padding cells must stay out of the accessibility tree')
  })

  it('falls back to an explicit empty state instead of showing zero tokens', () => {
    const markup = renderWith({ columns: [column([message(localIso('2026-08-16'))])] })
    const text = getLocaleText('zh-CN')

    assert.ok(markup.includes(text.statsTokensEmpty))
    assert.ok(!markup.includes('stats-tokens-grid'))
  })

  it('renders token totals and the peak bar once a turn reports usage', () => {
    const markup = renderWith({
      columns: [
        column([
          message(localIso('2026-08-16'), {
            turnUsageUsed: '50000',
            turnUsageSize: '200000',
            turnUsageInput: '40000',
            turnUsageOutput: '10000',
          }),
        ]),
      ],
    })

    assert.ok(markup.includes('stats-tokens-grid'))
    assert.ok(markup.includes('40k'))
    assert.ok(markup.includes('10k'))
    // 50000 / 200000 = 25%
    assert.ok(markup.includes('width:25%'), 'peak bar must reflect used/window')
  })

  it('counts archived usage into the totals and says the scope covers archives', () => {
    const markup = renderWith({
      columns: [
        column([
          message(localIso('2026-08-16'), {
            turnUsageUsed: '50000',
            turnUsageSize: '200000',
            turnUsageInput: '40000',
            turnUsageOutput: '10000',
          }),
        ]),
      ],
      sessionHistory: [history(localIso('2026-08-10'), 12, 'h-usage', archivedUsage({ input: 10000 }))],
    })
    const text = getLocaleText('zh-CN')

    assert.ok(markup.includes('50k'), '40k live + 10k archived input must be summed')
    assert.ok(markup.includes(text.statsTokensScopeHint(0, maxSessionHistoryPerWorkspace)))
  })

  it('names how many archives predate usage tracking instead of disclaiming the whole card', () => {
    const markup = renderWith({
      columns: [
        column([
          message(localIso('2026-08-16'), {
            turnUsageUsed: '50000',
            turnUsageSize: '200000',
            turnUsageInput: '40000',
            turnUsageOutput: '10000',
          }),
        ]),
      ],
      sessionHistory: [
        history(localIso('2026-08-10'), 12, 'h-legacy-1'),
        history(localIso('2026-08-09'), 3, 'h-legacy-2'),
      ],
    })
    const text = getLocaleText('zh-CN')

    assert.ok(markup.includes(text.statsTokensScopeHint(2, maxSessionHistoryPerWorkspace)))
  })

  it('drops the peak bar when the heaviest turn outgrew its context window', () => {
    // 多步回合每步都重读缓存，`used` 会远超窗口。画成进度条就是永远顶满的假警报。
    const markup = renderWith({
      columns: [
        column([
          message(localIso('2026-08-16'), {
            turnUsageUsed: '202524283',
            turnUsageSize: '200000',
            turnUsageInput: '118572',
            turnUsageOutput: '159335',
          }),
        ]),
      ],
    })

    assert.ok(markup.includes('stats-peak-label'), 'the number itself is real and must stay')
    assert.ok(!markup.includes('stats-peak-fill'), 'the ratio is meaningless here and must go')
    assert.ok(!markup.includes('/ 200k'), 'no window comparison when the turn outgrew it')
  })

  it('marks the active range button and offers all three presets', () => {
    const markup = renderWith({})
    const text = getLocaleText('zh-CN')

    assert.ok(markup.includes(text.statsRange90))
    assert.ok(markup.includes(text.statsRange180))
    assert.ok(markup.includes(text.statsRange365))
    assert.equal((markup.match(/stats-range-button is-active/g) ?? []).length, 1)
    assert.ok(markup.includes('aria-pressed="true"'))
  })

  it('renders both providers in the breakdown row', () => {
    const markup = renderWith({
      columns: [column([message(localIso('2026-08-16'))])],
      sessionHistory: [history(localIso('2026-08-15'), 3, 'h1')],
    })

    assert.ok(markup.includes('data-provider="codex"'))
    assert.ok(markup.includes('data-provider="claude"'))
  })

  it('renders English copy without leaking Chinese strings', () => {
    const markup = renderWith({ language: 'en' })
    const en = getLocaleText('en')

    assert.ok(markup.includes(en.statsSessionsLabel))
    assert.ok(markup.includes(en.statsTokensEmpty))
    assert.ok(!/[一-鿿]/.test(markup), 'English render must not contain CJK characters')
  })
})
