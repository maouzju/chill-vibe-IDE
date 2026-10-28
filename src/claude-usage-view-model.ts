/**
 * 统计卡「全部 Claude 用量」视图的纯函数：时段预设、格式化、柱状图几何、表格筛选。
 * 不依赖 React，组件只负责画（docs/specs/claude-usage-ledger design「前端」）。
 */

export const claudeUsagePresets = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'all'] as const
export type ClaudeUsagePreset = (typeof claudeUsagePresets)[number]

export const claudeUsageMetrics = ['cost', 'tokens', 'prompts', 'promptChars'] as const
export type ClaudeUsageMetric = (typeof claudeUsageMetrics)[number]

/** 柱状图里"其余项目"的合成 id；不会与真实项目撞名（真实 id 来自目录名或 `(xxx)`）。 */
export const OTHER_PROJECT_ID = '__other__'

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value))

export const toUsageDayKey = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

const shiftDays = (date: Date, days: number) => {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

export const resolveUsagePresetRange = (preset: ClaudeUsagePreset, now: Date): { from: string; to: string } => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (preset) {
    case 'today':
      return { from: toUsageDayKey(today), to: toUsageDayKey(today) }
    case 'yesterday': {
      const day = shiftDays(today, -1)
      return { from: toUsageDayKey(day), to: toUsageDayKey(day) }
    }
    case 'last7':
      return { from: toUsageDayKey(shiftDays(today, -6)), to: toUsageDayKey(today) }
    case 'last30':
      return { from: toUsageDayKey(shiftDays(today, -29)), to: toUsageDayKey(today) }
    case 'thisMonth':
      return { from: toUsageDayKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: toUsageDayKey(today) }
    case 'lastMonth':
      return {
        from: toUsageDayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        to: toUsageDayKey(new Date(today.getFullYear(), today.getMonth(), 0)),
      }
    case 'all':
      return { from: '2000-01-01', to: toUsageDayKey(today) }
  }
}

export const formatUsageMoney = (value: number) =>
  `$${value.toLocaleString('en-US', {
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })}`

/** 坐标轴用的短金额：$6.0k / $120 / $3.20 */
export const formatUsageMoneyShort = (value: number) =>
  value >= 1000
    ? `$${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : value >= 10
      ? `$${value.toFixed(0)}`
      : `$${value.toFixed(2)}`

export const formatUsageTokens = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`
  return String(Math.round(value))
}

export const formatUsageCount = (value: number) => (value >= 1000 ? formatUsageTokens(value) : String(Math.round(value)))

export const formatUsageMetricValue = (metric: ClaudeUsageMetric, value: number) => {
  switch (metric) {
    case 'cost':
      return formatUsageMoney(value)
    case 'tokens':
    case 'promptChars':
      return formatUsageTokens(value)
    case 'prompts':
      return Math.round(value).toLocaleString('en-US')
  }
}

export const formatUsageAxisValue = (metric: ClaudeUsageMetric, value: number) => {
  switch (metric) {
    case 'cost':
      return formatUsageMoneyShort(value)
    case 'tokens':
    case 'promptChars':
      return formatUsageTokens(value)
    case 'prompts':
      return formatUsageCount(value)
  }
}

const niceStep = (value: number) => {
  const power = Math.pow(10, Math.floor(Math.log10(value || 1)))
  const scaled = value / power
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power
}

export type UsageChartSegment = {
  project: string
  value: number
  /** `colorOrder` 里的下标；-1 = 其他 */
  colorIndex: number
  y: number
  height: number
}

export type UsageChartDay = {
  key: string
  x: number
  width: number
  total: number
  segments: UsageChartSegment[]
  /** 原始明细（提示框用），按值降序 */
  breakdown: Array<{ project: string; value: number }>
  labelVisible: boolean
}

export type UsageChart = {
  width: number
  height: number
  padding: { left: number; right: number; top: number; bottom: number }
  days: UsageChartDay[]
  ticks: Array<{ value: number; y: number }>
  maxValue: number
  /** 图例：实际出现过的项目，按 colorOrder 顺序，其他垫底 */
  legend: Array<{ project: string; colorIndex: number }>
}

export const chartPadding = { left: 46, right: 8, top: 10, bottom: 22 }

