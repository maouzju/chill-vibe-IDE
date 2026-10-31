# Tasks: 允许 Agent 操控电脑桌面

## Slice 1 - 运行时模块 + 参数（Tier 1，红→绿）

- [x] 红：`tests/desktop-control-runtime.test.ts`
  - `resolveDesktopMcpLaunch`：`windows-mcp` exe 优先；回落 uvx、`uv tool run`；PATH 没有时查 `~/.local/bin`；都没有返回 `null`；serve 参数带 `--exclude-tools PowerShell,FileSystem,Process,Registry`，env 关遥测。
  - `createDesktopControlRuntime`：开关关 → `null`；非 win32 → `null`；Codex 参数含 `startup_timeout_sec`；Claude 配置在 `mcpServers.chill_vibe_desktop` 下。
  - `buildClaudeArgs` 收到合并后的配置时，`--mcp-config` 同时含 browser 与 desktop。
  - 指令中英都提到 `chill_vibe_desktop`；Codex 版提到 `tool_search`。
- [x] 红：`tests/codex-chat-settings.test.ts` 两条分支透传（只在打开时带字段）。
- [x] 红：`tests/default-state.test.ts` 默认 `false`、显式 `true` 保留、垃圾值回落。
- [x] 红：池签名随开关变化。
- [x] 绿：schema / default-state / codex-chat-settings / state.ts / desktop-control-runtime / providers.ts。

## Slice 2 - 设置面板

- [x] i18n 中英文案；App.tsx 开关 + useMemo 透传。
- [x] `tests/theme-check.spec.ts` 安全开关组计数 +1；快照有意更新并人工核对（只多出底部一行未勾选开关）。

## Slice 3 - 收尾

- [x] 窄测试 + `pnpm test:quality`。
- [x] 真实 CLI 端到端：Claude `system/init` 工具表出现 `mcp__chill_vibe_desktop__*`；Codex `tool_search` 来源出现 `chill_vibe_desktop`。
- [x] AGENTS.md pitfall（#414）。

## 验证记录（2026-10-31）

- 窄测试：desktop-control-runtime / codex-chat-settings / default-state / claude-keepalive-signature / computer-use-runtime / jev-runtime 共 85/85 通过。
- Playwright：`codex safety settings` 深浅两张快照通过（`PW_PORT=5231`，5199 被别的进程占着）。
- `node --import tsx scripts/verify-desktop-control-e2e.mjs`，本机 `windows-mcp` 0.8.8：
  - MCP 直连 PASS：16 个工具（App、Snapshot、Screenshot、Click、Type、Scroll、Move、Shortcut、Wait、WaitFor、Scrape、MultiSelect、MultiEdit、Clipboard、Notification、DisplayInventory），没有 PowerShell / FileSystem / Process / Registry。
  - Claude PASS：`status=connected`，16 个 `mcp__chill_vibe_desktop__*`。
  - Codex PASS：`tool_search` 来源列出 `chill_vibe_desktop`。
