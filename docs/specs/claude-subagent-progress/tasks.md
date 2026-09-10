# Claude 子代理进度 UI — Tasks

## Slice 1 — 翻译层（本次）

- [x] 红：新增 `tests/claude-agent-status.test.ts`（12 例），用 2026-08-09 实测录得的真实事件序列驱动追踪器；注册进 `tests/index.test.ts`；确认以 `ERR_MODULE_NOT_FOUND` 失败。
- [x] 绿：实现 `server/claude-agent-status.ts`，导出 `createClaudeAgentStatusTracker`，产出复用 `streamAgentsActivitySchema` 的 `agents` 活动快照；12/12 通过。
- [x] 接线：`server/providers.ts` 的 Claude stdout 折叠器加入子代理分支，落在 `init` 之后、通用结构化解析之前并直接 return。
- [x] 同批修正被本次改动推翻的两处「CLI 静默运行子代理」注释。
- [x] 验证：Claude 流相关 112 例回归全绿；用实测录得的 168 行真实 stdout 端到端驱动，得到「登记 → 3 次进度 → 收敛」共 6 次面板刷新；`pnpm test:quality` 通过。
- [x] 打包：`pnpm electron:build`。

### 实现期补记

- `itemId` 采用 `agent-status:claude` 而非 `claude-agent-status`：`src/codex-agent-status-slash.ts` 靠 `agent-status:` 前缀回溯最近一次子代理快照，换前缀会让 `/agents` 退化成模糊 fallback。
- 渲染与停止流清理均无 provider 门控（`src/components/MessageBubble.tsx` 322 行附近无条件解析、`src/state.ts` 856 行附近的停止清空对 `kind === 'agents'` 通用），因此 Claude 侧零改动即可复用。

## Slice 1b — 静默期兜底与 task_type 分流（2026-08-09 第二轮）

用户反馈「面板一直没动」（整轮已跑 26 分钟，三条进度仍停在 3.3s / 10.7s）后追加的两项修复。

- [x] 实测定性：子代理执行一条长命令期间，CLI 从 39.6s 到 195.1s **整整 155 秒零事件**。证实 `task_progress` 是「每完成一次工具调用」触发，不是定时心跳——面板静止属于 CLI 上报机制，不是接线漏了。
- [x] 红→绿：面板为每个运行中的子代理追加一行本地推算的已运行时长（`⏳ 已运行 3分14秒`），并由 `server/providers.ts` 中 15s 周期重发驱动其走动；空窗期不再像死了。
- [x] 红→绿：按 `task_type` 分流。实测后台 shell 命令走同一套 `system:task_*` 上报（`task_type=local_bash` 且无 `subagent_type`），此前会在面板上冒充成一个「子智能体」。
- [x] 定时器生命周期：`markFinished()` 与 `cancel()` 双路径清理，避免被丢弃的 parser 留下 interval 继续向已替换的 sink 重绘。
- [x] 验证：目标测试 19/19；相关回归 170/170；`pnpm test:quality` 通过；用真实 CLI 输出 + 155 秒模拟空窗端到端确认已运行时长持续走动、后台命令登记数为 0。

### 关键约束

- 已运行行必须是 `activity` 的**最后一行**：渲染层 `StructuredAgentsCard` 对活动做 `slice(-3)` 尾切，放在别处会被切掉。已有专门测试锁住该顺序。
- 该行前缀 `⏳` 是用户可见文本，不能换成内部标记字符串。

## Slice 2 — 后续（不在本次范围）

### 2026-09-08 用户要求继续修复

- [x] 切片 A 红→绿：Workflow 失败/后台回执/原生任务别名/迟到终态。
- [x] 切片 B 红→绿：pool 输出观察与进程级 runtime，跨回合/空闲计时及释放。
- [x] 切片 C 红→绿：共享推送校验与前端纯状态更新，旧快照加载收敛。
- [x] 窄回归 151/151；浏览器 12/12（含亮暗 Workflow 推送）；修改文件定向 ESLint 通过。
- [x] 已运行全仓 quality：被并行更新器测试 `tests/updater.test.ts` 的未使用导入阻塞，本次不改写其 WIP。
- [x] Windows zip 打包成功：`dist/release-20260908-192743/Chill Vibe-0.20.17-win.zip`；核验 asar 中 runtime、共享状态模块及 keepalive 接线；保留用户运行实例。

