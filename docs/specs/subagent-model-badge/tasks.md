# Tasks: 子 agent 面板显示模型

## Slice 1 - schema + 两侧追踪器

- [x] 红：Codex 追踪器 thread/started 带 model/reasoningEffort 的快照断言。
- [x] 红：Claude 追踪器 sidechain assistant message.model 写入 / handled:false / 去重断言。
- [x] 绿：`streamAgentEntrySchema` 加字段；两侧追踪器写入与输出。

## Slice 2 - 渲染

- [x] 红：`structured-chat-blocks.test.tsx` 状态视图渲染 model 徽标与无 model 不渲染。
- [x] 绿：`StructuredAgentsCard` 状态视图插入徽标 + 样式。
- [x] theme-check Codex 子 agent 夹具补 model / effort，明暗快照有意更新。

## Slice 3 - 收尾

- [x] 窄测试 + `pnpm test:quality`。
- [x] 打包 `pnpm electron:build`：`dist/release-20260921-101730/Chill Vibe-0.20.25-win.zip`（可执行 `win-unpacked/Chill Vibe.exe`，asar 内已含 `structured-agent-model`）。

Verification (2026-09-21): 红→绿 —— `tests/codex-agent-status.test.ts` 1 新用例先红（actual undefined）后绿（20/20）；`tests/claude-agent-status.test.ts` 2 新用例先红后绿（34/34，另 1 条守卫用例一直绿）；`tests/structured-chat-blocks.test.tsx` 1 新用例先红（渲染层解析未透传 model）后绿（39/39）。`pnpm test:quality` 通过。Playwright `theme-check -g "sub-agent"` 7 通过，4 张快照（codex-sub-agent-status / subagent-dock-card 明暗各一）因夹具新增 model/effort 有意重生成并逐张过目。
