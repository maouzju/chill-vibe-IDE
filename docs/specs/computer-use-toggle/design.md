# Design: 允许 Agent 使用 Computer Use（浏览器控制）

## Overview

一个全局布尔设置 `computerUseEnabled`，沿"设置 → 请求字段 → provider 启动参数"的既有通道流到两条 CLI：

| 层 | Claude | Codex |
| --- | --- | --- |
| 原生能力 | `--settings` 加 `chrome: true`（装了 Claude in Chrome 扩展时 CLI 自己接入 `mcp__claude-in-chrome__*`） | 无（桌面版专属，见 requirements 背景） |
| 兜底 / 主路径 | `--mcp-config` 注入 `chill_vibe_browser`（`@playwright/mcp`） | `-c mcp_servers.chill_vibe_browser.*` 注入同一个 MCP |
| 提示词 | `getComputerUseInstruction(language)` 追加到 system prompt | 同上，额外提醒必须用 `tool_search` 检索 |

只做一个新模块 `server/computer-use-runtime.ts`，形态对齐 `server/archive-recall.ts` 与 `server/automation-board-runtime.ts`：纯函数拼参数，在 `launchProviderRun` 里和 `adminRuntime` 并列接线。

## Data / Schema

- `shared/schema.ts`
  - `appSettingsSchema.computerUseEnabled: z.boolean().default(false)` + `createDefaultSettings` 默认值。
  - `chatRequestSchema.computerUseEnabled: z.boolean().optional()`（renderer 的 `ChatRequest` 是输出类型，用 default 会迫使所有请求构造点补字段；服务端只认 `=== true`）。
- `shared/default-state.ts` `normalizeAppSettings`：布尔归一，旧存档缺字段回落 `false`。
- `shared/codex-chat-settings.ts`：`CodexChatSettings` / overrides 两个 Pick 各加 `computerUseEnabled`，Claude 与 Codex 分支都透传（这个字段不是 Codex 专属，只是复用了这条"设置→请求"通道）。
- `src/state.ts` `updateSettings` 补丁键联合加 `computerUseEnabled`。

## Runtime (`server/computer-use-runtime.ts`)

```ts
export const computerUseMcpServerName = 'chill_vibe_browser'

export type BrowserMcpLaunch = { command: string; args: string[]; env: Record<string, string> }

export const resolveBrowserMcpLaunch = async (options?: {
  lookup?: (executable: string) => Promise<string[]>   // 默认 where.exe / which
  exists?: (filePath: string) => Promise<boolean>
  execPath?: string                                    // 默认 process.execPath
  isElectron?: boolean
  platform?: NodeJS.Platform
}): Promise<BrowserMcpLaunch | null>
```

定位顺序：

1. `lookup('mcp-server-playwright')` 拿到 npm 全局 shim 路径。win32 shim 在 `<prefix>/mcp-server-playwright.cmd`，`cli.js` 在 `<prefix>/node_modules/@playwright/mcp/cli.js`；POSIX shim 在 `<prefix>/bin/mcp-server-playwright`，`cli.js` 在 `<prefix>/lib/node_modules/@playwright/mcp/cli.js`。存在则 `command = execPath`，`args = [cli.js]`，Electron 下 `env.ELECTRON_RUN_AS_NODE = '1'`（与 archive-recall 一致；隔离 USERPROFILE 下 `npx` 的缓存不可靠，所以优先绝对路径）。
2. 否则 `lookup('npx')` → `command = npx 路径`，`args = ['-y', '@playwright/mcp@latest']`。
3. 都没有 → `null`。

`buildComputerUseCodexRuntimeArgs(launch)` → `-c mcp_servers.chill_vibe_browser.command=…` / `.args=[…]` / `.env.K=…`。
`buildComputerUseClaudeMcpConfig(launch)` → `{ mcpServers: { chill_vibe_browser: launch } }`。
`createComputerUseRuntime(request)` → `request.computerUseEnabled !== true` 返回 `null`；解析失败 `console.warn('[computer-use] …')` 返回 `null`（fail-open）。
`getComputerUseInstruction(language)` → 中/英各一段。

## Wiring (`server/providers.ts`)

- `launchProviderRun`：`adminRuntime` 之后再算 `computerUseRuntime`。
  - Codex：`extraCodexArgs` 追加 `runtimeArgs`，`extraSystemPrompt` 追加指令。
  - Claude：system prompt 追加指令；`launchClaudeRun` 新增参数 `computerUseMcpConfig`，两条启动路径（单发 / keepalive）都透传到 `buildClaudeArgs` 的 `options.computerUseMcpConfig`。
- `buildClaudeArgs`：
  - `--mcp-config` 的 JSON 由 `workspaceAdminMcpConfig` 与 `computerUseMcpConfig` 的 `mcpServers` 合并而来；`--strict-mcp-config` 只在超管配置存在时追加（保持超管的权限边界语义不变）。
  - `--settings` 在 `request.computerUseEnabled === true` 时写 `chrome: true`；关闭时不写这个键（省略 = 继承用户 settings.json，与 `env` 键同一条规则）。
- keepalive 池签名（`buildClaudeKeepaliveSignature`）加 `computerUse` 布尔。

## UI

- `src/App.tsx` 安全开关组（`agentOutsideWorkspaceWrite` / `codexDestructiveCommandProtection` / `attackPatternProtection` / `codexIsolatedHome` 那一列）末尾加一个 `settings-hover-detail` 开关，`id` 为 `${idPrefix}-computer-use`。
- `shared/i18n.ts` 新增 `computerUseLabel` / `computerUseNote`（中英）。Note 里说明：Claude 装了 Claude in Chrome 扩展时优先走扩展；否则两条 CLI 都用 Playwright MCP，需要 `npm i -g @playwright/mcp`（或可用的 `npx`）。

## Boundaries

- 不改超管 MCP 的 `--strict-mcp-config` 语义。
- 不给 Codex 传 `features.computer_use`（实测空操作，传了只会误导后来人）。
- 不在渲染层判断"要不要带"，判定只在请求构建处（同 `adminAccess` 的注释理由）。