export const buildUsageChart = ({
  daily,
  from,
  to,
  colorOrder,
  width,
  height,
  isMoney = false,
}: {
  daily: Record<string, Record<string, number>>
  from: string
  to: string
  colorOrder: readonly string[]
  width: number
  height: number
  isMoney?: boolean
}): UsageChart => {
  const dayKeys = Object.keys(daily).sort()
  let start = from
  if (dayKeys.length > 0 && dayKeys[0]! > start) start = dayKeys[0]!

  const keys: string[] = []
  const parse = (key: string) => {
    const [year, month, day] = key.split('-').map(Number)
    return new Date(year!, month! - 1, day!)
  }
  for (let cursor = parse(start); toUsageDayKey(cursor) <= to && keys.length < 5000; cursor = shiftDays(cursor, 1)) {
    keys.push(toUsageDayKey(cursor))
  }

  const padding = chartPadding
  const plotWidth = Math.max(1, width - padding.left - padding.right)
  const plotHeight = Math.max(1, height - padding.top - padding.bottom)
  const barWidth = plotWidth / Math.max(1, keys.length)
  const gap = Math.min(4, barWidth * 0.25)

  const totals = keys.map((key) => Object.values(daily[key] ?? {}).reduce((sum, value) => sum + value, 0))
  const maxValue = Math.max(...totals, 0)
  const step = Math.max(niceStep(Math.max(maxValue, 1) / 4), isMoney ? 0 : 1)
  const axisMax = Math.max(step, Math.ceil(Math.max(maxValue, 1e-9) / step) * step)
  const yOf = (value: number) => padding.top + plotHeight * (1 - value / axisMax)

  const labelEvery = Math.max(1, Math.ceil(keys.length / Math.max(1, Math.floor(plotWidth / 56))))
  const usedProjects = new Set<string>()
  let usesOther = false

  const days: UsageChartDay[] = keys.map((key, index) => {
    const raw = daily[key] ?? {}
    const grouped = new Map<string, number>()
    for (const [project, value] of Object.entries(raw)) {
      const slot = colorOrder.includes(project) ? project : OTHER_PROJECT_ID
      grouped.set(slot, (grouped.get(slot) ?? 0) + value)
      if (value > 0) {
        if (slot === OTHER_PROJECT_ID) usesOther = true
        else usedProjects.add(slot)
      }
    }
    const ordered = [...colorOrder.filter((project) => grouped.has(project)), ...(grouped.has(OTHER_PROJECT_ID) ? [OTHER_PROJECT_ID] : [])]
    let acc = 0
    const segments: UsageChartSegment[] = []
    for (const project of ordered) {
      const value = grouped.get(project) ?? 0
      if (value <= 0) continue
      const y0 = yOf(acc)
      const y1 = yOf(acc + value)
      acc += value
      segments.push({
        project,
        value,
        colorIndex: project === OTHER_PROJECT_ID ? -1 : colorOrder.indexOf(project),
        y: y1,
        height: Math.max(0, y0 - y1),
      })
    }
    return {
      key,
      x: padding.left + index * barWidth + gap / 2,
      width: Math.max(1, barWidth - gap),
      total: totals[index]!,
      segments,
      breakdown: Object.entries(raw)
        .filter(([, value]) => value > 0)
        .sort((left, right) => right[1] - left[1])
        .map(([project, value]) => ({ project, value })),
      labelVisible: index % labelEvery === 0,
    }
  })

  const ticks: Array<{ value: number; y: number }> = []
  for (let value = 0; value <= axisMax + 1e-9; value += step) {
    ticks.push({ value, y: yOf(value) })
  }

  const legend = [
    ...colorOrder
      .filter((project) => usedProjects.has(project))
      .map((project) => ({ project, colorIndex: colorOrder.indexOf(project) })),
    ...(usesOther ? [{ project: OTHER_PROJECT_ID, colorIndex: -1 }] : []),
  ]

  return { width, height, padding, days, ticks, maxValue, legend }
}

export const filterUsageProjects = <T extends { id: string; path: string | null }>(
  projects: readonly T[],
  query: string,
  labelOf: (id: string) => string,
): T[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...projects]
  return projects.filter(
    (project) =>
      project.id.toLowerCase().includes(needle) ||
      labelOf(project.id).toLowerCase().includes(needle) ||
      (project.path ?? '').toLowerCase().includes(needle),
  )
}

/** 项目表「模型构成」列：按费用降序，占比不足 1% 的不列。 */
export const summarizeUsageFamilies = (
  costByFamily: Partial<Record<string, number>>,
  totalCost: number,
  labelOf: (family: string) => string,
) =>
  Object.entries(costByFamily)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .filter(([, cost]) => totalCost > 0 && cost / totalCost >= 0.01)
    .map(([family, cost]) => `${labelOf(family)} ${Math.round((100 * cost) / totalCost)}%`)
    .join(' · ')

/** `2026-10-27T11:26:00.000Z` → 本地 `10-27 19:26` */
export const formatUsageLastUsed = (iso: string | null) => {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}
