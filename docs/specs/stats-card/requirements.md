# Stats Card — Requirements

## 背景

用户希望有一张「统计卡片」，一眼看到自己在 Chill Vibe 里的工作量：最近的会话数量、
消息量、上下文占用，以及一张类似 GitHub contribution graph 的每日工作量日历。

这是一张**实验性工具卡**（experimental tool card），默认关闭，需要在设置里打开。

## 用户故事

1. 作为用户，我打开「Stats」卡片，能看到一张按天着色的日历热力图，颜色越深表示那天
   的工作量越大；把鼠标停在某一格上能看到那天的具体数字。
2. 作为用户，我能看到几个概览数字：会话总数、最近 7 天 / 30 天的会话数、消息总数、
   连续活跃天数（streak）。
3. 作为用户，我能看到「上下文」相关的统计：当前打开的会话累计消耗的 token，以及占用
   最高的那次对话占了模型上下文窗口的多少。
4. 作为用户，我能按 Codex / Claude 看到会话分布。
5. 作为用户，我能切换热力图的时间范围（近 3 个月 / 近半年 / 近一年）。
6. 作为用户，我能把日历切成「按会话」着色，一眼看出哪几天开的会话多；无论切在哪一边，
   鼠标停在格子上都同时报出那天的消息条数和会话段数。

## 功能需求

### FR-1 卡片注册
- 新工具模型令牌 `__stats_tool__`，label `Stats`。
- 必须加入 `TOOL_CARD_MODELS`（单点名单，见 AGENTS.md pitfall 263），否则会被当成真实
  模型写进 `settings.requestModels` / `column.model`，导致后续新建卡全部变成空壳统计卡。
- 不使用 composer（无输入框），不参与 urge / 模型选择器。

### FR-2 实验性开关
- 新增设置 `experimentalStatsEnabled`，默认 `false`。
- 关闭时，卡片不出现在空态快捷工具栅格里。
- 与已有的 `experimentalWeatherEnabled` / `experimentalMusicEnabled` 同一区块呈现。

### FR-3 数据口径（关键约束）

**只使用渲染进程内存中已有的数据，不新增任何后端扫描、IPC 通道或 HTTP 端点。**

理由：唯一能提供真实全局历史（覆盖 `~/.claude/projects` 与 `~/.codex`）的来源是
`server/external-history.ts`，但它按 workspace 定位目录，改成全局扫描意味着流式读取
用户机器上全部 `.jsonl`。这正是本仓库长期 bug「用久了卡死」的形状（AGENTS.md pitfall
48 / 54 / 55），一张统计卡不值得这个风险。

可用数据：

| 来源 | 字段 | 精度 |
|------|------|------|
| `state.columns[].cards[].messages` | `createdAt`、`meta`（turn telemetry） | 精确到每条消息、含 token |
| `state.sessionHistory[]` | `archivedAt`、`messageCount`、`provider`、`model`、`usageTotals` | 会话粒度，消息只有 8 条预览且 `meta` 被剥掉；用量是归档时汇总好的定长记录 |

由此确定口径：

- **热力图的一格有两个数：消息条数与会话段数，用户可以在卡面上切换按哪个着色。**
  打开中的卡按每条消息自己的 `createdAt` 归日；已归档会话把 `messageCount` 条整体归到
  那一段的**开始日**。
- **会话归到「那一天开了几段会话」，不是「那一天归档了几段」。** 2026-08-21 修订，
  此前只有归档会话计入 `day.sessions` 且归在 `archivedAt` 那天，于是：今天新开的会话在
  日历上永远是 0 段（它还没归档），而一段昨天开、今天才关的会话会整段记在今天。用户想
  从日历上看的是「我哪天开了几段活」，这两条都答不了。
  - 开始日取 `messages[0].createdAt`。归档条目送进渲染进程时消息被裁成 8 条预览，但
    裁法是 `head 4 + tail 4`（`server/state-store.ts` 的
    `createRendererSessionHistoryMessages`），首条仍是全场最早的那条，所以开始日拿得到。
  - 拿不到（消息为空 / 时间戳非法）才退回 `archivedAt`。宁可退回一个偏晚的日子，也不
    让这一段从日历上消失。
  - 打开中的卡同理按首条消息归日；一条消息都还没有的空卡不落到任何一天——它还没产生
    可信的活动时间，凭 `now` 塞进今天就是编数据。
