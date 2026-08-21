import { isToolCardModel } from '../shared/models'
import type {
  BoardColumn,
  ChatMessage,
  SessionHistoryEntry,
  SessionUsageTotals,
} from '../shared/schema'
import { summarizeTurnUsage } from '../shared/turn-telemetry-summary'

/**
 * 统计卡的全部聚合逻辑。刻意做成不依赖 React 的纯函数：卡片本身只负责画。
 *
 * 数据口径见 docs/specs/stats-card/requirements.md 的 FR-3。一句话版本：
 * 只吃渲染进程内存里已有的东西，不碰磁盘、不发 IPC。想要"真·全量历史"就得去扫
 * ~/.claude 和 ~/.codex 下的全部 .jsonl，那正是本仓库长期 bug「用久了卡死」的形状
 * （AGENTS.md pitfall 48 / 54 / 55），一张统计卡不值得。
 */

export const statsRangeDayCounts = [90, 180, 365] as const

export type StatsRangeDays = (typeof statsRangeDayCounts)[number]

/**
 * 日历按哪个口径着色。跟 `statsRangeDayCounts` 一样只是卡片内的视图状态，不落盘。
 * 放在这里而不是组件文件里：组件文件多一个值导出就会被 `react-refresh/only-export-components`
 * 拦下，而这两套等级本来就是这个模块算的。
 */
export const statsHeatMetrics = ['messages', 'sessions'] as const

export type StatsHeatMetric = (typeof statsHeatMetrics)[number]

export type StatsHeatLevel = 0 | 1 | 2 | 3 | 4

export type StatsDay = {
  /** 本地日期 `YYYY-MM-DD`。 */
  date: string
  /** 这一天的消息条数。 */
  count: number
  /** 这一天**开始**的会话段数（打开中的卡 + 已归档的会话）。 */
  sessions: number
  /** 按 `count` 相对 `maxCount` 的分档。 */
  level: StatsHeatLevel
  /** 按 `sessions` 相对 `maxSessions` 的分档 —— 基准与消息维度分开，见 `toHeatLevel` 上方。 */
  sessionLevel: StatsHeatLevel
}

export type StatsTokens = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 带 usage 的回合数。 */
  turns: number
  /** 单轮上下文占用的峰值。 */
  peakUsed: number
  /** 峰值那一轮对应的上下文窗口大小；未知为 0。 */
  peakSize: number
  costUsd: number
}

export type StatsMetrics = {
  days: StatsDay[]
  maxCount: number
  /**
   * 会话维度的分档基准，与 `maxCount` 分开。
   * 症状：共用 `maxCount` 时，整张会话图除了最忙那天全塌成最浅一档。
   * 根因：一天的消息数是几十上百、会话段数是个位数，同一个分母下会话永远落在
   *   `ratio <= 0.25` 那一档。
   */
  maxSessions: number
  totalSessions: number
  activeSessions: number
  archivedSessions: number
  sessionsLast7: number
  sessionsLast30: number
  totalMessages: number
  currentStreak: number
  longestStreak: number
  activeDays: number
  byProvider: { codex: number; claude: number }
  /**
   * 覆盖打开中的会话 + 归档时汇总过用量的历史会话。
   * 更早的存量归档没有 `usageTotals`，只能缺席（见 SPEC FR-3）。
   */
  tokens: StatsTokens | null
  /** 有多少条历史会话因为归档得太早、没留下用量而没能计入 `tokens`。 */
  archivedSessionsWithoutUsage: number
}

export type StatsMetricsInput = {
  columns: readonly BoardColumn[]
  sessionHistory: readonly SessionHistoryEntry[]
  now: Date
  rangeDays: number
}

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value))

/**
 * 归到**本地**日期而不是 UTC：用户看的是自己的作息，UTC 会把晚上 8 点之后的活儿
 * 全推到第二天去（CST+8 下每天有 8 小时被算错）。
 */
export const toLocalDayKey = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

