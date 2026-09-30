# Tasks: JEV 快速判断 MCP

## Slice 1 - 运行时 + MCP（Tier 1，红→绿）

- [x] 红：`tests/jev-runtime.test.ts`（开关关/无 key → null；开 → Codex `-c mcp_servers.chill_vibe_jev.*`、Claude mcpServers；key 不出现在任何参数里；buildClaudeArgs 合并后含 `chill_vibe_jev`）。
- [x] 红：`tests/jev-mcp.test.ts`（精简格式、收集文件跳过 node_modules、服务方选择、401 → key 失效、tools/list 只有 jev_ask）。
- [x] 红：`tests/codex-chat-settings.test.ts`、`tests/default-state.test.ts` 新字段。
- [x] 绿：schema / default-state / codex-chat-settings / state.ts / jev-runtime / jev-mcp / providers。

## Slice 2 - 设置面板

- [x] i18n 文案 + App.tsx 开关与 key 输入 + settings-model 目录登记 `jev`。

## Slice 3 - 收尾

- [x] 窄测试 + `pnpm test:quality`；AGENTS.md pitfall；真实 MCP 冒烟（initialize/tools/list，无 key 时报错可读）。

Verification (2026-09-30): 红→绿 —— `tests/jev-mcp.test.ts`、`tests/jev-runtime.test.ts` 先因模块缺失整文件红，`codex-chat-settings` / `default-state` 新用例先红；实现后 5 份 Node 套件 72/72 绿，`settings-model` + `state` 103/103 绿。`pnpm test:quality` 通过。Playwright：`JEV quick-judgment settings … {dark,light}` 新快照 2/2（人工看图核对）、设置落地页（模型与对话分类 3→4 项）与搜索用例绿；`settings panel shows named auto urge profiles` 在未改动的 main 上同样红，是基线红与本次无关。实网：假 key 打 OpenRouter / TypeSafe 两个端点都走到「key 被拒」路径（HTTP 401，报错不含 key）。

Known follow-ups:
- 没有真 key，未实测真实判断返回。（开关开着先空 key、后补 key 不会卡在旧进程：签名含 systemPrompt，注入时追加的那句说明会让签名变化、常驻进程换代。）
- 本机 Node fetch 直连两个端点首包约 11.8s（疑似 IPv6/网络回落），真实使用时单次延迟可能远高于官方 70–500ms。

Release audit (2026-09-30): 新增工作区读取边界保护。绝对工作区外路径的回归先红后绿；进一步验证父目录穿越、Windows junction 文件/目录逃逸，并确认拒绝路径不会触发第三方上传。目标测试 8/8 通过。真实付费判断成功路径仍未实网验证，不将假 key 冒烟描述为真实判断成功。

## Slice 4 - 自定义请求地址

- [x] 红→绿：设置增加可选完整 JEV 请求地址，默认空字符串，恢复时 trim。
- [x] 红→绿：地址通过 ChatRequest 与 MCP env 传递；密钥仍仅服务端读取。
- [x] 红→绿：默认值、地址路由和 CLI 参数回归测试通过。
- [x] 2026-09-30：新增 URL 设置控件及中英文说明，深浅主题快照已更新；完整发布门禁待本次 release candidate 验证。