# Design: 允许 Agent 操控电脑桌面

## Overview

全局布尔设置 `desktopControlEnabled`，完全复用浏览器开关 / JEV 的「设置 → 请求字段 → provider 启动参数」通道：

| 层 | Claude | Codex |
| --- | --- | --- |
| 注入 | `--mcp-config` 合并进 `chill_vibe_desktop`（与 browser / JEV 同一份 JSON） | `-c mcp_servers.chill_vibe_desktop.command/args/env/startup_timeout_sec` |
| 提示词 | `getDesktopControlInstruction(language, provider)` 追加到 system prompt | 同上，多一句「先 tool_search」 |
| 进程复用 | keepalive 池签名加 `desktopControl` | 每回合起 app-server，无需签名 |

新模块 `server/desktop-control-runtime.ts`，形态对齐 `server/computer-use-runtime.ts`。

## Data / Schema

- `shared/schema.ts`：`appSettingsSchema.desktopControlEnabled: z.boolean().default(false)`；`chatRequestSchema.desktopControlEnabled: z.boolean().optional()`。
- `shared/default-state.ts`：`createDefaultSettings` 默认 `false`；`normalizeAppSettings` 布尔归一。
- `shared/codex-chat-settings.ts`：两个 Pick 加字段，Claude / Codex 分支都只在打开时带 `desktopControlEnabled: true`。
- `src/state.ts`：`updateSettings` 补丁键联合加字段。

## Runtime (`server/desktop-control-runtime.ts`)

```ts
export const desktopControlMcpServerName = 'chill_vibe_desktop'
export const desktopControlExcludedTools = ['PowerShell', 'FileSystem', 'Process', 'Registry']

export const resolveDesktopMcpLaunch = async (options?: {
  lookup?: (executable: string) => Promise<string[]>
  exists?: (filePath: string) => Promise<boolean>
  homeDir?: string
  platform?: NodeJS.Platform
}): Promise<DesktopMcpLaunch | null>
```

定位顺序（每一项先 `where`，再查 `<home>/.local/bin/<name>.exe`）：

1. `windows-mcp` → `command = 该 exe`，`args = serveArgs`。冷启动最快，和隔离 USERPROFILE 无关（uv 的 trampoline 里写的是绝对路径）。
2. `uvx` → `args = ['windows-mcp', ...serveArgs]`。
3. `uv` → `args = ['tool', 'run', 'windows-mcp', ...serveArgs]`。
4. 都没有 → `null`。

`serveArgs = ['serve', '--transport', 'stdio', '--exclude-tools', 'PowerShell,FileSystem,Process,Registry']`；`env = { ANONYMIZED_TELEMETRY: 'false' }`。

为什么关掉 PowerShell / FileSystem / Process / Registry：CLI 自带的 shell 与文件工具受 Chill Vibe 的危险命令防护（`codexDestructiveCommandProtection` / `attackPatternProtection` 钩子）约束；MCP 里再开一个 PowerShell 就是绕开防护的后门，而且对「操控桌面」没有增量。

`createDesktopControlRuntime(request, deps?)`：`request.desktopControlEnabled !== true` → `null`；非 win32 → warn + `null`；定位失败 → warn + `null`（fail-open）。

Codex 额外写 `mcp_servers.chill_vibe_desktop.startup_timeout_sec=120`：uvx / `uv tool run` 首次要下载 Python 依赖，默认 10 秒的 MCP 启动超时会把它当失败。

## Wiring (`server/providers.ts`)

- `launchProviderRun`：在 `computerUseRuntime` 之后算 `desktopControlRuntime`，try/catch fail-open。
  - Codex：`extraCodexArgs` / `extraSystemPrompt` 追加。
  - Claude：system prompt 追加；`mergeClaudeMcpConfigs(computerUse, desktopControl, jev)` 合并后走原来的可选 MCP 槽位（不新增 `launchClaudeRun` 参数）。
- 池签名加 `desktopControl: request.desktopControlEnabled === true`。

## UI

- `src/App.tsx` 安全开关组在浏览器开关下面加一个 `settings-hover-detail` 开关，`id` 为 `${idPrefix}-desktop-control`；`codexChatSettings` useMemo 透传。
- `shared/i18n.ts` 新增 `desktopControlLabel` / `desktopControlNote`（中英），Note 写清：仅 Windows、需要 `uv tool install windows-mcp`（或可用的 uvx）、动的是真鼠标键盘、移动鼠标可抢回控制、命令/文件/进程工具已关闭、下一条消息生效。

## Boundaries

- 不改浏览器开关和 `chrome: true` 的语义。
- 不改超管 MCP 的 `--strict-mcp-config` 语义。
- 判定只在服务端请求构建处，渲染层只透传开关。