- **会话总数** = 打开中的聊天卡数 + `sessionHistory` 条目数（与日历口径无关，日历只决定
  某一段算在哪一天）。
- **token 统计覆盖打开中的会话 + 归档会话。** 归档条目的消息 `meta` 确实在
  `renderSessionHistoryForRenderer` 里被剥掉，所以用量不是在统计卡里重扫消息算出来的，
  而是在**归档发生的那一刻**（`shared/default-state.ts` 的 `createSessionHistoryEntry`）
  就汇总成 `usageTotals` 这 8 个标量存进索引条目——体积与消息条数无关，剥消息带不走它。

  这条口径 2026-08-16 修订。此前是「只覆盖打开中的会话」，卡片上挂着一句「归档会话不
  保留用量数据」的免责声明，用户的评价是「一点不专业，都看不了用量」。修订没有违反本节
  的关键约束：归档汇总发生在 reducer 内存里，仍然零磁盘扫描、零新 IPC。

- **覆盖范围必须写在卡面上**：`state.sessionHistory` 每个工作区只留最近
  `maxSessionHistoryPerWorkspace`（50）条，它不是全部历史。2026-08-16 实测用户存档：
  索引 253 条（三个活跃工作区正好卡在 50），而磁盘上的 sidecar 有 9649 段 / 1.06 GB。
  完整转录一条没删，只是不在这份索引里——要翻全部历史请用工作区标题栏的「历史」菜单，
  那里走的是 `server/session-history-catalog.ts` 后台增量建的 catalog（上限 2 万条）。
  统计卡不去读 catalog（那是磁盘扫描，违反本节的关键约束），所以 UI 文案必须明说
  「每个工作区最近 50 段」，不能只写「含已归档会话」让人以为是全量。

- **存量归档的补偿**：2026-08-16 之前归档的条目没有 `usageTotals`。
  `renderSessionHistoryForRenderer` 会在剥 meta 前用完整转录补算一次（sidecar 已加载时），
  补不上的条目不猜数字，改由 `archivedSessionsWithoutUsage` 计数，UI 明示「N 段归档过早，
  没留下用量」。宁可承认缺口，也不给一个偏低的总数假装是全量。

### FR-4 性能
- 卡片被折叠或不可见时不得重算。
- 重算必须节流，流式输出期间不能每帧重跑（board-wide transcript 遍历会吃掉帧预算，
  AGENTS.md pitfall 48）。
- 聚合逻辑必须是纯函数，与 React 解耦，可单测。

### FR-5 主题与布局
- 亮色 / 暗色双主题都要正确，颜色一律走 `src/index.css` 的 token。
- 卡片变窄时热力图要能横向滚动或收敛周数，不能撑破卡片。

### FR-6 日历口径切换
- 热力图脚注提供「消息 / 会话」两个互斥按钮，默认「消息」（保持既有观感）。
- 切到「会话」时格子颜色按当天会话段数分档；两套分档各自用自己的最大值做相对分位，
  否则会话数（个位数）永远被消息数（几十上百）压成最浅一档。
- 两套等级都在纯函数里一次算好（`level` / `sessionLevel`），切换只换读哪个字段，不重算。
- 无论切在哪一边，tooltip 都同时报消息条数与会话段数，包括 0 —— 「今天 0 段」和
  「今天没数据」是两件事，只在非零时才显示会话数会让人以为功能坏了。
- 这个选择是**卡片内的视图状态**，跟范围切换一样不持久化（不新增 state 字段）。

## 非目标

- 不做跨设备/云端统计。
- 不扫描 `~/.claude`、`~/.codex` 原始会话文件。
- 不新增持久化字段（除 `experimentalStatsEnabled` 这一个设置开关）。
- 不做导出 / 分享。

## 验收标准

1. `pnpm test` 中新增的 `tests/stats-card-metrics.test.ts` 全绿，且覆盖：空数据、跨日
   聚合、streak 计算、token 汇总、时区归日、**会话按开始日归日（含打开中的卡）**、
   **会话维度独立分档**。
2. 开关默认关闭时空态栅格里没有 Stats；打开后出现。
3. 切到 Stats 卡后，再新建一张卡不会继承 `__stats_tool__`（pitfall 263 回归）。
4. 亮/暗双主题截图检查通过。
5. `pnpm test:quality` 绿。
