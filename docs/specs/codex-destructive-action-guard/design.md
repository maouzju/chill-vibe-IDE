# Agent 破坏性操作防护设计

## 1. 设置与请求模型

在 `AppSettings` 增加：

- `agentOutsideWorkspaceWriteEnabled: boolean`，默认 `true`（由后续项目外写入 SPEC 增加）；
- `codexDestructiveCommandProtectionEnabled: boolean`，默认 `true`；
- `codexIsolatedHomeEnabled: boolean`，默认 `true`。

在 `ChatRequest` 增加同名字段并默认 `true`。为兼容已有保存状态，持久化字段暂时继续使用 `codexDestructiveCommandProtectionEnabled`，但请求映射会把该命令防护开关同时透传给 Codex 与 Claude；`codexIsolatedHomeEnabled` 仍只透传给 Codex。普通聊天、恢复、Brainstorm 和 Git Agent 复用同一路径。

旧保存状态通过 `normalizeAppSettings()` 回落到默认开启。设置 reducer 的可更新字段列表同步扩展。

## 2. 设置 UI

使用独立的“Agent 安全防护”设置卡放置三个普通 `settings-toggle`，并排在设置卡列表前部，避免用户必须在很长的“模型”卡中向下查找：

1. 允许 Agent 修改项目文件夹外的文件；
2. 阻止 Agent 高风险删除命令（Codex + Claude CLI）；
3. 使用隔离的 Codex Agent 主目录。

每个开关紧跟一段 `settings-note`，不用警告色常驻轰炸用户；防护是默认、安全、安静的基础能力。设置页的弹出式与完整面板两处复用同一个渲染 helper，避免文案或行为漂移。

## 3. Codex 运行准备

新增 `server/codex-safety.ts`，在启动 app-server 前完成：

1. 根据 `cardId`（缺失时使用工作区哈希）创建 `getAppDataDir()/codex-agent-homes/<key>`；
2. 记录真实 home、`CODEX_HOME`、Chill Vibe 数据目录和工作区路径，供 Hook 判定受保护根；
3. 当隔离 home 开启时，Windows 覆盖 `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH`（PowerShell `$HOME` 随之隔离）并保留既有 `HOME` 以兼容 Git；macOS/Linux 覆盖 `HOME`；所有平台都显式设置原始 `CODEX_HOME`；
4. 当命令防护开启时，在 `getAppDataDir()/codex-safety/` 生成一个稳定的平台 launcher；launcher 使用进程环境中的 Electron/Node 可执行文件和 guard 脚本路径，以 Node 模式执行防护脚本，因此不依赖系统安装 Node；
   Hook 命令、launcher 路径和内容在所有卡片间保持一致，使 Codex 的 positional session-flags trust key 始终对应同一 hash。真实 home、工作区、`CODEX_HOME` 和数据目录通过每个 Codex app-server 子进程自己的 `CHILL_VIBE_*` 环境传入，避免并行卡片互相覆盖；
5. 向 Codex CLI 追加 session-flags Hook 配置，只增加 Chill Vibe 自己的 `PreToolUse` command hook，不使用 `--dangerously-bypass-hook-trust`。

Codex Hook matcher 覆盖 shell、`apply_patch` / `Edit` / `Write` / `NotebookEdit`。高风险删除硬防护集中在 shell command；项目外写入关闭时，直接文件工具和常见 shell 写入目标也会做真实路径边界校验。

## 4. Hook 信任握手

app-server `initialize` 后、线程启动前：

1. 调用 `hooks/list`；
2. 按 `source=sessionFlags`、命令路径和事件类型定位 Chill Vibe Hook；
3. 若为 `untrusted` / `modified`，调用 `config/batchWrite`，向 `hooks.state` 写入该 Hook 的 `trusted_hash`；
4. 再次调用 `hooks/list`，确认 `enabled=true` 且 `trustStatus=trusted`；
5. 任一步失败都以 `env-setup` 错误终止本次运行并返回“Codex 安全防护初始化失败”的明确提示；Renderer 不得把它归类为可恢复断流，也不得继续 `thread/start` / `turn/start`。

