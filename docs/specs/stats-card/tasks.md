# Stats Card — Tasks

## Slice 1 — 聚合逻辑（红→绿 TDD）✅
- [x] 写 `tests/stats-card-metrics.test.ts`，确认失败（模块不存在）。
- [x] 实现 `src/stats-card-metrics.ts`（聚合 + 热力图周列布局 + 月份标签）。
- [x] 注册进 `tests/index.test.ts`（Slice 5 之后共 24 条，全绿）。

## Slice 2 — 模型 / 设置 / 文案接线 ✅
- [x] `shared/models.ts`：`STATS_TOOL_MODEL`、MODEL_OPTIONS、`TOOL_CARD_MODELS`。
- [x] `shared/schema.ts`：`experimentalStatsEnabled`（settingsSchema + 默认值副本）。
- [x] `shared/default-state.ts`：默认值、normalize、`isQuickToolModelEnabled`、
      `quickToolModelsInOrder`、卡片最小/默认尺寸。
- [x] `src/state.ts`：`updateSettings` patch 白名单。
- [x] `shared/i18n.ts`：zh-CN + en 文案。
- [x] `tests/models.test.ts`：补一条**遍历全部工具模型**的 pitfall-263 守卫，
      新增工具卡时只需在那张表里加一行。

## Slice 3 — UI ✅
- [x] `src/components/Icons.tsx`：`ChartIcon`。
- [x] `src/stats-card-source.ts` + `src/components/StatsCard.tsx`（含 `StatsCardView`）。
- [x] `src/components/ChatCard.tsx` / `PaneView.tsx` / `App.tsx` 接线。
- [x] `src/index.css`：样式 + 双主题 token。

## Slice 4 — 验证 ✅
- [x] `pnpm test:quality`
- [x] `pnpm test`（全量 Node 全绿）
- [x] `pnpm exec playwright test tests/theme-check.spec.ts tests/stats-card-theme.spec.ts`
      全绿；设置面板快照因为多了一行开关而变高，已刻意刷新（布局断言本就通过）

> ⚠️ 上面两条是 Slice 4 当时的证据，**只对 stats-card 这一个 slice 成立**。同一个工作树里
> 还并行着 minimize-on-close（"实用"组开关换成三选一下拉）与 hover-hints（`.settings-hover-detail`
> 定位壳改了整片面板行距，见 AGENTS.md pitfall #315），所以 v0.20.6 实际刷新的是
> `theme-check` 的 16 张（8 组 × 明暗）与 `tool-card-settings` 的 4 张，后者同时承载了
> stats 开关与看板去掉「实验性」后缀两处改动。别拿这一节的数字当漂移基线，以发布门禁为准。
- [x] `tests/stats-card-render.test.tsx`：对真实 metrics 做 SSR 渲染断言
      （热力图格子数、分级、tooltip、token 块、中英文）
- [x] `tests/stats-card-theme.spec.ts`：亮/暗/窄卡三张截图 + 范围切换 + 溢出边界，
      并挂进 `scripts/run-playwright-specs.ps1` 的 theme 套件
- [x] `pnpm electron:build`

## Slice 5 — 归档会话的 token 用量 ✅（2026-08-16）

起因：用户看到「仅统计当前打开的会话（归档会话不保留用量数据）」这句免责声明，评价是
「统计卡片设计的一点不专业，都看不了用量」。这正是原「后续可做」的第一条。

- [x] `shared/schema.ts`：新增 `sessionUsageTotalsSchema`，挂到
      `sessionHistoryEntrySchema.usageTotals`（8 个标量，体积与消息条数无关）。
- [x] `src/turn-telemetry-summary.ts` → `shared/turn-telemetry-summary.ts`：归档汇总要在
      `shared/default-state.ts` 里做，而 `shared/` 不能依赖 `src/`。原路径留 re-export。
- [x] `shared/turn-telemetry-summary.ts`：新增 `summarizeTurnUsage(messages)`，
      一轮都没有 usage 时返回 `null`（让「没数据」与「全是 0」可分辨）。
- [x] `shared/default-state.ts`：`createSessionHistoryEntry` 在归档那一刻算好
      `usageTotals` —— 那是消息 `meta` 还完整的最后一刻。
- [x] `server/state-store.ts`：`renderSessionHistoryForRenderer` 为存量条目补算一次，
      只在转录完整（`hasCompleteMessages`）时补。
