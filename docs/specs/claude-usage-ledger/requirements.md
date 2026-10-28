# Claude 用量账本（Claude Usage Ledger）— Requirements

## 背景

统计卡（`docs/specs/stats-card/`）只读渲染进程内存里的数据，看不到本机 Claude Code 的全部
历史用量。用户另有一个独立的 Python 面板（`token-dashboard`：`server.py` + `index.html`
+ `prices.json`）在做这件事：增量扫描 `~/.claude/projects/**/*.jsonl`，按项目 / 时段折算费用。
本功能把它移植进 Chill Vibe，并入现有 Stats 统计卡，作为一个可切换的第二视图。

stats-card 的 FR-3 当年把「扫全部 jsonl」列为非目标，理由是「用久了卡死」的风险
（AGENTS.md pitfall 48 / 54 / 55）。本功能不推翻那条约束，而是把扫描挪到**服务端后台**、
**增量**、**流式按行**，渲染进程只拿聚合结果；原视图的数据口径一字不改。

## 用户故事

1. 作为用户，我在 Stats 卡上切到「全部 Claude 用量」，能看到本机 Claude Code 全部历史的
   总费用、日均费用、总 token、会话数、项目数、最大头项目。
2. 作为用户，我能按时段预设（今天 / 昨天 / 近 7 天 / 近 30 天 / 本月 / 上月 / 全部）筛选。
3. 作为用户，我能看一张每日堆叠柱状图，按项目着色，可切换「费用 / Token / 提示词次数 /
   提示词字符数」四个口径，鼠标停在某一天上能看到各项目的明细。
4. 作为用户，我能看一张项目表：费用、占比、token、模型构成、会话数、提示词次数 / 字符数、
   最近使用时间、路径，可搜索。
5. 作为用户，我点「刷新」能让后台重新扫描新增的会话记录，期间卡片照常显示旧数据并提示
   「正在读取」。
6. 作为用户，「提示词次数 / 字符数」只算我亲手打的，不含 Chill Vibe 替我发的壳子
   （贴图前缀、空发送补的「请继续」、换会话 transcript 重放、自动鞭策）。

## 功能需求

### FR-1 扫描范围与增量

- 扫描根目录复用 `server/external-history.ts` 的 `getClaudeProjectsDirs()`（含
  `CHILL_VIBE_EXTERNAL_HISTORY_HOME` 覆盖与 HOME / USERPROFILE 多家目录，pitfall 32）。
- 递归枚举 `**/*.jsonl`（含 `<session>/subagents/agent-*.jsonl`）。
- 每个文件记录「已读到的字节偏移」。只读 `[offset, size)` 之间**完整的行**；末尾没写完的
  半行留到下次（pitfall 240：不整读大文件；2026-10-28 实测本机 17,621 个文件共 21.5 GB）。
- 文件变小（`size < offset`）视为被重写，从 0 重读；重读到的旧消息靠去重集合挡掉。
- 文件 `size` 没变则跳过，不打开。
- 缓存持久化到应用数据目录（`getAppDataDir()`），文件名 `claude-usage-ledger.json`，带
  `version`；口径变了就整体作废重扫。写入是异步 tmp + rename，扫描期间最多每 10 秒落一次，
  不做同步整文件写（pitfall 269）。
- 不读 `~/.codex`。

### FR-2 用量口径

