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

- [ ] 子代理明细展开：消费 sidechain 行，点开面板可看到子代理内部的逐条工具调用。
- [ ] 回合结束但仍有子代理在跑时的收尾策略（对齐 Codex 的 `markRootTurnCompleted` 延迟结算）。
- [ ] `system:task_notification` 的 `summary` / `output_file` 接入卡片，便于回看子代理产出。
