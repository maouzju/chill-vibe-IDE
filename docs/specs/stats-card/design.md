# Stats Card — Design

## 总览

```
shared/models.ts            STATS_TOOL_MODEL + MODEL_OPTIONS 条目 + TOOL_CARD_MODELS
shared/schema.ts            settings.experimentalStatsEnabled
shared/default-state.ts     默认值 / normalize / quick-tool 名单 / 卡片尺寸
shared/i18n.ts              zh-CN + en 文案
src/stats-card-metrics.ts   ★ 纯函数聚合 + 热力图周列布局（唯一有逻辑的地方，可单测）
src/stats-card-source.ts    ★ 模块级快照源（绕开 props 记忆化链）
src/components/StatsCard.tsx   StatsCard（取数+节流） + StatsCardView（纯展示）
src/components/Icons.tsx    ChartIcon
src/components/ChatCard.tsx 渲染分支 / 空态条目 / 图标 / 标题
src/components/PaneView.tsx tab 图标 / 无 composer
src/App.tsx                 设置面板两份开关 + publishStatsSource
src/state.ts                updateSettings patch 白名单
src/index.css               样式 + 双主题 token
```

## 数据怎么到卡片手上

统计卡要看全板的 `columns` + `sessionHistory`，但它是一张普通卡片，"正规"途径是从 App
一路 props 传到 `ChatCard`。那条链上每一层都做了引用记忆化
（`src/components/layout-memoization.ts`），把每帧都换引用的 `columns` 塞进去等于给所有
pane/tab 的 memo 判等永久投毒（pitfall 265）。

所以走 `src/stats-card-source.ts` 的模块级快照：App 里一个 effect 做 O(1) 赋值，卡片
每 30 秒主动来取。统计卡是只读旁观者，本来就不需要参与 React 的更新传播。

## 数据聚合 —— `src/stats-card-metrics.ts`

### 输入

```ts
type StatsMetricsInput = {
  columns: readonly BoardColumn[]
  sessionHistory: readonly SessionHistoryEntry[]
  now: Date            // 注入，便于测试；组件传 new Date()
  rangeDays: number    // 90 | 180 | 365
}
```

### 输出

```ts
type StatsMetrics = {
  days: StatsDay[]          // 连续的每一天，长度 = rangeDays（含今天）
  maxCount: number          // 消息维度的分级基准
  maxSessions: number       // 会话维度的分级基准（两套各算各的，见「热力图分级」）
  totalSessions: number
  activeSessions: number    // 打开中的聊天卡
  archivedSessions: number
  sessionsLast7: number
  sessionsLast30: number
  totalMessages: number
  currentStreak: number
  longestStreak: number
  activeDays: number
  byProvider: { codex: number; claude: number }
  tokens: StatsTokens | null   // 无 telemetry 时为 null
  archivedSessionsWithoutUsage: number   // 归档过早、没留下 usageTotals 的条目数
}

type StatsDay = {
  date: string
  count: number         // 那一天的消息条数
  sessions: number      // 那一天**开始**的会话段数（打开中 + 已归档）
  level: 0|1|2|3|4        // 按 count 相对 maxCount 分档
  sessionLevel: 0|1|2|3|4 // 按 sessions 相对 maxSessions 分档
}
type StatsTokens = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  turns: number
  peakUsed: number          // 单轮占用最大值
  peakSize: number          // 那一轮对应的上下文窗口
  costUsd: number
}
```

### 归日规则

用**本地日期**（`YYYY-MM-DD`），不是 UTC。理由：用户看的是自己的作息，UTC 会让晚上
的工作跳到第二天。实现用一个 `toLocalDayKey(date)` 辅助，测试里用固定时区断言。

无效 / 缺失的 `createdAt`、`archivedAt` 一律跳过，不抛错。这是防御性的：老 state 里
存在过不合规的时间戳，统计卡绝不能因此炸掉整张板。

### 会话计数

- 打开中：`columns[].cards` 里 **不是工具卡**（`isToolCardModel` 为 false）的卡。
  工具卡（Git/便签/看板/本卡自己）不是"会话"，计入会虚高。
- 归档：`sessionHistory` 条目全部计入。
- `byProvider` 两边都统计。

### 会话落在哪一天（2026-08-21 修订）

一段会话按它的**开始日**落进 `day.sessions`，两条来源同一套规则：

```
sessionDayKey(entry) = parseDayKey(messages[0]?.createdAt) ?? parseDayKey(archivedAt)
```

- 归档条目的消息被裁成 8 条预览，但裁法是 `head 4 + tail 4`
  （`server/state-store.ts` 的 `createRendererSessionHistoryMessages`），`messages[0]`
  仍是全场最早那条，所以开始日拿得到，不需要任何新字段、新 IPC。
- 打开中的卡没有 `createdAt`（`chatCardSchema` 里就没有这个字段），同样取首条消息；
  一条消息都没有的空卡不落到任何一天。**被否决的替代**：用 `now` 把空卡塞进今天——
  日历会因此每天都亮一格，而那格背后没有任何真实活动。
