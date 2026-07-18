# Claude 长驻会话进程（session keepalive）— 需求

## 背景 / 问题

Chill Vibe 当前为 Claude 卡片的**每一轮对话**启动一个一次性 CLI 进程（`claude -p ... <prompt>`，见 `server/providers.ts` 的 `buildClaudeArgs`），turn 结束（`result` 事件）后进程退出。后果：

1. **后台任务随进程死亡**：agent 在 turn 内用 `run_in_background` 启动的任务（如 `pnpm test:full`）在 CLI 退出后丢失（用户实测："输出 0 字节、进程已不在"）。
2. **agent 无法兑现"完成后我会汇报"**：Claude Code 的 task-notification 机制依赖 CLI 进程存活；进程退出后没有接收者，agent 永远不会被唤醒续写汇报。
3. **用户手动追问 = 全量重新计费**：追问走 `-r sessionId` 起新进程，Anthropic prompt cache 仅 5 分钟 TTL，整段上下文重新计费，浪费 token。

## 目标

- Claude 卡片的 CLI 进程在 turn 结束后**保持存活**（`--input-format stream-json` 双向流模式），后续用户消息写 stdin 复用同一进程。
- agent 后台任务完成时，CLI 原生自动唤醒 agent 产生的**自发输出**（无用户消息触发的新 turn）必须实时出现在对应卡片里，行为与普通回复一致（流式渲染、活动卡片、done 后回 idle）。
- 同进程连续对话吃到 prompt cache，降低 token 成本。

## 非目标（本期不做）

- Codex 路径改动（app-server 已是长驻进程）。
- 纯 web（Express HTTP/SSE）模式的自发输出推送 —— keepalive 仅在 Electron desktop backend 启用，web 路径保持现状单次进程，零回归。
- interrupt 的 stdin 控制消息 —— 用户打断仍 kill 进程，下次请求起新进程（与现状一致，且 pitfall #118 本就要求 interrupt 后 fresh session）。
- 新增持久化字段 —— 长驻进程死亡即死亡，崩溃恢复沿用现有 sessionId resume 路径。

## 验收标准

1. 同一 Claude 卡片连续两次发送，第二次复用同一 CLI 进程（写 stdin），不再 spawn 新进程。
2. agent 在 turn 内启动后台任务、turn 结束后，CLI 进程仍存活；后台任务完成时，卡片**自动**出现 agent 的汇报输出（用户零操作）。
3. 模型 / effort / workspace / planMode 任一变化，或卡片 sessionId 与进程不匹配时，不复用：杀旧进程并按现有路径起新进程（兼容 pitfall #47/#118）。
4. 用户打断（stop）杀进程；下次发送起新进程，不复用已中断会话（pitfall #118）。
5. 长驻进程空闲（无活跃 turn 且无任何 stdout 输出）超过回收阈值后自动退出；应用退出时全部清理。
6. turn 之间的静默不触发 stall watchdog（watchdog 仅在 turn 进行中布防，沿用 openCommandCount disarm 规则，pitfall #145）。
7. 现有恢复链路（resume-session、重试预算、可恢复错误分类）行为不变；keepalive 进程在 turn 进行中死亡时走现有 close → recovery 分类。
8. 纯 web server 路径行为完全不变。

## Lifecycle safety addendum (2026-07-18)

9. A pooled process must not be reused across different provider runtime environments or attachment authorization directories.
10. Delayed events from a replaced child must not mutate the current entry for the same card.
11. When two acquisitions race for the same card, only the newest acquisition may own the pool entry; any late older child must be terminated.
