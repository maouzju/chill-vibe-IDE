# Agent 声明「会话未完成」— 设计

## 标记格式

```
<chill-vibe-pending minutes="20">等 GitHub CI 跑完 release 构建</chill-vibe-pending>
```

- 放在最终回复末尾，最多一个；多个取最后一个。
- `minutes` 可省，缺省 30；夹到 [1, 240]。
- 正文去空白后为空时用「后台任务」兜底。

`shared/agent-pending-marker.ts`：

- `parseAgentPendingMarker(text)` → `{ reason, minutes } | null`
- `stripAgentPendingMarkers(text)`：删闭合块 + 流式中未闭合的尾巴
- `buildAgentPendingInstruction(language)`：注入系统提示
- `buildAgentPendingCheckInPrompt(reason, language)`：到点自查消息
- `isAgentDeclaredPending(card)`：`backgroundWorkPending === true && agentPendingUntil` 非空
- `planAgentPendingDeadlines(cards, now)` → `{ due, nextAt }`
- 常量 `AGENT_PENDING_MAX_CHECK_INS = 8`

## 卡片字段（运行时）

`ChatCard.agentPendingReason?: string`、`agentPendingUntil?: string`（ISO）。

`src/state.ts` 的 `updateCard` 帮手统一归一化：结果卡 `backgroundWorkPending !== true` 时删掉两个字段。
这样现有 ~20 处 `backgroundWorkPending: false` 全部自动带走声明，无需逐处改。

## 结算

App `onDone`：非停止、非自动压缩回合，取本回合最后一条 assistant 正文（`getLatestAssistantTurnText`）解析标记：

- 命中：`donePlan` 改按 `background-pending` 处理（同一分支），patch 额外写 `agentPendingReason/Until`；
- 原生 pending 且无标记：保持原状（无期限）。

## 到点自查

App 层一个 effect，键为所有卡的 `agentPendingUntil` 拼接；只挂一个 `setTimeout` 到最早到期点。
到期时对每张到期卡：

- 卡在 streaming → 跳过（它自己的 onDone 会重算）；
- 已发自查次数（ref，按卡计）≥ 8 → patch `backgroundWorkPending: false` 并追加一条 assistant 说明；
- 否则次数 +1，`sendMessage(..., { origin: 'agent-pending-checkin', mode: 'auto' })`。

`sendMessage` 遇到非 `agent-pending-checkin` 来源时清零该卡计数。

## UI

- `PaneView` tab 与 `state.ts` chip 的运行判据各加一项 `isAgentDeclaredPending(card)`。
- `ChatCard` 输入框上方复用 `composer-queued-send` 样式加一条 `composer-agent-pending` 状态：
  「后台未完成：{reason} · {HH:mm} 自查」+「立即自查」（`onSend` 带 check-in 来源）+「标为已完成」
  （`onPatchCard({ backgroundWorkPending: false })`）。
- `renderMarkdown` 与 `getLatestAssistantTurnText` 之外的展示路径通过 `stripAgentPendingMarkers` 隐藏标记。

## 计时唤醒

`isWakeTimerPeerBackgroundBusy`：`backgroundWorkPending && (子 agent 在跑 || agentPendingUntil 存在)`。

## 系统提示

Claude（keepalive / 一次性）、Codex（exec + app-server）、Gemini（首回合 `<system_instructions>`）
都追加 `buildAgentPendingInstruction`。

## 测试

`tests/agent-pending-marker.test.ts`：解析 / 夹值 / 剥离 / 到期计划 / 判据；`updateCard` 归一化；
`isWakeTimerPeerBackgroundBusy`；三家系统提示都包含约定。