const parseDayKey = (value: string | undefined | null): string | null => {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return toLocalDayKey(parsed)
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

const toHeatLevel = (count: number, maxCount: number): StatsHeatLevel => {
  if (count <= 0 || maxCount <= 0) {
    return 0
  }

  // 相对分位而不是绝对阈值：轻度使用者用绝对阈值会永远停在第一档，热力图就成了摆设。
  const ratio = count / maxCount
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

type DayBucket = { count: number; sessions: number }

/**
 * 一段会话落在哪一天 = 它**开始**那天，两条来源（打开中的卡 / 已归档条目）共用这一条。
 *
 * 症状（2026-08-21 用户报"日历看不到每天的会话数量"）：今天新开的会话在日历上恒为
 *   0 段——它还没归档；而一段昨天开、今天才关的会话整段记在今天。
 * 根因：`sessions` 此前只由 `sessionHistory` 贡献，且归在 `archivedAt` 那天。
 * 为什么拿得到开始日：归档条目送进渲染进程时消息被裁成 8 条预览，但裁法是
 *   `head 4 + tail 4`（`server/state-store.ts` 的 `createRendererSessionHistoryMessages`），
 *   `messages[0]` 仍是全场最早那条。所以零新字段、零新 IPC。
 * 被否决的替代：没有可用开始时间时用 `now` 兜底——日历会因此每天亮一格，而那格背后
 *   没有任何真实活动。这里对打开中的空卡返回 null（不落到任何一天），归档条目则退回
 *   `archivedAt`（偏晚好过消失）。
 */
const resolveSessionDayKey = (
  messages: readonly ChatMessage[] | undefined,
  fallback?: string,
): string | null => parseDayKey(messages?.[0]?.createdAt) ?? parseDayKey(fallback)

const bumpDay = (buckets: Map<string, DayBucket>, dayKey: string, count: number, sessions: number) => {
  const bucket = buckets.get(dayKey)
  if (bucket) {
    bucket.count += count
    bucket.sessions += sessions
    return
  }
  buckets.set(dayKey, { count, sessions })
}

/**
 * 把**一段会话**的汇总并进全局累加器。
 *
 * 分成两步（先按会话汇总，再并进全局）不是为了好看：`costUsd` 是会话累计花费，
 * 只能在会话内取终值、跨会话才求和；token 计数则是每轮各自的量，两级都求和。
 * 混在一个循环里做就会把花费翻好几倍（见 shared/turn-telemetry-summary.ts 的
 * mergeRunningCost）。打开中的卡和归档条目都走这一条路，口径才对得上。
 */
const foldSessionUsage = (totals: SessionUsageTotals, accumulator: StatsTokens) => {
  accumulator.turns += totals.turns
  accumulator.input += totals.input
  accumulator.output += totals.output
  accumulator.cacheRead += totals.cacheRead
  accumulator.cacheCreation += totals.cacheCreation
  accumulator.costUsd += totals.costUsd

  if (totals.peakUsed > accumulator.peakUsed) {
    accumulator.peakUsed = totals.peakUsed
    accumulator.peakSize = totals.peakSize
  }
}

const collectTokens = (messages: readonly ChatMessage[], accumulator: StatsTokens) => {
  const totals = summarizeTurnUsage(messages)
  if (totals) {
    foldSessionUsage(totals, accumulator)
  }
}

export type StatsHeatColumn = { key: string; cells: Array<StatsDay | null> }

export const statsWeekdayRows = 7

/**
 * 按 GitHub 的排法切成周列：每列 7 格，周日在最上。首列不满 7 天时用 `null` 占位，
 * 而不是把日期往前补——补出来的日子不属于所选范围，鼠标停上去会显示假数据。
 */
export const buildStatsHeatColumns = (days: readonly StatsDay[]): StatsHeatColumn[] => {
  if (days.length === 0) {
    return []
  }

  const columns: StatsHeatColumn[] = []
  let current: Array<StatsDay | null> = []

  const firstWeekday = new Date(`${days[0].date}T00:00:00`).getDay()
  for (let index = 0; index < firstWeekday; index += 1) {
    current.push(null)
  }

  const flush = () => {
    while (current.length < statsWeekdayRows) {
      current.push(null)
    }
    columns.push({
      key: current.find((cell): cell is StatsDay => cell !== null)?.date ?? `col-${columns.length}`,
      cells: current,
    })
    current = []
  }

  for (const day of days) {
    current.push(day)
    if (current.length === statsWeekdayRows) {
      flush()
    }
  }

  if (current.length > 0) {
    flush()
  }

  return columns
}

export type StatsMonthLabel = { key: string; columnIndex: number; label: string }

export const buildStatsMonthLabels = (
  columns: readonly StatsHeatColumn[],
  monthNames: readonly string[],
): StatsMonthLabel[] => {
  const labels: StatsMonthLabel[] = []
  let lastMonth = -1

  columns.forEach((column, columnIndex) => {
    const firstDay = column.cells.find((cell): cell is StatsDay => cell !== null)
    if (!firstDay) {
      return
    }
    const month = Number(firstDay.date.slice(5, 7)) - 1
    if (month === lastMonth) {
      return
    }
    lastMonth = month
    labels.push({
      key: `${firstDay.date.slice(0, 7)}-${columnIndex}`,
      columnIndex,
      label: monthNames[month] ?? '',
    })
  })

  return labels
}

export const computeStatsMetrics = ({
  columns,
  sessionHistory,
  now,
  rangeDays,
}: StatsMetricsInput): StatsMetrics => {
  const dayBuckets = new Map<string, DayBucket>()
  const activeDayKeys = new Set<string>()

  let activeSessions = 0
  let totalMessages = 0
  const byProvider = { codex: 0, claude: 0 }

  const tokens: StatsTokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    turns: 0,
    peakUsed: 0,
    peakSize: 0,
    costUsd: 0,
  }

  for (const column of columns) {
    for (const card of Object.values(column.cards ?? {})) {
      // 工具卡（Git / 便签 / 看板 / 统计卡自己）不是会话，计进去会让数字凭空虚高。
      if (isToolCardModel(card.model)) {
        continue
      }

      activeSessions += 1
      if (card.provider === 'claude') {
        byProvider.claude += 1
      } else {
        byProvider.codex += 1
      }

      const messages = card.messages ?? []
      totalMessages += messages.length
      collectTokens(messages, tokens)

      const startDayKey = resolveSessionDayKey(messages)
      if (startDayKey) {
        bumpDay(dayBuckets, startDayKey, 0, 1)
      }

      for (const message of messages) {
        const dayKey = parseDayKey(message.createdAt)
        if (!dayKey) {
          continue
        }
        bumpDay(dayBuckets, dayKey, 1, 0)
        activeDayKeys.add(dayKey)
      }
    }
  }

  const todayKey = toLocalDayKey(now)
  const last7Cutoff = toLocalDayKey(addDays(now, -6))
  const last30Cutoff = toLocalDayKey(addDays(now, -29))

  let archivedSessions = 0
  let archivedSessionsWithoutUsage = 0
  let sessionsLast7 = 0
  let sessionsLast30 = 0

  // 打开中的卡也应该算进"最近 N 天"，否则今天刚开的会话在概览里是隐形的。
  for (const column of columns) {
    for (const card of Object.values(column.cards ?? {})) {
      if (isToolCardModel(card.model)) {
        continue
      }
      const latest = card.messages?.[card.messages.length - 1]
      const dayKey = parseDayKey(latest?.createdAt) ?? todayKey
      if (dayKey >= last7Cutoff) {
        sessionsLast7 += 1
      }
      if (dayKey >= last30Cutoff) {
        sessionsLast30 += 1
      }
    }
  }

  for (const entry of sessionHistory) {
    archivedSessions += 1
    if (entry.provider === 'claude') {
      byProvider.claude += 1
    } else {
      byProvider.codex += 1
    }

    const messageCount = entry.messageCount ?? entry.messages?.length ?? 0
    totalMessages += messageCount

    // 归档条目的消息在送进渲染进程时被剥掉了 meta，所以这里读的是归档那一刻存下来的
    // 汇总（shared/default-state.ts 的 createSessionHistoryEntry），而不是重扫消息。
    const archivedUsage = entry.usageTotals
    if (archivedUsage && archivedUsage.turns > 0) {
      foldSessionUsage(archivedUsage, tokens)
    } else {
      archivedSessionsWithoutUsage += 1
    }

    const dayKey = resolveSessionDayKey(entry.messages, entry.archivedAt)
    if (!dayKey) {
      // 坏时间戳只失去日历上的位置，会话本身仍然算数。老存档里确实出现过非法
      // archivedAt，统计卡绝不能因此炸掉整张板。
      continue
    }

    // 消息数跟着会话落到同一天。被否决的替代：会话记开始日、消息记归档日——同一格里
    // 两个数字来自不同的日子，tooltip 会读成「0 条消息 · 1 段会话」这种自相矛盾的组合。
    bumpDay(dayBuckets, dayKey, messageCount, 1)
    if (messageCount > 0) {
      activeDayKeys.add(dayKey)
    }
    if (dayKey >= last7Cutoff) {
      sessionsLast7 += 1
    }
    if (dayKey >= last30Cutoff) {
      sessionsLast30 += 1
    }
  }

  const safeRangeDays = Math.max(1, Math.round(rangeDays))
  const rangeStart = addDays(now, -(safeRangeDays - 1))

  const rawDays: Array<{ date: string; count: number; sessions: number }> = []
  let maxCount = 0
  let maxSessions = 0

  for (let index = 0; index < safeRangeDays; index += 1) {
    const date = addDays(rangeStart, index)
    const dayKey = toLocalDayKey(date)
    const bucket = dayBuckets.get(dayKey)
    const count = bucket?.count ?? 0
    const sessions = bucket?.sessions ?? 0
    if (count > maxCount) {
      maxCount = count
    }
    if (sessions > maxSessions) {
      maxSessions = sessions
    }
    rawDays.push({ date: dayKey, count, sessions })
  }

  const days: StatsDay[] = rawDays.map((day) => ({
    ...day,
    level: toHeatLevel(day.count, maxCount),
    sessionLevel: toHeatLevel(day.sessions, maxSessions),
  }))

  // streak 走全量活跃日集合，不受所选日历范围影响——切到"近 3 个月"不该让
  // 一条更长的连续记录凭空缩水。
  const sortedActiveDays = [...activeDayKeys].sort()
  let longestStreak = 0
  let runLength = 0
  let previousKey: string | null = null

  for (const dayKey of sortedActiveDays) {
    if (previousKey) {
      const [year, month, day] = previousKey.split('-').map(Number)
      const expected = toLocalDayKey(addDays(new Date(year, month - 1, day), 1))
      runLength = expected === dayKey ? runLength + 1 : 1
    } else {
      runLength = 1
    }
    if (runLength > longestStreak) {
      longestStreak = runLength
    }
    previousKey = dayKey
  }

  const yesterdayKey = toLocalDayKey(addDays(now, -1))
  let currentStreak = 0
  // 昨天收尾的连击仍然算"进行中"：今天还没过完，按 GitHub 的做法不提前判死。
  let cursor = activeDayKeys.has(todayKey) ? new Date(now) : activeDayKeys.has(yesterdayKey) ? addDays(now, -1) : null

  while (cursor) {
    const dayKey = toLocalDayKey(cursor)
    if (!activeDayKeys.has(dayKey)) {
      break
    }
    currentStreak += 1
    cursor = addDays(cursor, -1)
  }

  return {
    days,
    maxCount,
    maxSessions,
    totalSessions: activeSessions + archivedSessions,
    activeSessions,
    archivedSessions,
    sessionsLast7,
    sessionsLast30,
    totalMessages,
    currentStreak,
    longestStreak,
    activeDays: activeDayKeys.size,
    byProvider,
    tokens: tokens.turns > 0 ? tokens : null,
    archivedSessionsWithoutUsage,
  }
}