- 归档段的 `messageCount` 跟着落到同一天。**被否决的替代**：会话数记开始日、消息数记
  归档日——同一格里两个数字来自不同的日子，tooltip 上会读成「3 条消息 · 0 段会话」这种
  自相矛盾的组合。

改这条之前的行为是「只有归档会话计入 `sessions`，且归在 `archivedAt`」，后果是今天新开
的会话在日历上恒为 0 段（它还没归档），跨天的长会话整段记在关掉的那天。

### 热力图分级

`level` 用相对分位而不是绝对阈值：`0` 表示 `count === 0`，其余按
`count / maxCount` 落在 `(0, .25] .25-.5 .5-.75 .75-1` 四档。绝对阈值在轻用户那里会
永远全是 level 1。

`sessionLevel` 用同一个函数，但基准是 `maxSessions` 而不是 `maxCount`。**两套基准不能
合并**：一天的消息数是几十上百、会话段数是个位数，共用 `maxCount` 会让整张会话图除了
最忙那天全部塌到 level 1，切过去等于看一张全灰的图。

### token 汇总

两条来源，累加进同一个 `StatsTokens`：

1. **打开中的会话**：复用 `readTurnTelemetry`（`shared/turn-telemetry-summary.ts`），
   对每张聊天卡的每条消息调用。
2. **归档会话**：读条目上的 `usageTotals`。这份汇总由同模块的 `summarizeTurnUsage`
   在归档那一刻算好（`shared/default-state.ts` 的 `createSessionHistoryEntry`）——
   统计卡这边**不重扫归档消息**，因为送到渲染进程的归档消息早已被剥掉 `meta`。

**两种字段两种合并方式**（2026-08-16 实证，AGENTS.md pitfall 322）：

| 字段 | 上游语义 | 会话内 | 跨会话 |
|------|----------|--------|--------|
| `input/output/cacheRead/cacheCreation/turns` | 每一轮各自的量 | 求和 | 求和 |
| `costUsd`（Claude `total_cost_usd`） | **到目前为止的累计** | 取最大值 | 求和 |
| `peakUsed/peakSize` | 那一回合内所有 API 请求的 token 之和 | 取最大 | 取最大 |

`costUsd` 求和过一次：实测一段三轮会话逐轮报 120.592 / 120.857 / 121.433 美元，加起来
362.88，真值 121.43。会话内取最大值而不是取最后一条——compact / 换 session 会把累计清零
重来（实测见过 15.83 → 7.87），取最后一条会让花费凭空缩水。

`peakUsed` 不是"上下文占用"：多步 agent 回合每一步都重读缓存，累加下来能到 2 亿而窗口
只有 20 万。所以 UI 只在 `peakUsed <= peakSize` 时画占比条，超出时只报数值——数字是真的，
占比不是。

没有任何一条带 usage 时返回 `null`，UI 显示"暂无数据"，不显示 0 —— 0 会被误读成
"没花 token"。

模块位置注记：`turn-telemetry-summary` 2026-08-16 从 `src/` 移到 `shared/`，因为归档
汇总发生在 `shared/default-state.ts` 里，而 `shared/` 不能反向依赖 `src/`。原路径留了
一个 re-export，既有 import 无需改动。

### 存量归档的补偿

2026-08-16 之前归档的条目没有 `usageTotals`。`server/state-store.ts` 的
`renderSessionHistoryForRenderer` 在剥 meta 前补算一次——那是完整转录的最后一站。
刻意**只在转录完整时**补（`hasCompleteMessages`）：预览态算出来的是残值，给一个偏低的
数字比不给数字更糟。补不上的条目计入 `archivedSessionsWithoutUsage`，UI 明示缺口。

## 性能设计

聚合本身是 O(消息总数)。大 profile 下这可能是数万条，不能挂在渲染路径上。

`StatsCard` 内：

```
useState<StatsMetrics | null>  ← 结果快照
useEffect: 计算一次（挂载时立即），随后 setInterval 每 RECOMPUTE_INTERVAL_MS 重算
```

- **不**把 `columns` 放进 `useMemo` 依赖 —— 流式期间 `columns` 每次 delta 都换引用，
  useMemo 会退化成每帧全量遍历。
- 重算间隔 30s，外加 `visibilitychange` 时若已超时则补一次（与 WeatherCard 同型）。
- 组件在 `ChatCard` 里按 `&& !isCollapsed` 挂载 —— 折叠即卸载，定时器随之清掉。

计算用 `requestIdleCallback`（有则用，无则 `setTimeout(0)`）让出主线程，避免统计卡把
一次 30s 的重算压在用户输入的那一帧上。

## 组件结构

