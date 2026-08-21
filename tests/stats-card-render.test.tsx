import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { maxSessionHistoryPerWorkspace } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import { getLocaleText } from '../shared/i18n.ts'
import type { BoardColumn, ChatCard, ChatMessage, SessionHistoryEntry } from '../shared/schema.ts'
import { computeStatsMetrics, type StatsHeatMetric } from '../src/stats-card-metrics.ts'
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

/** 切出某一组切换器的 markup。组里只有 button，所以第一个 `</div>` 就是组的收尾。 */
const pickerGroup = (markup: string, picker: 'metric' | 'range') => {
  const match = markup.match(new RegExp(`data-picker="${picker}"[^>]*>([\\s\\S]*?)</div>`))
  assert.ok(match, `no ${picker} picker found`)
  return match[1]
}

/** 从 markup 里挖出某一天那一格的等级。属性顺序跟着 JSX 走：data-level 在 aria-label 之前。 */
const levelForDay = (markup: string, dayKey: string) => {
  const match = markup.match(new RegExp(`data-level="(\\d)"[^>]*aria-label="${dayKey}[^"]*"`))
  assert.ok(match, `no calendar cell found for ${dayKey}`)
  return Number(match[1])
}

const renderWith = (
  options: {
    columns?: BoardColumn[]
    sessionHistory?: SessionHistoryEntry[]
    language?: 'zh-CN' | 'en'
    heatMetric?: StatsHeatMetric
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
      heatMetric: options.heatMetric ?? 'messages',
      onHeatMetricChange: () => undefined,
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
        heatMetric: 'messages' as const,
        onHeatMetricChange: () => undefined,
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

  it('always reports the session count in the tooltip, including days with none', () => {
    // 会话记在开始日 08-14，所以 08-16 那格是"有消息、0 段会话"。
    const markup = renderWith({
      columns: [column([message(localIso('2026-08-14')), message(localIso('2026-08-16'))])],
    })

    // 只在 sessions > 0 时才带出会话数会让人以为功能坏了 —— 「0 段」和「没数据」是两件事。
    assert.ok(markup.includes('2026-08-16：0 段会话 · 1 条消息'))
    assert.ok(markup.includes('2026-08-14：1 段会话 · 1 条消息'))
  })

  it('repaints the calendar by session count when the sessions metric is picked', () => {
    const options = {
      sessionHistory: [
        history(localIso('2026-08-16'), 100, 'one-big'),
        history(localIso('2026-08-15'), 1, 'small-a'),
        history(localIso('2026-08-15', 13), 1, 'small-b'),
        history(localIso('2026-08-15', 14), 1, 'small-c'),
      ],
    }

    const byMessages = renderWith(options)
    const bySessions = renderWith({ ...options, heatMetric: 'sessions' })

    // 消息口径：100 条那天最深，3 条那天几乎看不见。
    assert.equal(levelForDay(byMessages, '2026-08-16'), 4)
    assert.equal(levelForDay(byMessages, '2026-08-15'), 1)
    // 会话口径反过来：3 段那天最深，1 段那天退到中间档 —— 分档基准换成了 maxSessions。
    assert.equal(levelForDay(bySessions, '2026-08-15'), 4)
    assert.equal(levelForDay(bySessions, '2026-08-16'), 2)
  })

  it('marks the picked calendar metric as pressed', () => {
    const text = getLocaleText('zh-CN')
    const markup = renderWith({ heatMetric: 'sessions' })

    assert.ok(markup.includes(text.statsHeatMetricMessages))
    assert.ok(markup.includes(text.statsHeatMetricSessions))
    assert.ok(
      markup.includes(`aria-pressed="true">${text.statsHeatMetricSessions}<`),
      'the picked metric must be the pressed one',
    )
    assert.ok(
      markup.includes(`aria-pressed="false">${text.statsHeatMetricMessages}<`),
      'the other metric must not read as pressed',
    )
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
    // 只数范围那一组：口径切换器复用同一套按钮皮肤，全局计数会把它也算进来。
    assert.equal((pickerGroup(markup, 'range').match(/stats-range-button is-active/g) ?? []).length, 1)
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
