import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CLAUDE_PRICING_COPIED_ON } from '../../shared/claude-pricing'
import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage, ClaudeUsageResponse } from '../../shared/schema'
import { fetchClaudeUsage } from '../api'
import {
  buildUsageChart,
  claudeUsageMetrics,
  claudeUsagePresets,
  filterUsageProjects,
  formatUsageAxisValue,
  formatUsageLastUsed,
  formatUsageMetricValue,
  formatUsageMoney,
  formatUsageTokens,
  OTHER_PROJECT_ID,
  resolveUsagePresetRange,
  summarizeUsageFamilies,
  type ClaudeUsageMetric,
  type ClaudeUsagePreset,
} from '../claude-usage-view-model'
import { readStatsSource } from '../stats-card-source'

/** 扫描进行中时轮询的间隔；扫描结束即停。 */
const SCAN_POLL_INTERVAL_MS = 3_000
const CHART_HEIGHT = 230

type ClaudeUsagePanelProps = {
  language: AppLanguage
}

/**
 * 取数容器：读模块级快照拿工作区路径与鞭策名单（理由见 src/stats-card-source.ts），
 * 调 fetchClaudeUsage，扫描中按固定间隔重拉。展示交给 ClaudeUsageView（纯组件，SSR 可测）。
 */
export function ClaudeUsagePanel({ language }: ClaudeUsagePanelProps) {
  const [preset, setPreset] = useState<ClaudeUsagePreset>('last30')
  const [metric, setMetric] = useState<ClaudeUsageMetric>('cost')
  const [data, setData] = useState<ClaudeUsageResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  // 「刷新」只强制扫描一次：换时段重跑 effect 时不能把上一次的 refresh=true 又带上，否则每切一次时段都重扫。
  const pendingRefreshRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const load = async (refresh: boolean) => {
      const source = readStatsSource()
      const range = resolveUsagePresetRange(preset, new Date())
      try {
        const response = await fetchClaudeUsage({
          ...range,
          workspaces: Array.from(new Set(source.columns.map((column) => column.workspacePath).filter(Boolean))),
          urgeMessages: source.autoUrgeMessages.filter(Boolean),
          refresh,
        })
        if (cancelled) return
        setData(response)
        setError(null)
        if (response.scan.scanning) {
          timer = setTimeout(() => void load(false), SCAN_POLL_INTERVAL_MS)
        }
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    }

    const refresh = pendingRefreshRef.current
    pendingRefreshRef.current = false
    void load(refresh)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [preset, refreshToken])

  const handleRefresh = useCallback(() => {
    pendingRefreshRef.current = true
    setRefreshToken((value) => value + 1)
  }, [])

  return (
    <ClaudeUsageView
      language={language}
      data={data}
      error={error}
      preset={preset}
      onPresetChange={setPreset}
      metric={metric}
      onMetricChange={setMetric}
      onRefresh={handleRefresh}
    />
  )
}

type ClaudeUsageViewProps = {
  language: AppLanguage
  data: ClaudeUsageResponse | null
  error: string | null
  preset: ClaudeUsagePreset
  onPresetChange: (preset: ClaudeUsagePreset) => void
  metric: ClaudeUsageMetric
  onMetricChange: (metric: ClaudeUsageMetric) => void
  onRefresh: () => void
  /** 测试注入图表宽度；真实运行时由 ResizeObserver 量。 */
  chartWidthOverride?: number
}

