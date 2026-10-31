# Requirements: 允许 Agent 操控电脑桌面（Windows 桌面自动化 MCP）

## Goal

- 设置里新增一个开关，打开后 Chill Vibe 里的 Claude 与 Codex 会话都能拿到 Windows 桌面操控工具：截屏、读窗口与控件树、点击、输入、滚动、拖拽、快捷键、启动/切换应用、读写剪贴板。
- 和浏览器开关（`docs/specs/computer-use-toggle/`）并列、互相独立：浏览器开关管网页，桌面开关管整个 Windows 桌面上的任意应用。
- 默认关闭：桌面操控会以用户身份动真实的鼠标键盘，属于高权限能力，必须显式开启。

## 背景（2026-10-31 调研，决定了设计取向）

- Claude Code CLI 与 Codex CLI 在 IDE 路径里都没有原生桌面 computer use（见 computer-use-toggle 背景与 pitfall #383）；能用的只有 MCP。
- 选型 **Windows-MCP**（PyPI `windows-mcp`，CursorTouch，MIT，0.8.x，`requires_python >= 3.14`）：
  - 基于 Windows UI Automation，`Snapshot` 能给出带编号的可交互控件，不只靠截图猜坐标；`Screenshot` 是快速截图通道。
  - 工具：Click / Type / Scroll / Move / Shortcut / Wait / WaitFor / ControlStatus / DisplayInventory / Screenshot / Snapshot / App / Clipboard / Scrape / MultiSelect / MultiEdit / Notification，外加 PowerShell / FileSystem / Process / Registry。
  - 用户物理移动鼠标或按 `Ctrl+Alt+Shift+Backspace` 会抢回控制权（best-effort）。
  - 默认带 PostHog 匿名遥测，`ANONYMIZED_TELEMETRY=false` 关闭。
  - 支持 `--exclude-tools` 关掉指定工具。
- 被否决的备选：npm `computer-use-mcp`（nut.js，纯坐标点击，没有控件树，在 200% DPI 屏上点偏的风险更高）。

## User Stories

- 作为用户，我在设置里打开「允许 Agent 操控电脑桌面」后，让 Claude 或 Codex「打开记事本写一段话」「在某个桌面软件里点某个按钮」，它能真的去操作，而不是回答「我没有电脑操控工具」。
- 作为用户，我不希望桌面工具变成绕过 Chill Vibe 危险命令防护的后门：Agent 跑命令、改文件、杀进程仍然只走 CLI 自带、受防护约束的那条路。
- 作为维护者，我希望它和浏览器 / JEV MCP 一样只在开关打开的回合注入，关闭后不残留；Windows-MCP 不可用（没装 uv、非 Windows）时 fail-open（正常聊天不受影响，只是没有桌面工具并留日志）。

## Acceptance Criteria

- [ ] AC1 设置面板安全开关组新增「允许 Agent 操控电脑桌面（Windows）」开关，紧挨浏览器开关，默认关闭；`normalizeAppSettings` 对旧存档补默认值。
- [ ] AC2 开关打开时，Claude 回合经 `--mcp-config` 注入名为 `chill_vibe_desktop` 的 Windows-MCP，与浏览器 / JEV MCP 合并进同一个 JSON；Codex 回合带 `-c mcp_servers.chill_vibe_desktop.*`。
- [ ] AC3 启动参数固定带 `serve --transport stdio --exclude-tools PowerShell,FileSystem,Process,Registry`，环境变量带 `ANONYMIZED_TELEMETRY=false`。
- [ ] AC4 启动方式定位顺序：已安装的 `windows-mcp` 可执行文件（`uv tool install windows-mcp`）→ `uvx windows-mcp` → `uv tool run windows-mcp`；PATH 找不到时再查 `~/.local/bin`；都没有则不注入并 `console.warn('[desktop-control] …')`。非 Windows 平台直接不注入。
- [ ] AC5 Codex 侧给这个 MCP 设 `startup_timeout_sec`，覆盖 uvx 首次拉依赖的冷启动。
- [ ] AC6 开关关闭时两条 CLI 的 argv 里都没有 `chill_vibe_desktop`。
- [ ] AC7 keepalive 池签名包含这个开关：切换后下一回合重启 Claude CLI 进程。
- [ ] AC8 打开开关的回合，系统提示追加一段说明（中英）：工具前缀、先 Screenshot/Snapshot 再操作、敏感/不可逆动作先确认、跑命令改文件仍用自带工具、不要说自己没有电脑操控工具；Codex 版提示先 `tool_search`。

## Out of Scope

- macOS / Linux 桌面操控。
- 替用户自动安装 uv 或 Windows-MCP（设置说明里给安装命令）。
- 按卡片粒度的开关；本期只做全局设置。
- 手机远程监工端的开关同步。