这样只信任 Chill Vibe 注入的精确 Hook 哈希，不会顺带放行仓库或用户目录中的其他未信任 Hook。

## 5. 防护脚本

新增可独立运行和单测的 `server/codex-destructive-command-guard.js`：

- 从 stdin 读取 `PreToolUse` JSON；
- 提取 `tool_name`、`tool_input.command`、`cwd`；
- 对常见 shell / PowerShell / Python / Node / .NET / Git 破坏性模式做风险识别；
- 提取删除目标，展开常见 home 环境变量并规范化绝对路径；
- 对真实 home 及工作区外的 home 子树、工作区根/祖先、盘符根、`.git`、`CODEX_HOME`、Chill Vibe 数据目录做硬保护；
- 对工作区外目标、未解析变量、命令替换、递归通配符、`.` / `..`、相对目标和无法确定目标的机器级递归删除做拒绝；当前 Hook 不暴露工具级 `workdir`，因此只有规范化后仍位于工作区子树内的绝对目标能通过；
- 对 `TemporaryDirectory` 与 bind mount 的已知危险组合直接拒绝；Linux 还读取 `/proc/self/mountinfo`，当递归目标本身或后代是活跃挂载点时拒绝，避免异常清理穿过真实挂载内容；
- 安全时退出 `0`；拒绝时把人类可读原因写入 stderr 并退出 `2`，使用 Codex Hook 的正式阻断语义；
- 脚本自身解析异常也退出 `2`，尽量失败关闭。

为减少误伤，明确使用绝对路径、位于工作区内部且不是根、祖先、`.git` 或通配符的普通目录允许删除。

## 6. Claude 运行准备

Claude 复用 Codex 已有的 launcher、防护脚本和 `CHILL_VIBE_PROTECTED_*` 进程环境，不复制第二套规则：

1. Claude 运行前只准备命令防护环境，不启用 Codex 隔离 home；
2. `buildClaudeArgs()` 在已有的 session-level `--settings` JSON 中追加 `hooks.PreToolUse`，matcher 为 `Bash|Edit|Write|NotebookEdit`；
3. Windows 通过 PowerShell exec-form 执行稳定 launcher，其他平台通过 `/bin/sh` exec-form 执行；Hook 超时 5 秒，退出码 `2` 作为 Claude 官方阻断语义；
4. 不写入 `~/.claude/settings.json` 或项目设置，因此不污染用户配置；Claude 会合并不同设置来源的 Hook，用户已有 Hook 继续生效；
5. keepalive signature 纳入命令防护开关与 Hook 命令，切换设置后旧进程会被回收并按新配置重建；
6. CLI 设置级 `PreToolUse` Hook 会随同一会话的子 Agent Bash 工具调用执行。

## 7. 错误与可见反馈

Hook 拒绝结果会作为工具失败反馈返回 Codex，模型可以选择更安全的替代方案。若 Hook 本身未准备好，provider 在任何线程/命令执行前直接向现有错误流返回本地安全初始化错误。

设置说明明确：关闭开关会让 Codex 与 Claude CLI 一起恢复原有无额外 IDE 命令防护的行为，但不会改变任何 provider 的权限设置本身。

## 8. 验证

- 默认状态 / 旧状态迁移测试；
- Codex / Claude request override 透传测试；
- 防护判定单测：两起 `$HOME` / `$home` 事故形状、主目录、工作区根、未解析变量、通配符、危险 Git，以及允许工作区内 `dist` / `node_modules`；
- app-server 测试：Hook args 注入、`hooks/list` → trust write → 复查 → thread start 的顺序，以及关闭开关时完全不注入；
- Claude 单次与 keepalive 启动测试：开启时 `--settings` 注入 `PreToolUse` / `Bash` Hook 和受保护路径环境，关闭时不注入；
- 使用本机 Claude CLI 对 session-level Hook 设置做无真实危险命令的解析/加载验证；
- `pnpm test:quality`；
- `pnpm test:theme` 并审查模型设置卡的双主题快照；
- `pnpm electron:build`；
- `pnpm dev:restart` 并检查当前 Electron 开发运行时。