```
.stats-card
  .stats-card-summary        4 个概览格子（会话 / 消息 / 连续天数 / 活跃天数）
  .stats-card-heatmap
    .stats-heatmap-months    月份标签（绝对定位，按列索引 × 格距）
    .stats-heatmap-body
      .stats-heatmap-weekdays  周几标签（隔行显示）
      .stats-heatmap-grid      N 列 × 7 行，列 = 周
        .stats-heatmap-cell[data-level=0..4]  title=tooltip
    .stats-heatmap-footer    口径切换 消息/会话 + 范围切换 3M / 6M / 1Y + Less ▢▢▢▢▢ More
  .stats-card-footer
    .stats-provider-row      provider 分布
    .stats-tokens            token 块（无数据时显示占位文案）
```

热力图按 GitHub 布局：每列一周，周日在最上。首列不满 7 天用 `null` 占位（不是把日期
往前补——补出来的日子不属于所选范围，鼠标停上去会显示假数据）。默认范围是**一年**，
和 GitHub 贡献图一致。

### 口径切换（消息 / 会话）

`StatsHeatMetric = 'messages' | 'sessions'`，`useState` 存在 `StatsCard` 里，默认
`'messages'`。`StatsCardView` 收 `heatMetric` / `onHeatMetricChange` 两个 prop，跟范围
切换一模一样的形状——纯展示层仍然不持有业务状态，测试可以直接喂一个受控值。

常量和类型放在 `src/stats-card-metrics.ts` 而不是组件文件里：组件文件多一个**值**导出就会
被 `react-refresh/only-export-components` 拦下（`statsRangeDayCounts` 当初也是这么放的）。

两组按钮共用 `.stats-range-button` 皮肤，所以各带一个 `data-picker="metric" | "range"`
——否则「当前选中的那一个」这类断言会同时命中两组（真实踩到，见 pitfall 336 邻居）。

格子只换读哪个字段：`data-level={metric === 'sessions' ? cell.sessionLevel : cell.level}`。
**两套等级都在 `computeStatsMetrics` 里一次算完**，切换不触发重算——重算走的是 30s 定时
+ 空闲帧那条路（见「性能」），点一下按钮就重扫全板消息会把这套节流白白绕过去。

### 格子尺寸自适应

格子写死尺寸会让宽卡上的日历只占左边一小条。自适应**全部交给 CSS，JS 一行不写**：

```
列宽  grid-template-columns: repeat(N, minmax(下限, 上限))   ← 让 CSS 自己拉伸
列高  aspect-ratio: 1 / 7                                    ← 锁死成 7 个正方形
间距  格子自身 padding + background-clip: content-box        ← 不能用 gap
```

列数 N 通过 CSS 变量传入，是所选范围唯一需要 JS 参与的量。

被否决的替代 A：`ResizeObserver` 量宽度再算格子尺寸。能用，但 observer 回调里
`setState` 撞 `react-hooks/set-state-in-effect`，而且首帧 `metrics` 还是 null、走的是
loading 早退分支，`useRef` 上根本没有节点，observer 从未安装，日历永远停在最小格子上
（开发中真实踩到，已记进 AGENTS.md pitfall #316）。改用 callback ref 能修好时序，
但为一个纯排版问题引入两个坑不值得。

被否决的替代 B：`repeat(N, 1fr)` + `gap`。列宽弹性而行高固定，方块会被拉成竖条——
方块是这个图形的全部意义。同理间距不能用 `gap`，它会破坏 1:7 的比例。

放不下时（例：560px 卡片装一年 = 53 列）`.stats-heatmap-scroll` 横向滚动，
但绝不越过卡片边界——有 Playwright 断言守着。

## 主题

新增 token（`src/index.css` `:root`，暗色在 `:root[data-theme='dark']` 覆盖）：

```
--stats-heat-0 .. --stats-heat-4
--stats-card-bg
--stats-card-tile-bg
```

暗色覆盖必须写成 `:root[data-theme='dark'] { --stats-heat-0: ... }` 这种变量重定义，
而不是 `:root[data-theme='dark'] .stats-heatmap-cell` 选择器覆盖 —— 后者踩 pitfall 264
的特异性坑。

## 风险与规避

| 风险 | 规避 |
|------|------|
| 新工具模型漏进 `TOOL_CARD_MODELS` → 空壳卡传染（pitfall 263） | 单测断言名单包含 `__stats_tool__`，且 `resolveSlashModel` 不产出它 |
| 大 state 下遍历卡帧 | 节流 + idle callback + 折叠卸载 |
| 老 state 里的坏时间戳 | 聚合函数逐条 try/skip，测试覆盖 |
| token 无数据被显示成 0 | 返回 `null` 而非 0，UI 分支处理 |
| 存量归档缺用量，总数偏低却看不出来 | 计数 `archivedSessionsWithoutUsage`，UI 明示「N 段归档过早，没留下用量」 |
| 预览态归档条目被误当完整转录去补算，得出残值 | `renderSessionHistoryForRenderer` 只在 `hasCompleteMessages` 时补 |