const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`

const formatClock = (iso: string | null) => {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value))
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 量容器宽度给 SVG 定 viewBox。用 callback ref 而不是 useRef + useLayoutEffect：这张图在
 * 数据到来前有 loading 早退分支，后者会让 observer 永远装不上（AGENTS.md pitfall 316）。
 */
const useMeasuredWidth = (override?: number) => {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(override ?? 0)

  useEffect(() => {
    if (!node || override !== undefined || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0)
      setWidth((previous) => (previous === next ? previous : next))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, override])

  return { ref: setNode, width: override ?? width }
}

export function ClaudeUsageView({
  language,
  data,
  error,
  preset,
  onPresetChange,
  metric,
  onMetricChange,
  onRefresh,
  chartWidthOverride,
}: ClaudeUsageViewProps) {
  const text = getLocaleText(language)
  const { ref: chartHostRef, width: measuredWidth } = useMeasuredWidth(chartWidthOverride)
  const [query, setQuery] = useState('')
  const [hoverDay, setHoverDay] = useState<number | null>(null)

  const presetLabels: Record<ClaudeUsagePreset, string> = {
    today: text.usagePresetToday,
    yesterday: text.usagePresetYesterday,
    last7: text.usagePresetLast7,
    last30: text.usagePresetLast30,
    thisMonth: text.usagePresetThisMonth,
    lastMonth: text.usagePresetLastMonth,
    all: text.usagePresetAll,
  }
  const metricLabels: Record<ClaudeUsageMetric, string> = {
    cost: text.usageMetricCost,
    tokens: text.usageMetricTokens,
    prompts: text.usageMetricPrompts,
    promptChars: text.usageMetricPromptChars,
  }

  const projectLabel = useCallback(
    (id: string) => {
      if (id === OTHER_PROJECT_ID) return text.usageOtherProjects
      return (text.usageProjectLabels as Record<string, string>)[id] ?? id
    },
    [text],
  )

  const chartWidth = Math.max(measuredWidth, 240)
  const chart = useMemo(() => {
    if (!data) return null
    const chartFrom = preset === 'all' && data.span ? data.span.from : data.from
    return buildUsageChart({
      daily: data.daily[metric],
      from: chartFrom,
      to: data.to,
      colorOrder: data.colorOrder,
      width: chartWidth,
      height: CHART_HEIGHT,
      isMoney: metric === 'cost',
    })
  }, [data, metric, chartWidth, preset])

  const projects = useMemo(() => (data ? filterUsageProjects(data.projects, query, projectLabel) : []), [data, query, projectLabel])
  const maxProjectCost = useMemo(() => Math.max(...(data?.projects.map((project) => project.costUsd) ?? []), 1e-9), [data])

  const colorVar = (project: string) => {
    const index = data?.colorOrder.indexOf(project) ?? -1
    return index >= 0 ? `var(--usage-s${index + 1})` : 'var(--usage-other)'
  }
  const colorStyle = (project: string) => ({ background: colorVar(project) })
  const fillStyle = (project: string) => ({ fill: colorVar(project) })

  const statusText = (() => {
    if (error) return text.usageLoadFailed
    if (!data) return ''
    if (data.scan.scanning) return text.usageScanning(data.scan.done, data.scan.total)
    if (data.scan.error) return `${text.usageLoadFailed}: ${data.scan.error}`
    return data.scan.lastScanAt ? text.usageUpdatedAt(formatClock(data.scan.lastScanAt)) : text.usageNeverScanned
  })()

  const hovered = chart && hoverDay !== null ? chart.days[hoverDay] ?? null : null

  return (
    <div className="usage-view" data-claude-usage>
      <div className="usage-toolbar">
        <div className="stats-range-picker" role="group" data-picker="usage-preset" aria-label={text.statsViewLabel}>
          {claudeUsagePresets.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={`stats-range-button${candidate === preset ? ' is-active' : ''}`}
              aria-pressed={candidate === preset}
              onClick={() => onPresetChange(candidate)}
            >
              {presetLabels[candidate]}
            </button>
          ))}
        </div>
        <button type="button" className="stats-range-button usage-refresh" onClick={onRefresh} disabled={!!data?.scan.scanning}>
          {text.usageRefresh}
        </button>
        <span className="usage-status" title={statusText}>
          {statusText}
        </span>
      </div>

      {data ? (
        <>
          <div className="usage-kpis">
            <div className="stats-tile">
              <span className="stats-tile-value">{formatUsageMoney(data.kpi.totalCostUsd)}</span>
              <span className="stats-tile-label">{text.usageKpiTotalCost}</span>
              <span className="stats-tile-sub">
                {data.from} ~ {data.to}
              </span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatUsageMoney(data.kpi.dailyAverageCostUsd)}</span>
              <span className="stats-tile-label">{text.usageKpiDailyAverage}</span>
              <span className="stats-tile-sub">{text.usageKpiActiveDays(data.kpi.activeDays)}</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatUsageTokens(data.kpi.totalTokens)}</span>
              <span className="stats-tile-label">{text.usageKpiTokens}</span>
              <span className="stats-tile-sub">{text.usageKpiOutputTokens(formatUsageTokens(data.kpi.outputTokens))}</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{data.kpi.sessions.toLocaleString('en-US')}</span>
              <span className="stats-tile-label">{text.usageKpiSessions}</span>
              <span className="stats-tile-sub">{text.usageKpiProjects(data.kpi.projects)}</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value usage-kpi-top" title={data.kpi.topProject ? projectLabel(data.kpi.topProject) : ''}>
                {data.kpi.topProject ? projectLabel(data.kpi.topProject) : '—'}
              </span>
              <span className="stats-tile-label">{text.usageKpiTop}</span>
              <span className="stats-tile-sub">
                {data.kpi.topProject ? text.usageKpiTopShare(formatPercent(data.kpi.topProjectShare)) : ''}
              </span>
            </div>
          </div>

          <div className="usage-section">
            <div className="usage-section-head">
              <span className="stats-section-label">{text.usageChartTitle[metric]}</span>
              <div className="stats-range-picker" role="group" data-picker="usage-metric">
                {claudeUsageMetrics.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className={`stats-range-button${candidate === metric ? ' is-active' : ''}`}
                    aria-pressed={candidate === metric}
                    onClick={() => onMetricChange(candidate)}
                  >
                    {metricLabels[candidate]}
                  </button>
                ))}
              </div>
              {chart && chart.legend.length > 0 && (
                <div className="usage-legend">
                  {chart.legend.map((entry) => (
                    <span key={entry.project} className="usage-legend-item">
                      <i className="usage-swatch" style={colorStyle(entry.project)} />
                      {projectLabel(entry.project)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="usage-chart-host" ref={chartHostRef} onMouseLeave={() => setHoverDay(null)}>
              {chart && (
                <svg
                  className="usage-chart"
                  viewBox={`0 0 ${chart.width} ${chart.height}`}
                  width={chart.width}
                  height={chart.height}
                  role="img"
                  aria-label={text.usageChartTitle[metric]}
                >
                  {chart.ticks.map((tick) => (
                    <g key={tick.value}>
                      <line
                        x1={chart.padding.left}
                        x2={chart.width - chart.padding.right}
                        y1={tick.y}
                        y2={tick.y}
                        className="usage-gridline"
                      />
                      <text x={chart.padding.left - 6} y={tick.y + 4} textAnchor="end" className="usage-axis-text">
                        {formatUsageAxisValue(metric, tick.value)}
                      </text>
                    </g>
                  ))}
                  {chart.days.map((day, index) => (
                    <g key={day.key} data-usage-day={day.key}>
                      {day.segments.map((segment, segmentIndex) => {
                        const isTop = segmentIndex === day.segments.length - 1
                        const seam = segmentIndex > 0 ? 1 : 0
                        const height = Math.max(0, segment.height - seam)
                        return (
                          <rect
                            key={segment.project}
                            x={day.x}
                            y={segment.y}
                            width={day.width}
                            height={height}
                            rx={isTop ? Math.min(3, day.width / 2, height) : 0}
                            className="usage-bar-segment"
                            style={fillStyle(segment.project)}
                          />
                        )
                      })}
                      {day.labelVisible && (
                        <text x={day.x + day.width / 2} y={chart.height - 6} textAnchor="middle" className="usage-axis-text">
                          {day.key.slice(5)}
                        </text>
                      )}
                      <rect
                        className={`usage-hit${hoverDay === index ? ' is-hover' : ''}`}
                        x={day.x - 1}
                        y={chart.padding.top}
                        width={day.width + 2}
                        height={chart.height - chart.padding.top - chart.padding.bottom}
                        onMouseEnter={() => setHoverDay(index)}
                      />
                    </g>
                  ))}
                </svg>
              )}
              {hovered && chart && (
                <div
                  className="usage-tooltip"
                  style={{
                    left: `${Math.min(hovered.x + hovered.width + 8, Math.max(0, chart.width - 200))}px`,
                  }}
                >
                  <div className="usage-tooltip-row">
                    <b>{hovered.key}</b>
                    <b>{formatUsageMetricValue(metric, hovered.total)}</b>
                  </div>
                  {hovered.breakdown.slice(0, 8).map((item) => (
                    <div key={item.project} className="usage-tooltip-row">
                      <span>
                        <i className="usage-swatch" style={colorStyle(item.project)} />
                        {projectLabel(item.project)}
                      </span>
                      <span>{formatUsageMetricValue(metric, item.value)}</span>
                    </div>
                  ))}
                  {hovered.breakdown.length > 8 && (
                    <div className="usage-tooltip-row">
                      <span>{text.usageTooltipRest(hovered.breakdown.length - 8)}</span>
                      <span>
                        {formatUsageMetricValue(
                          metric,
                          hovered.breakdown.slice(8).reduce((sum, item) => sum + item.value, 0),
                        )}
                      </span>
                    </div>
                  )}
                  {hovered.breakdown.length === 0 && <div className="usage-tooltip-row">{text.usageTooltipEmpty}</div>}
                </div>
              )}
            </div>
          </div>

          <div className="usage-section">
            <div className="usage-section-head">
              <span className="stats-section-label">{text.usageTableTitle}</span>
              <input
                type="search"
                className="usage-search"
                value={query}
                placeholder={text.usageSearchPlaceholder}
                aria-label={text.usageSearchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="usage-table-scroll">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th className="usage-col-rank">#</th>
                    <th>{text.usageColProject}</th>
                    <th className="usage-num">{text.usageColCost}</th>
                    <th className="usage-col-share">{text.usageColShare}</th>
                    <th className="usage-num">{text.usageColTokens}</th>
                    <th className="usage-col-models">{text.usageColModels}</th>
                    <th className="usage-num">{text.usageColSessions}</th>
                    <th className="usage-num">{text.usageColPrompts}</th>
                    <th className="usage-num usage-col-chars">{text.usageColChars}</th>
                    <th className="usage-num usage-col-last">{text.usageColLastUsed}</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="usage-table-empty">
                        {text.usageTableEmpty}
                      </td>
                    </tr>
                  ) : (
                    projects.map((project) => (
                      <tr key={project.id}>
                        <td className="usage-num usage-col-rank">{data.projects.indexOf(project) + 1}</td>
                        <td>
                          <div className="usage-project-name">
                            <i className="usage-swatch" style={colorStyle(project.id)} />
                            {projectLabel(project.id)}
                          </div>
                          {project.path && (
                            <div className="usage-project-path" title={project.path}>
                              {project.path}
                            </div>
                          )}
                        </td>
                        <td className="usage-num">{formatUsageMoney(project.costUsd)}</td>
                        <td className="usage-col-share">
                          <div className="usage-share">
                            <div className="usage-share-track">
                              <div className="usage-share-fill" style={{ width: `${(100 * project.costUsd) / maxProjectCost}%` }} />
                            </div>
                            <span>{formatPercent(project.share)}</span>
                          </div>
                        </td>
                        <td className="usage-num">{formatUsageTokens(project.tokens)}</td>
                        <td className="usage-col-models usage-models">
                          {summarizeUsageFamilies(
                            project.costByFamily,
                            project.costUsd,
                            (family) => (text.usageFamilyLabels as Record<string, string>)[family] ?? family,
                          )}
                        </td>
                        <td className="usage-num">{project.sessions}</td>
                        <td className="usage-num">{project.prompts.toLocaleString('en-US')}</td>
                        <td className="usage-num usage-col-chars">{formatUsageTokens(project.promptChars)}</td>
                        <td className="usage-num usage-col-last">{formatUsageLastUsed(project.lastUsedAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="usage-note">{text.usagePriceNote(CLAUDE_PRICING_COPIED_ON)}</div>
          </div>
        </>
      ) : (
        <div className="stats-card-placeholder" />
      )}
    </div>
  )
}