- [x] `src/stats-card-metrics.ts`：归档 `usageTotals` 累加进 `tokens`；补不上的计入
      `archivedSessionsWithoutUsage`。`peakUsed/peakSize` 跨会话取最大值不求和。
- [x] `shared/i18n.ts` + `src/components/StatsCard.tsx`：`statsTokensScopeHint` 由定值
      文案改成 `(missing, cap) => string`，从免责声明变成范围说明。**口径要写全**：
      只写「含已归档会话」会让人以为是全部历史，实际是每个工作区最近 50 段
      （`maxSessionHistoryPerWorkspace`）——用户随即就问了「50 条是谁定的、为什么不
      全部保留」。真实答案是**全都保留了**，只是不在这份索引里（见 requirements FR-3）。
- [x] 测试（红 → 绿）：`tests/default-state.test.ts` 归档汇总两条、
      `tests/stats-card-metrics.test.ts` 累加两条、`tests/state-store.test.ts` 存量补算一条、
      `tests/stats-card-render.test.tsx` 文案两条。
- [x] `pnpm test:quality`、`tests/stats-card-theme.spec.ts` 快照。

### Slice 5 途中查真实归档时抓到的两个既有错数（同批修掉）

翻用户机器上的 `session-history` sidecar 做实证时发现的，与归档覆盖无关但同属"数字不可信"：

- [x] **花费被重复累加**：`turnUsageCostUsd` 是会话累计值，逐轮求和把一段三轮会话
      从 121.43 美元算成 362.88。改成会话内取最大值、跨会话求和
      （`mergeRunningCost` + `foldSessionUsage`）。
- [x] **峰值条永远顶满**：`used` 是一个回合内所有 API 请求的 token 之和（实测 2.02 亿
      对 20 万窗口），被 `Math.min(1, …)` 夹成 100%。改成只在 `peakUsed <= peakSize`
      时画条，超出只报数值。
- [x] 两条都有红→绿测试：`tests/provider-turn-telemetry.test.ts`（累计 / 重置两种形态）、
      `tests/stats-card-metrics.test.ts`（跨会话求和）、`tests/stats-card-render.test.tsx`
      （超窗口不画条）。

## Slice 6 — 日历看得见每天开了几段会话（2026-08-21）

用户："统计项目需要能看日历里面每天的会话数量"。查下来不是"没做"而是"做了但看不见
也不对"：`day.sessions` 只统计归档会话、且归在 `archivedAt` 那天，于是今天新开的会话
在日历上恒为 0；而 tooltip 只在 `sessions > 0` 时才带出会话数，用户 hover 今天永远
只看得到消息数。

- [x] 红：`tests/stats-card-metrics.test.ts` —— 打开中的会话按首条消息计入
      `day.sessions`；归档会话落在开始日而不是归档日；空卡不落到任何一天；
      `sessionLevel` 用 `maxSessions` 分档（会话数被消息数压平的回归）。
- [x] 红：`tests/stats-card-render.test.tsx` —— tooltip 恒带会话数（含 0）；
      切到「会话」口径后格子读 `sessionLevel`。
- [x] 绿：`src/stats-card-metrics.ts` —— 抽 `resolveSessionCalendarDayKey`（日历归属日）
      与 `resolveSessionRecencyDayKey`（活跃/最近 N 天），两条来源各自共用；
      `StatsDay` 增 `sessionLevel`，`StatsMetrics` 增 `maxSessions`。
      注：归日规则只作用于日历格；连击与「最近 7/30 天」仍按会话收尾时刻计。
- [x] `shared/i18n.ts` —— `statsHeatmapTooltip` 去掉 `sessions > 0` 分支；新增
      `statsHeatMetricLabel` / `statsHeatMetricMessages` / `statsHeatMetricSessions`。
- [x] `src/components/StatsCard.tsx` + `src/index.css` —— 脚注加口径切换，复用
      `.stats-range-button` 的皮肤，窄卡下能换行。
- [x] `pnpm test:quality`、`tests/stats-card-theme.spec.ts` 快照。

## 后续可做（未做，非阻塞）
- 真·全局历史：`~/.claude/projects` 与 `~/.codex` 里的会话是更完整的数据源，但需要一个
  全局扫描端点，风险见 requirements.md 的 FR-3。
- 存量归档中 sidecar 已丢失的条目永远补不回用量，只能一直计入
  `archivedSessionsWithoutUsage`。可接受：随着新归档积累，这个数字只减不增。