- 只认 `type === 'assistant'` 且 `message.usage` 存在的行。取
  `input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
  `cache_creation.ephemeral_1h_input_tokens` / `cache_read_input_tokens`。
- **去重键 = `message.id|requestId`**。同一条回复流式输出时每个内容块写一行，前面几行的
  `output_tokens` 是半截数，**各字段取最大值**；fork / 续跑 / 子 agent 文件会把同一条
  回复再抄一遍，第二次出现整条忽略。
- 日期按**本地时区**归日（与 stats-card 一致）。
- 模型族：`fable`（含 `mythos`）/ `opus` / `sonnet` / `haiku`；认不出模型族的行跳过。

### FR-3 定价

- 定价表放 `shared/claude-pricing.ts`，数值照抄 外部 token-dashboard 面板的 `prices.json`：
  美元 / 百万 token，五档 `[输入, 输出, 缓存写 5 分钟, 缓存写 1 小时, 缓存读]`。
- 匹配规则：先把型号里的 `4.5` 这类点号换成 `4-5`，再按**型号前缀最长匹配**；
  Haiku 5.5 单次请求 `input + cache_write + cache_read > 100000` 走 `@long` 高价档；
  没收录的型号退回同系列默认价（`fable` / `opus` / `sonnet` / `haiku`）。
- 费用 = `(i·p_in + o·p_out + (cw − cw1h)·p_w5 + cw1h·p_w1h + cr·p_r) / 1e6`。
- **这是用量统计的估算价**，来源 platform.claude.com/docs/en/about-claude/pricing，
  抄录日期 2026-10-28；卡面要注明「按 API 公开价估算」。
  `docs/specs/fable-5-1-upgrade/requirements.md` 写的「不展示定价字段」是模型选择器语境
  （不在选模型时标价），与本功能的统计估算不冲突。

### FR-4 项目归属

按行里的 `cwd`，在**查询时**归属（归属规则不烙进缓存，工作区列表变了立刻生效）：

1. `cwd` 位于 Chill Vibe 已配置的某个工作区路径之下 → 归该工作区（名字取工作区目录名，
   路径取工作区根）。工作区列表由渲染进程随请求传入（它手里就有 `columns[].workspacePath`，
   服务端不必为此加载 state）。
2. 否则形如 `X:\Git\<名>\...` → `<名>`，路径取 `X:\Git\<名>`；worktree 自然并入主项目。
3. 临时目录（`\AppData\Local\Temp\` 或系统 tmpdir 之下）→ 特殊项目 `临时目录`。
4. `X:\Git` 本身、`~\.claude` 之下、`~` 本身 → 分别归「Git 根目录」「Claude 配置」「用户目录」。
5. 其余取 `cwd` 末级目录名。
- 特殊项目以稳定 id（`(temp)` 等）返回，显示名由前端按语言翻译。

### FR-5 提示词次数 / 字符数

只算用户亲手打的：

- `type === 'user'` 行；跳过 `isMeta` / `isSidechain` / `isCompactSummary` / 正文以 `<` 开头。
- 剥掉 Chill Vibe 自己加的壳子，**识别用的是仓库里现成的常量 / 生成函数，不另抄字符串**：
  - `server/providers.ts` `getClaudePrompt` 的贴图前缀 `Analyze this image(s):\n路径…\n\n正文`
    → 只去前缀留正文（前缀常量提到 `shared/claude-prompt-markers.ts` 供两边共用）。
  - `src/chat-request-seeding.ts` 的换会话 transcript 重放壳子 → 只保留「当前用户消息」段，
    去掉「当前这条用户消息还包含 N 张附图」行；壳子可能被贴图前缀包着，先剥图片前缀再解析
    （文案对象提到 `shared/chat-request-seeding-copy.ts`）。
  - 空发送补的 `Please continue.` / `请继续。`（**整句相等才剔除**，「请继续。另外…」保留）
    以及 `emptyLatestMessage`。
  - `[Request interrupted` 标记。
  - 自动鞭策消息：`defaultAutoUrgeMessage` 与用户设置里各档案的 `message`（渲染进程随请求
    传入，后台扫描按最近一次收到的名单识别）。
- 去重键 = 行的 `uuid`；按本地日期归日；字符数 = 剥壳后正文长度。

### FR-6 API

- `GET /api/claude-usage?from=YYYY-MM-DD&to=YYYY-MM-DD[&workspace=…]*[&urge=…]*[&refresh=1]`，
  zod 校验；桌面端走 IPC `desktop:claude-usage`，浏览器走 fetch（与 external-history 同模式）。
- 返回：
  - `kpi`：总费用、日均费用（= 总费用 / 有使用的天数）、总 token、其中输出 token、会话数、
    项目数、最大头项目及占比。
  - `daily`：每天按项目的 费用 / token / 提示词次数 / 字符数。
  - `projects`：费用、占比、token、按模型族的费用构成、会话数、提示词次数、字符数、
    最近使用时间、路径。
  - `colorOrder`：按**全时段**费用排名前 7 的项目，筛时段不换色。
  - `span`：有数据的最早 / 最晚日期。
  - `scan`：`scanning` / `done` / `total` / `lastScanAt`。
- 扫描不阻塞请求：请求先返回已有数据 + 扫描状态；没扫过或 `refresh=1` 时在后台启动扫描。
- 同一时刻只跑一个扫描。

### FR-7 前端

- 扩展现有 `StatsCard`，不新建工具卡类型。顶部加视图切换「本应用 / 全部 Claude 用量」，
  默认仍是原视图；切换是卡片内视图状态，不落盘。
- 新视图：时段预设 + 刷新按钮 + 状态文字；KPI 行；手写 SVG 每日堆叠柱状图（可切换
  费用 / Token / 提示词次数 / 字符数，前 7 个项目各一色其余归「其他」，悬停提示）；
  项目表（可搜索）。
- 卡片宽窄都要能看：用 `@container stats-card`（不是 `@media`，ui-principles 规则 6），
  窄时 KPI 折成两列、表格次要列隐藏、整表可横向滚动。
- 色板参考 token-dashboard 的 `index.html`，落成 `src/index.css` 的 `--usage-s1..7` /
  `--usage-other` 双主题 token。
- 文案 zh-CN + en 双语。
- 扫描中每 3 秒轮询一次，扫描结束停止；卡片卸载时停止。

## 非目标（后续可选）

- AI 项目简介（token-dashboard 的 `summarize`）。
- git 提交量列（token-dashboard 的 `commits_by_day`）。
- 读 `~/.codex` 的用量。
- 自定义日期区间输入框（先只做预设）。
- 表头点击排序（按费用固定排序）。

## 验收标准

1. 红→绿单测（登记进 `tests/index.test.ts`）：
   - 去重取最大、跨文件第二次出现忽略；
   - 定价匹配（`@long`、点号版本、未知型号回退）；
   - 提示词剥壳（图片前缀、重放壳子、被图片前缀包着的重放壳子、整句「请继续。」剔除但
     「请继续。另外…」保留、鞭策消息）；
   - 增量偏移（半行不吃、文件变小重读）；
   - 项目归属。
   用临时目录造 jsonl fixture。
2. `pnpm test:quality` 绿。
3. 主题回归：`tests/stats-card-theme.spec.ts` 补新视图的亮 / 暗 / 窄卡截图。
4. 真实数据下近 30 天总费用与 token-dashboard 同量级。
