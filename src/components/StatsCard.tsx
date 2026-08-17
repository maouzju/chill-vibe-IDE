import { useEffect, useMemo, useState } from 'react'

import { maxSessionHistoryPerWorkspace } from '../../shared/default-state'
import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage } from '../../shared/schema'
import { readStatsSource } from '../stats-card-source'
import {
  buildStatsHeatColumns,
  buildStatsMonthLabels,
  computeStatsMetrics,
  statsRangeDayCounts,
  type StatsMetrics,
  type StatsRangeDays,
} from '../stats-card-metrics'

/**
 * 症状（要防的）：统计卡遍历全板所有消息，挂在渲染路径上会在流式输出时每帧重跑，
 *   大 profile 下直接吃光帧预算（AGENTS.md pitfall 48）。
 * 根因：`columns` 在流式期间每个 delta 都换引用，`useMemo` 会退化成"每次渲染都算"。
 * 为什么不能换写法：所以这里刻意**不**把 columns 放进 useMemo 依赖，而是把结果存进
 *   state，由定时器按固定间隔重算，并让给空闲帧。折叠时组件被卸载，定时器随之清掉。
 */
const RECOMPUTE_INTERVAL_MS = 30_000

/**
 * 症状：宽卡上日历只占左边一小条，右侧一大片空白，完全不像 GitHub 的贡献图。
 * 根因：格子写死 11px，列数由所选范围决定，两者都跟卡片宽度无关。
 * 被否决的替代 A：ResizeObserver 量宽度再算格子尺寸——能用，但 observer 回调里
 *   `setState` 撞 `react-hooks/set-state-in-effect`，而且首帧 loading 早退分支会让
 *   observer 装不上（见 AGENTS.md pitfall 316），为一个纯排版问题引入两个坑。
 * 被否决的替代 B：`grid-template-columns: repeat(N, 1fr)` + `gap`——列宽弹性、行高固定，
 *   方块会被拉成竖条。方块是这个图形的全部意义。
 * 现在的做法：列宽用 `minmax(下限, 上限)` 让 CSS 自己拉伸，列高用 `aspect-ratio: 1/7`
 *   锁死成 7 个正方形；格间距不能用 `gap`（它会破坏 1:7 的比例），改由每个格子自身的
 *   padding + `background-clip: content-box` 制造。整件事零 JS，列数通过 CSS 变量传入。
 */
const cssColumnCountVar = '--stats-cols'

type IdleHandle = { cancel: () => void }

const runWhenIdle = (task: () => void): IdleHandle => {
  const requestIdle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number })
    .requestIdleCallback
  const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback

  if (typeof requestIdle === 'function' && typeof cancelIdle === 'function') {
    const handle = requestIdle(task, { timeout: 1_000 })
    return { cancel: () => cancelIdle(handle) }
  }

  const handle = setTimeout(task, 0)
  return { cancel: () => clearTimeout(handle) }
}

const formatCompact = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0'
  }
  const rounded = Math.round(value)
  if (rounded < 1_000) {
    return String(rounded)
  }
  if (rounded < 1_000_000) {
    const scaled = rounded / 1_000
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}k`
  }
  const scaled = rounded / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}M`
}

