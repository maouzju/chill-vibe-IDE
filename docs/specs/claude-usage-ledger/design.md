# Claude 用量账本 — Design

## 文件总览

```
shared/claude-pricing.ts                ★ 定价表 + 型号匹配 + 费用计算（纯函数）
shared/claude-prompt-markers.ts         ★ 贴图前缀 / 空发送 / 打断标记常量（server 与 src 共用）
shared/chat-request-seeding-copy.ts     ★ 换会话重放壳子的文案对象（从 src/chat-request-seeding.ts 提出）
shared/claude-prompt-shell.ts           ★ stripChillVibePromptShell()：剥壳（纯函数）
shared/schema.ts                        claudeUsageRequestSchema / claudeUsageResponseSchema
server/claude-usage-ledger.ts           ★ 增量扫描 + 聚合缓存 + 查询（唯一有 I/O 的地方）
server/external-history.ts              导出 getClaudeProjectsDirs（原来是模块私有）
server/providers.ts                     getClaudePrompt 改用 shared 常量
server/index.ts                         GET /api/claude-usage
electron/backend.ts + main.ts + preload.ts + src/electron.d.ts   desktop:claude-usage
src/api.ts                              fetchClaudeUsage（桌面 IPC / 浏览器 fetch）
src/claude-usage-view-model.ts          ★ 时段预设、格式化、柱状图几何、表格筛选（纯函数）
src/components/ClaudeUsageView.tsx      ★ 取数容器 + 纯展示
src/components/StatsCard.tsx            视图切换
src/stats-card-source.ts                快照多带 autoUrgeMessages
src/App.tsx                             publishStatsSource 多传一个参数
shared/i18n.ts                          zh-CN + en 文案
src/index.css                           样式 + --usage-* 双主题 token
```

## 服务端：`server/claude-usage-ledger.ts`

### 为什么不是逐条消息落盘

token-dashboard 用 sqlite 存每条消息（本机实测 2026-09-01 ～ 10-28 两个月 386,769 条）。
JSON 缓存存这个量级是几十 MB、每年翻几倍，加载即吃掉主进程上百 MB 堆（pitfall 55 的形状）。
所以缓存只存**聚合桶**：

```
buckets[`${day}|${sessionId}|${priceKey}|${cwd}`] = [inp, outp, cw, cw1h, cr, count, lastTsMs]
prompts[`${day}|${cwd}`]                           = [count, chars]
```

同一份数据桶只有 6,076 个（实测 `group by day, proj, session, model`）。桶里存 `cwd` 而不是
项目名：项目归属是查询时的纯函数，工作区列表变了不用重扫。`priceKey` 在入账时定（含
Haiku 5.5 的 `@long`），因为它取决于那一次请求的 token 数。

### 去重

需要去重的两类重复：

1. **流式多行**：同一条回复按内容块写多行，同键连续出现，各字段取最大。
2. **跨文件复制**：fork / 续跑 / 子 agent 文件把同一条回复再抄一遍，第二次出现整条忽略。

做法：入账键 `message.id|requestId`（提示词用 `uuid`）哈希成 11 位 base36，放进按**日期**
分桶的「已见集合」`seen[day] = 'hash1hash2…'`（定宽拼接，JSON 里省一半体积）。
一条键只在**第一次**出现时入账；第一次出现所在的那一段连续同键行取最大值。

**流式行可能横跨两次增量读**（文件还在写）：每个文件条目里记 `pending = { key, bucketKey,
vals }`——上次读到末尾那一段同键行的现状。下次续读时若首行同键，继续取最大并把差值补进
原桶（`priceKey` 变了就从旧桶减掉再加到新桶）；不同键则 pending 结束。桶值永远等于「到目前
为止见过的最大值」，不会出现"最后一条永远挂着不入账"。

**保留期**：已见集合按消息日期只保留最近 `seenRetentionDays = 120` 天。更早的消息若被一个
新建的 fork 文件再抄一遍，会在那个旧日子上重复计一次——fork 四个月前的会话极罕见，换来的是
缓存体积有上界（实测最重用户 6.5k 键/天 × 120 天 × 11 字节 ≈ 8.6 MB，普通用户远小于此）。
被否决的替代：永久保留全部键——体积无上界，正是要避开的形状。

### 读文件

`FileHandle.read` 按 1 MiB 块从 `offset` 读到 `size`，手工按 `\n` 切行；块尾的半行拼到下一块；
文件末尾没有换行的尾巴**不吃**，`offset` 停在最后一个完整行之后。只有包含 `"usage"` 或
`"type":"user"` 的行才 `JSON.parse`（和 token-dashboard 一样的预过滤，21.5 GB 里绝大多数
行是工具输出）。每读完一个文件 `await` 一次让出事件循环；扫描期间每 10 秒异步落一次缓存，
结束再落一次。

文件 `size` 没变 → 跳过；`size < offset` → 从 0 重读（重读到的旧键被已见集合挡住，不重复
计数）；不比 mtime（同尺寸重写极少见，且 pitfall 247 说明 mtime 本就不可靠）。

