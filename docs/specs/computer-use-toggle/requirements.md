# Requirements: 允许 Agent 使用 Computer Use（浏览器控制）

## Goal

- 在设置里提供一个开关，打开后 Chill Vibe 里的 Claude 与 Codex 会话都能拿到浏览器控制（computer use）工具，可以替用户打开网页、点击、填表、读取页面状态。
- 两条 CLI 的原生能力差异对用户透明：用户只关心"能不能用"，不需要知道 Claude in Chrome、Playwright MCP、tool_search 这些细节。
- 默认关闭：浏览器控制会以用户身份操作已登录的网站，属于高权限能力，必须显式开启。

## 背景（2026-09-21 实测，决定了设计取向）

- **Claude CLI 2.1.263**：`--chrome` / `--settings.chrome=true` 只在用户装了 Claude in Chrome 扩展 + native host 时生效；本机未装，`claude -p --chrome` 的工具表里 `mcp__` 工具为 NONE。经 `--mcp-config` 注入 `@playwright/mcp` 后，工具表立即出现 `mcp__chill_vibe_browser__browser_navigate` 等 20+ 个浏览器工具。
- **Codex CLI 0.153.4**：`features.computer_use` / `browser_use` 已默认 `true`，但那是桌面版专属能力（`computer-use@openai-bundled` / `chrome@openai-bundled` 插件只随 Codex Desktop 分发，`codex plugin add` 报 not found）；exec / app-server 的工具表里没有任何 computer 工具，显式 `-c features.computer_use=true` 也是空操作。经 `-c mcp_servers.chill_vibe_browser.*` 注入 `@playwright/mcp` 后，`tool_search` 的来源列表出现 `chill_vibe_browser`，模型按需检索即可拿到浏览器工具。
- `claude --mcp-config <json>` 是可变参数（`<configs...>`），JSON 后面紧跟的位置参数会被当成第二个配置文件路径吞掉；Chill Vibe 的 argv 里它后面永远是 `--add-dir` / `--settings` 这类 flag，提示词在最后，所以安全，但新增参数时不能把位置参数排在它后面。

## User Stories

- 作为用户，我在设置里打开"允许 Agent 使用浏览器（Computer Use）"后，无论这张卡是 Claude 还是 Codex，让它"打开 xx 网站登录并复制 key"都能真的去操作浏览器，而不是回答"当前会话没有浏览器控制工具"。
- 作为用户，我装了 Claude in Chrome 扩展时，希望 Claude 优先走原生扩展（能操作我已登录的 Chrome 标签页）；没装时也要有可用的兜底浏览器。
- 作为维护者，我希望这条能力和超管 MCP 一样只在开关打开的回合注入，关闭后不残留；并且 Playwright MCP 找不到时 fail-open（正常聊天不受影响，只是没有浏览器工具并留日志）。

## Acceptance Criteria

- [ ] AC1 设置面板（安全开关组）新增"允许 Agent 使用浏览器（Computer Use）"开关，默认关闭；`normalizeAppSettings` 对旧存档补默认值。
- [ ] AC2 开关打开时，Claude 回合的 `--settings` 带 `chrome: true`（装了扩展的用户自动走 Claude in Chrome），并经 `--mcp-config` 注入名为 `chill_vibe_browser` 的 Playwright MCP；与超管 MCP 同时存在时合并进同一个 `--mcp-config` JSON。
- [ ] AC3 开关打开时，Codex 回合的 app-server argv 带 `-c mcp_servers.chill_vibe_browser.command/args/env`，并在系统提示里告诉模型要用 `tool_search` 检索 `chill_vibe_browser` 的工具。
- [ ] AC4 开关关闭时，两条 CLI 的 argv 里都没有 `chill_vibe_browser`，Claude 的 `--settings` 里没有 `chrome` 键（不覆盖用户自己的 settings.json）。
- [ ] AC5 Playwright MCP 的定位顺序：全局安装的 `@playwright/mcp`（通过 `mcp-server-playwright` shim 反推 `cli.js`，用绝对 node/electron-as-node 启动，不依赖隔离 USERPROFILE 下的 npx 缓存）→ `npx -y @playwright/mcp@latest` → 都没有则不注入并 `console.warn`。
- [ ] AC6 keepalive 池签名包含这个开关：切换后下一回合重启 CLI 进程，而不是复用没有浏览器工具的旧进程。
- [ ] AC7 打开开关的回合，系统提示追加一段说明（中英文），告诉模型浏览器工具的名字前缀、先 `browser_snapshot` 再操作、以及涉及登录/支付等敏感动作要先问用户。

## Out of Scope

- 自己实现浏览器驱动或 CDP 桥；只复用 Playwright MCP / Claude in Chrome。
- 帮用户安装 Claude in Chrome 扩展或 `@playwright/mcp`（设置说明里给出安装命令即可）。
- 按卡片粒度的开关；本期只做全局设置。
- 手机远程监工端的开关同步。