const formatCost = (value: number) => (value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`)

type StatsCardProps = {
  language: AppLanguage
}

export function StatsCard({ language }: StatsCardProps) {
  // 一年是 GitHub 贡献图的默认视野，也是这张卡最有信息量的默认值。
  const [rangeDays, setRangeDays] = useState<StatsRangeDays>(365)
  const [metrics, setMetrics] = useState<StatsMetrics | null>(null)

  useEffect(() => {
    let cancelled = false
    let idleHandle: IdleHandle | null = null
    let lastComputedAt = 0

    const recompute = () => {
      idleHandle?.cancel()
      idleHandle = runWhenIdle(() => {
        if (cancelled) {
          return
        }
        lastComputedAt = Date.now()
        const source = readStatsSource()
        setMetrics(
          computeStatsMetrics({
            columns: source.columns,
            sessionHistory: source.sessionHistory,
            now: new Date(),
            rangeDays,
          }),
        )
      })
    }

    recompute()
    const interval = setInterval(recompute, RECOMPUTE_INTERVAL_MS)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastComputedAt >= RECOMPUTE_INTERVAL_MS) {
        recompute()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      idleHandle?.cancel()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [rangeDays])

  return (
    <StatsCardView
      language={language}
      metrics={metrics}
      rangeDays={rangeDays}
      onRangeChange={setRangeDays}
    />
  )
}

type StatsCardViewProps = {
  language: AppLanguage
  metrics: StatsMetrics | null
  rangeDays: StatsRangeDays
  onRangeChange: (rangeDays: StatsRangeDays) => void
}

/**
 * 纯展示层：不算数、不起定时器。拆出来是为了能对**真实的** metrics 做渲染断言——
 * 合在一起时首帧永远是 loading 占位，测试只能证明组件没崩，证不了它画对了。
 */
export function StatsCardView({ language, metrics, rangeDays, onRangeChange }: StatsCardViewProps) {
  const text = getLocaleText(language)

  const heatColumns = useMemo(() => buildStatsHeatColumns(metrics?.days ?? []), [metrics])
  const monthLabels = useMemo(
    () => buildStatsMonthLabels(heatColumns, text.statsMonthLabels),
    [heatColumns, text.statsMonthLabels],
  )

  const rangeLabels: Record<StatsRangeDays, string> = {
    90: text.statsRange90,
    180: text.statsRange180,
    365: text.statsRange365,
  }

  if (!metrics) {
    return (
      <div className="stats-card is-loading" data-stats-card>
        <div className="stats-card-placeholder" />
      </div>
    )
  }

  const tokens = metrics.tokens
  /**
   * 症状：进度条永远顶满。2026-08-16 实测用户归档里有 `peakUsed` 2.02 亿、窗口 20 万的
   *   回合，占比算出来 100000%，被 `Math.min(1, …)` 夹成满格，看上去像"上下文永远爆炸"。
   * 根因：`used` 是那一个回合里**所有 API 请求**的 token 之和，多步 agent 回合每一步都
   *   重读一遍缓存，累加下来必然远超窗口；只有单请求回合它才约等于上下文占用。
   * 被否决的替代：按窗口取模或改用最后一次请求的值——前者是编数字，后者数据里根本没有。
   * 所以：超出窗口时只报数值不画条。数字是真的，占比不是。
   */
  const peakRatio =
    tokens && tokens.peakSize > 0 && tokens.peakUsed <= tokens.peakSize
      ? tokens.peakUsed / tokens.peakSize
      : null
  /**
   * 症状（要防的）：写成「含已归档会话」会让人以为是全部历史。实际上统计卡只读
   *   `state.sessionHistory`，那份索引每个工作区只留最近 50 段（2026-08-16 实测用户
   *   存档：三个活跃工作区正好卡在 50，而磁盘上的转录有 9649 段 / 1.06 GB）。
   * 为什么不改成读全量：完整转录在 `session-history/` 的 sidecar 里，扫它们是长期 bug
   *   「用久了卡死」的形状（SPEC FR-3 / AGENTS.md pitfall 48）——`server/providers.ts`
   *   已经为此留过一条 OOM 记录。要翻全部历史请用工作区标题栏的「历史」菜单，那里走的是
   *   后台增量建的 catalog。
   * 所以：口径写在明面上，而不是让数字自己去解释。
   */
  const scopeHint = text.statsTokensScopeHint(
    metrics.archivedSessionsWithoutUsage,
    maxSessionHistoryPerWorkspace,
  )

  return (
    <div className="stats-card" data-stats-card>
      <div className="stats-card-summary">
        <div className="stats-tile">
          <span className="stats-tile-value">{formatCompact(metrics.totalSessions)}</span>
          <span className="stats-tile-label">{text.statsSessionsLabel}</span>
          <span className="stats-tile-sub">
            {text.statsSessionsBreakdown(metrics.activeSessions, metrics.archivedSessions)}
          </span>
        </div>
        <div className="stats-tile">
          <span className="stats-tile-value">{formatCompact(metrics.totalMessages)}</span>
          <span className="stats-tile-label">{text.statsMessagesLabel}</span>
          <span className="stats-tile-sub">
            {text.statsRecentSessions(text.statsRecent7, metrics.sessionsLast7)}
          </span>
        </div>
        <div className="stats-tile">
          <span className="stats-tile-value">
            {metrics.currentStreak}
            <span className="stats-tile-unit">{text.statsDaysUnit}</span>
          </span>
          <span className="stats-tile-label">{text.statsStreakLabel}</span>
          <span className="stats-tile-sub">max {metrics.longestStreak}</span>
        </div>
        <div className="stats-tile">
          <span className="stats-tile-value">{formatCompact(metrics.activeDays)}</span>
          <span className="stats-tile-label">{text.statsActiveDaysLabel}</span>
          <span className="stats-tile-sub">
            {text.statsRecentSessions(text.statsRecent30, metrics.sessionsLast30)}
          </span>
        </div>
      </div>

      <div className="stats-card-heatmap">
        <div className="stats-heatmap-scroll">
          <div
            className="stats-heatmap-inner"
            style={{ [cssColumnCountVar]: heatColumns.length } as React.CSSProperties}
          >
            <div className="stats-heatmap-months">
              {monthLabels.map((label) => (
                <span
                  key={label.key}
                  className="stats-heatmap-month"
                  // 百分比而不是像素：格子尺寸现在由 CSS 决定，JS 这边不知道它有多大。
                  style={{ left: `${(label.columnIndex / Math.max(1, heatColumns.length)) * 100}%` }}
                >
                  {label.label}
                </span>
              ))}
            </div>
            <div className="stats-heatmap-body">
              <div className="stats-heatmap-weekdays">
                {text.statsWeekdayLabels.map((label, index) => (
                  <span key={label} className="stats-heatmap-weekday">
                    {index % 2 === 1 ? label : ''}
                  </span>
                ))}
              </div>
              <div className="stats-heatmap-grid">
                {heatColumns.map((column) => (
                  <div key={column.key} className="stats-heatmap-column">
                    {column.cells.map((cell, rowIndex) =>
                      cell ? (
                        <span
                          key={cell.date}
                          className="stats-heatmap-cell"
                          data-level={cell.level}
                          tabIndex={0}
                          aria-label={text.statsHeatmapTooltip(cell.date, cell.count, cell.sessions)}
                          title={text.statsHeatmapTooltip(cell.date, cell.count, cell.sessions)}
                        />
                      ) : (
                        <span
                          key={`${column.key}-pad-${rowIndex}`}
                          className="stats-heatmap-cell is-empty"
                          aria-hidden="true"
                        />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="stats-heatmap-footer">
          <div className="stats-range-picker" role="group">
            {statsRangeDayCounts.map((days) => (
              <button
                key={days}
                type="button"
                className={`stats-range-button${days === rangeDays ? ' is-active' : ''}`}
                aria-pressed={days === rangeDays}
                onClick={() => onRangeChange(days)}
              >
                {rangeLabels[days]}
              </button>
            ))}
          </div>
          <div className="stats-heatmap-legend">
            <span>{text.statsHeatmapLess}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className="stats-heatmap-cell" data-level={level} />
            ))}
            <span>{text.statsHeatmapMore}</span>
          </div>
        </div>
      </div>

      <div className="stats-card-footer">
        <div className="stats-provider-row">
          <span className="stats-section-label">{text.statsProviderLabel}</span>
          <span className="stats-provider-chip" data-provider="codex">
            Codex <b>{metrics.byProvider.codex}</b>
          </span>
          <span className="stats-provider-chip" data-provider="claude">
            Claude <b>{metrics.byProvider.claude}</b>
          </span>
        </div>

        <div className="stats-tokens">
          <div className="stats-tokens-header">
            <span className="stats-section-label">{text.statsTokensTitle}</span>
            <span className="stats-tokens-hint" title={scopeHint}>
              {scopeHint}
            </span>
          </div>
          {tokens ? (
            <>
              <div className="stats-tokens-grid">
                <span className="stats-token-item">
                  {text.statsTokensInput} <b>{formatCompact(tokens.input)}</b>
                </span>
                <span className="stats-token-item">
                  {text.statsTokensOutput} <b>{formatCompact(tokens.output)}</b>
                </span>
                <span className="stats-token-item">
                  {text.statsTokensCacheRead} <b>{formatCompact(tokens.cacheRead)}</b>
                </span>
                <span className="stats-token-item">
                  {text.statsTokensCacheWrite} <b>{formatCompact(tokens.cacheCreation)}</b>
                </span>
                <span className="stats-token-item">
                  {text.statsTokensTurns} <b>{tokens.turns}</b>
                </span>
                {tokens.costUsd > 0 && (
                  <span className="stats-token-item">
                    {text.statsTokensCost} <b>{formatCost(tokens.costUsd)}</b>
                  </span>
                )}
              </div>
              {tokens.peakUsed > 0 && (
                <div className="stats-peak">
                  <div className="stats-peak-label">
                    <span>{text.statsTokensPeak}</span>
                    <span>
                      {formatCompact(tokens.peakUsed)}
                      {peakRatio !== null ? ` / ${formatCompact(tokens.peakSize)}` : ''}
                    </span>
                  </div>
                  {peakRatio !== null && (
                    <div className="stats-peak-track">
                      <div className="stats-peak-fill" style={{ width: `${Math.round(peakRatio * 100)}%` }} />
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <span className="stats-tokens-empty">{text.statsTokensEmpty}</span>
          )}
        </div>
      </div>
    </div>
  )
}