### 缓存文件

`<dataDir>/claude-usage-ledger.json`：

```ts
{ version: 1, lastScanAt, files: { [path]: { size, offset, pending? } },
  buckets, prompts, seen, urgeMessages: string[] }
```

`version` 与代码里的 `ledgerCacheVersion` 不符 → 整份作废。写入走 `writeFile(tmp)` +
`rename`，一条 `writeChain` 串行化；**不复用** `state-store.ts` 的 `atomicWriteFile`——它的
WAL 文件与 state.json 共用（pitfall 15 / 58），一份旁路缓存不该碰它。

### 鞭策消息名单

剥壳要在入账时做（缓存里没有原文），而鞭策文案是用户设置。渲染进程把当前设置里所有
鞭策档案的 `message` 随请求带上，账本记下最近一次名单（持久化进缓存，启动时的首次扫描也
认得），下一次扫描用它。名单变了不回溯已入账的计数——这是明说的取舍：鞭策文案极少改。

### 查询

`queryClaudeUsage({ from, to, workspaces })`：一次遍历全部桶，同时算出时段内聚合与全时段
费用（后者只为 `colorOrder`）。项目归属 `attributeClaudeProject(cwd, workspaces)`
（纯函数，可单测）。`kpi.dailyAverage = totalCost / 有费用的天数`。

### 扫描调度

`ensureScan({ force })`：已在跑 → 返回；从未扫过或 `force` → `void runScan()`。
`getClaudeUsage(request)` 先 `ensureScan`，再同步算查询返回。扫描状态随响应返回。

## 共享：剥壳 `shared/claude-prompt-shell.ts`

```
stripChillVibePromptShell(text, { urgeMessages }) → string   // '' 表示不算用户亲手打的
```

顺序：图片前缀 → 重放壳子 → 整句相等的空发送 / `emptyLatestMessage` → `[Request interrupted`
前缀 → 鞭策消息（整句相等或以之开头）。重放壳子按 `buildSeededPromptBody` 的行结构解析：
找到 `latestMessageLabel` 行，取到下一个空行为止，再剥掉末尾的附图说明行（两种语言各用
各的 `getSeededPromptCopy`）。

## 共享：定价 `shared/claude-pricing.ts`

照抄 prices.json。`resolveClaudeModelFamily(model)`、`resolveClaudePriceKey(model, promptTokens)`
（点号→连字符、Haiku 5.5 超 10 万 `@long`）、`resolveClaudePriceRow(priceKey)`（最长前缀，
`@long` 只匹配 `@long`；退回同系列）、`estimateClaudeCostUsd(priceKey, vals)`。

## 前端

### 数据流

`StatsCard` 增加 `view: 'board' | 'claude'`。`ClaudeUsagePanel`（容器）在 `view === 'claude'`
时挂载：读 `readStatsSource()` 拿工作区路径与鞭策名单 → `fetchClaudeUsage` → 状态；
`scan.scanning` 时 3 秒后再拉；时段变化重拉；刷新按钮带 `refresh: true`。
`ClaudeUsageView`（纯展示）只吃 props，SSR 可测。

### 柱状图

SVG `viewBox="0 0 W 230"`，`W` 来自容器宽度：callback ref + `ResizeObserver`（pitfall 316 的
正确写法：ref 不在 loading 早退分支里，`setWidth` 在 observer 回调里）。几何由
`buildUsageChart(daily, {from, to, metric, colorOrder, width})` 纯函数产出
`{ days, bars[], ticks[], labelEvery }`，组件只画。悬停：每天一个透明命中矩形，
`onMouseEnter` 记 index，提示框绝对定位在图表容器内（不用 `position: fixed`，卡片在 pane
里会被裁）。

### 项目表

`<table>` 外套 `overflow-x: auto`；`@container stats-card (max-width: 560px)` 时隐藏
「模型构成 / 字符数 / 最近使用」三列并把 KPI 折成两列。颜色点用 `colorOrder` 的索引映射到
`--usage-s{n}`，其余 `--usage-other`。

### 为什么 autoUrgeMessages 走 stats-card-source

统计卡刻意不从 props 拿全局状态（pitfall 265 / 317）。鞭策名单同理：`publishStatsSource`
多带一个字符串数组，O(1) 赋值。

## 测试

- `tests/claude-pricing.test.ts`：定价匹配。
- `tests/claude-prompt-shell.test.ts`：剥壳六种形态。
- `tests/claude-usage-ledger.test.ts`：临时目录 jsonl fixture —— 去重取最大、跨文件忽略、
  半行不吃、追加后续读、文件变小重读、项目归属、查询聚合、缓存版本作废。
- `tests/claude-usage-view-model.test.ts`：时段预设、柱状图几何、搜索。
- `tests/stats-card-theme.spec.ts`：新视图亮 / 暗 / 窄卡截图（mock `/api/claude-usage`）。
