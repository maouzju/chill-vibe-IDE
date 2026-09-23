# Tasks: 允许 Agent 使用 Computer Use（浏览器控制）

## Slice 1 - 运行时模块 + Claude/Codex 参数（Tier 1，红→绿）

- [x] 红：`tests/computer-use-runtime.test.ts`
  - `resolveBrowserMcpLaunch`：全局 `@playwright/mcp` shim → `cli.js` + 绝对 node；Electron 下带 `ELECTRON_RUN_AS_NODE`；无 shim 回落 `npx -y @playwright/mcp@latest`；都没有返回 `null`。
  - `buildComputerUseCodexRuntimeArgs` 输出 `-c mcp_servers.chill_vibe_browser.*`。
  - `buildClaudeArgs`：开关开 → `--settings.chrome === true` + `--mcp-config` 含 `chill_vibe_browser` 且无 `--strict-mcp-config`；与超管配置同在 → 同一个 JSON 含两个 server + `--strict-mcp-config`；开关关 → 无 `chrome` 键、无 `--mcp-config`。
  - `getComputerUseInstruction` 中英都提到 `chill_vibe_browser`；Codex 版提到 `tool_search`。
- [x] 红：`tests/codex-chat-settings.test.ts` 请求默认不为 true；两条 provider 分支都透传（只在打开时带字段）。
- [x] 红：`tests/default-state.test.ts` `normalizeAppSettings` 默认 `false`、显式 `true` 保留、垃圾值回落。
- [x] 绿：`shared/schema.ts` / `shared/default-state.ts` / `shared/codex-chat-settings.ts` / `src/state.ts` / `server/computer-use-runtime.ts` / `server/providers.ts`（`buildClaudeArgs` 选项、两条 Claude 启动路径透传、`launchProviderRun` 接线、池签名）。

## Slice 2 - 设置面板

- [x] `shared/i18n.ts` `computerUseLabel` / `computerUseNote`（中英）。
- [x] `src/App.tsx` 安全开关组末尾加开关（`${idPrefix}-computer-use`）；`codexChatSettings` useMemo 透传。
- [x] `tests/theme-check.spec.ts` 安全开关组：checkbox 5→6、hover note 5→6、新开关默认未勾选 + 文案；`codex-safety-settings-{dark,light}-win32.png` 有意更新（实际截图核对：只多了底部一行，默认未勾选）。

## Slice 3 - 收尾

- [x] 窄测试 + `pnpm test:quality`。
- [x] AGENTS.md pitfall #383：两条 CLI 在 IDE 路径里都没有原生 computer use；`claude --mcp-config` 可变参数吞位置参数；Codex `features.computer_use` 空操作。
- [x] 真实 CLI 端到端：`node --import tsx scripts/verify-computer-use-e2e.mjs`。

Verification (2026-09-21): 红→绿 —— `tests/computer-use-runtime.test.ts` 新文件 10 用例先因模块缺失整文件红、实现后 10/10 绿；`tests/codex-chat-settings.test.ts` 2 新用例、`tests/default-state.test.ts` 1 新用例先红后绿。相关 11 份 Node 套件（state / provider-system-prompt / archive-recall / codex-fast-mode-confirmation / default-admin-access / default-state / automation-board-mcp / claude-settings-env-override / computer-use-runtime / codex-chat-settings / git-operation-hub）350/350 绿。`pnpm test:quality`（eslint + 4 组 tsc）通过。Playwright `Agent destructive-command protection settings stay clear in {dark,light} theme` 2/2 绿（快照有意更新）。

End-to-end (2026-09-21, real CLIs with Chill Vibe's own builders, `scripts/verify-computer-use-e2e.mjs`):
- Claude 2.1.263：`buildClaudeArgs({ computerUseEnabled: true }, { computerUseMcpConfig })` 起 `claude -p`，system/init 的 `tools` 里出现 `mcp__chill_vibe_browser__browser_navigate` 等（本机没装 Claude in Chrome 扩展，走的是 Playwright MCP 兜底；`chrome: true` 同时在 `--settings` 里）。
- Codex 0.153.4：`buildComputerUseCodexRuntimeArgs(launch)` 起 `codex exec`，捕获的首条 /v1/responses 里 `tool_search` 描述列出来源 `- chill_vibe_browser`（Codex 把 MCP 工具延迟在 tool_search 后面，顶层 tools 看不到，属正常）。
- 本机定位结果：已验证全局 `@playwright/mcp@0.0.55` 的 CLI 路径可被解析（具体机器路径不纳入发布文档）。

Known follow-ups:
- 设置面板整体快照 `settings-panel-card-{grid,stack}-{dark,light}.png` 在 main 上本就是基线红（见 memory「设置面板 14 个快照是基线红」），本次没有动它们。
- Playwright MCP 默认用它自己缓存的 Chromium；用户没跑过 `npx playwright install` 时模型会先拿到 `browser_install` 工具自行安装。