- [x] 2026-09-08：定位旧包 Workflow 计时结束快照漏发；在已有收尾修正上补端到端解析器守卫，旧包等价缺陷探针红、当前代码绿。
- [x] Workflow 失败结果与后台任务 ID 关联、跨回合生命周期：不把工具调用兜底条目等同于实际仍在运行的子代理。

- [ ] 子代理明细展开：消费 sidechain 行，点开面板可看到子代理内部的逐条工具调用。
- [ ] 回合结束但仍有子代理在跑时的收尾策略（对齐 Codex 的 `markRootTurnCompleted` 延迟结算）。
- [ ] `system:task_notification` 的 `summary` / `output_file` 接入卡片，便于回看子代理产出。

## Slice 3 — 运行中子代理沉底单窗口（2026-09-10）

- [x] 红：`tests/chat-card-parsing.test.ts` 改写两条「状态卡进转录」守卫为「状态卡出转录、进沉底」，新增 `selectDockedAgentStatus` 用例（最新快照优先 / 无运行中返回 null / toolCall 视图不受影响）。
- [x] 绿：`chat-card-parsing.ts` + `ChatCard.tsx` + `index.css`。
- [x] Tier 2：`theme-check.spec.ts` 更新 Codex 状态面板三条用例到 `.subagent-dock`，空态改为不渲染，新增整卡沉底快照（亮/暗）。
- [x] `pnpm test:quality` 通过；相关 Node 单测 4 文件绿；Playwright 子代理/Workflow 推送 9/9 绿（`codex-sub-agent-status-*` 快照因面板改挂沉底容器重生成，`codex-sub-agent-status-empty-*` 随空态不再渲染而删除，新增 `subagent-dock-card-*`）。
- [x] `tests/stream-recovery-runtime.spec.ts` 的后台 Workflow 推送用例改为断言收敛后沉底面板卸载。

## Slice 4 — 后台 Agent 跨回合保留 + Stop 钩子 UTF-8（2026-09-10）

- [x] 现场证据：卡 a2cd0e4f 三个 `run_in_background` Agent 在根回合 end_turn（04:34:03）后分别跑到 04:40 / 04:42 / 04:46，state.json 里的状态快照却已是 `agents: []`；`%TEMP%\chill-vibe-claude-completion` 下 179 份 Stop 钩子快照全部 JSON.parse 失败（自 09-01 起每一份）。
- [x] 红：`tests/claude-agent-status.test.ts` 新增「后台 Agent 回执后 finishTurn(true) 仍 running」；`tests/claude-agent-runtime.test.ts` 新增「boundary=unknown 时 result 不卸掉后台 Agent」；`tests/claude-completion-boundary.test.ts` 新增「中文 + 转义引号载荷经钩子落盘后仍可解析」。三条确认失败（agents 0≠1、hasBackgroundAgents false、boundary unknown）。
- [x] 绿：`server/claude-agent-status.ts` 的「Async agent launched」回执分支登记 background，终态仍只由 `system:task_notification` 决定；`server/claude-completion-boundary.ts` Windows 钩子改读 `[Console]::OpenStandardInput()` 字节流按 UTF-8 解码。
- [ ] 后续：CLI 2.1.263 另有 `system:background_tasks_changed`（REPLACE 语义、全量存活后台任务），可替代回执文案正则与 Stop 旁路文件成为后台真相源。
- [x] `pnpm test:quality` 通过；三份 Node 单测 43/43 绿。
- [x] Windows zip 打包成功：`dist/release-20260910-133457/Chill Vibe-0.20.19-win.zip`；asar 内含 `Async agent launched` 分支与 `OpenStandardInput` 钩子脚本，旧 `[Console]::In.ReadToEnd` 为 0 处。
