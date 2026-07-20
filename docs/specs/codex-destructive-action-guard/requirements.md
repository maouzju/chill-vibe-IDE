# Agent 破坏性操作防护需求

## 背景

近期公开事故显示，编码 Agent 可能因为 `$HOME` / `$home` 变量解析、临时目录清理、挂载点或过度主动执行而删除用户主目录或真实仓库。Chill Vibe 当前默认让普通 Codex 对话使用 `danger-full-access + approvalPolicy=never`，Claude 对话使用 `bypassPermissions`；两种 CLI 的工作区路径都只是工作目录，并不是文件系统边界。

本需求不改变现有 Codex sandbox / approval 或 Claude permission mode，也不增加普通命令的逐次审批弹窗，而是在 IDE 侧增加默认开启、可关闭、有明确说明的防御层。

## 调查依据（截至 2026-07-17）

- [openai/codex#32684](https://github.com/openai/codex/issues/32684)：Windows PowerShell 大小写不敏感，子 Agent 把 `$home` 当临时变量赋值失败后仍继续执行 `Remove-Item -Recurse -Force`，公开报告称真实 `%USERPROFILE%` 被递归删除。
- [openai/codex#33557](https://github.com/openai/codex/issues/33557)：Linux 子 Agent 把真实仓库 bind-mount 到 Python `TemporaryDirectory` 下，异常退出触发 `shutil.rmtree` 穿过仍活跃的挂载点，公开报告称真实仓库内容丢失。
- [openai/codex#33624](https://github.com/openai/codex/issues/33624)：汇总 Mac 主目录删除公开报道并请求 Full Access 下仍有不可绕过的批量删除门槛；该条是社区安全提案，不等同于 OpenAI 已完成根因确认。
- [OpenAI GPT-5.6 Preview System Card](https://deploymentsafety.openai.com/gpt-5-6-preview/gpt-5-6-preview.pdf) 第 7.2 节：官方说明 GPT-5.6 Sol 相比前代更可能过度持续执行并超出用户意图，长链路编码 Agent 需要监督；公开示例包括替换用户指定 VM、杀进程并强制移除 worktree，造成未提交内容可能丢失。
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)：Claude CLI 支持 `PreToolUse` command hook，`Bash` 工具执行前会把 `tool_name`、`tool_input.command` 和 `cwd` 通过 stdin 交给 Hook；Hook 退出码 `2` 会阻止工具调用并把 stderr 原因反馈给 Claude。设置级 Hook 同样覆盖子 Agent 工具调用。

前三项仍是公开 GitHub 用户报告，不能表述为 OpenAI 已公开确认全部事实；但官方系统卡确认了同一类“过度主动、破坏性动作超出范围”的风险，因此 IDE 侧需要独立于模型判断的执行前防护。

## 需求

1. 设置中使用独立、无需在长模型表单中查找的“Agent 安全防护”卡片，包含两个安全开关，并且新安装和旧状态升级后都默认开启：
   - **阻止 Agent 高风险删除命令**：在 Codex 或 Claude CLI 的 shell 工具真正执行前检查破坏性操作。
   - **使用隔离的 Agent 主目录**：让 Codex 及其命令看到 IDE 管理的 `HOME` / `USERPROFILE`，降低错误展开真实主目录的风险。
2. 两个开关必须在中文和英文设置界面中提供简短、准确的说明：
   - 明确命令防护同时覆盖 Codex 和 Claude CLI，隔离主目录当前只应用于 Codex；
   - 明确它们不改变 Codex 的 Full Access / approval 或 Claude 的 permission mode；
   - 明确防护会阻止疑似机器级、工作区根级或不可恢复的数据删除；
   - 明确隔离主目录不是完整虚拟机，绝对路径或系统 API 仍需要命令防护兜底。
3. “阻止 Agent 高风险删除命令”开启时，Chill Vibe 必须通过 Codex 和 Claude CLI 各自的 `PreToolUse` Hook 在执行前拦截，至少覆盖：
   - PowerShell 中给 `$home`（任意大小写）赋值后继续执行递归删除的事故模式；
   - `rm -rf` / `Remove-Item -Recurse -Force` / `rmdir /s` / `del /s` 等递归删除；
   - `shutil.rmtree`、Node `fs.rm(... recursive ...)`、.NET 递归目录删除等常见脚本形式；
   - `git clean -f`、`git reset --hard`、工作区级 `git restore` 等可能直接丢失未提交数据的命令；
   - 把真实路径 bind-mount 到会自动递归清理的 `TemporaryDirectory` 等已知高风险组合；
   - 删除目标为用户主目录、盘符或文件系统根、工作区根或其祖先、`.git`、Codex 配置目录、Chill Vibe 数据目录；
   - 删除目标位于工作区之外，或仍含未解析变量、递归通配符、`.` / `..`、相对路径及其他无法安全确定范围的表达式。
4. 普通项目内的明确目标清理（例如使用规范化绝对路径删除工作区内的 `dist`、`node_modules`、单个临时目录）不能被无差别拦截。由于当前 Codex Hook 输入不包含 shell 工具单独指定的 `workdir`，递归删除的相对目标必须失败关闭并提示改用工作区内绝对路径。
5. 安全 Hook 必须由 Chill Vibe 注入，并在 `thread/start` / `thread/resume` 前确认已启用且已信任。不能使用会顺带信任项目或用户其他 Hook 的全局 bypass 参数。
   所有并行卡片必须共享稳定的 session-flags Hook 命令/hash；每次运行不同的工作区和受保护路径只能通过该 Codex 子进程独立环境传入，不能写进 Hook 命令或 launcher 文件名，否则 Codex 相同的 positional trust key 会在卡片间反复变成 `modified`。
6. 如果本地 Codex CLI 不支持所需 Hook RPC、Hook 无法安装/信任或复查仍未生效，本次 Codex 运行必须以不可自动恢复的环境初始化错误失败关闭，并在卡片中给出可理解的提示；不能静默降级、自动重试或继续执行线程/命令。
7. 安全 Hook 必须在同一 Codex 线程的子 Agent 工具调用上生效，不能只保护父 Agent。
8. Claude CLI 防护必须复用同一套判定脚本与受保护路径环境，并满足：
   - 通过本次 Claude 运行的 `--settings` 注入 `PreToolUse` / `Bash` command hook，不修改用户的全局或项目设置文件；
   - Hook 使用退出码 `2` 阻止命令，并与用户已有 Hook 并存；
   - 普通单次运行、Electron keepalive 长驻进程、恢复/重试、Brainstorm 及 Git Agent 的 Claude 请求使用相同开关；
   - 防护设置变化必须让旧 keepalive 进程失效并按新配置重建，不能继续复用旧签名进程；
   - Hook 在 Claude 子 Agent 的 Bash 调用中同样生效。
9. “使用隔离的 Agent 主目录”开启时：
   - 为 Codex 运行创建 Chill Vibe 数据目录下的隔离 home；
   - Windows 设置隔离的 `USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`，让 PowerShell 自动变量 `$HOME` 指向隔离目录，同时保留已有 `HOME` 以兼容 Git 等工具；macOS/Linux 设置隔离的 `HOME`；
   - 显式保留原始 `CODEX_HOME`，确保登录、配置、会话与 Skill 仍可用；
   - 关闭开关后保持当前环境继承行为。
10. 命令防护开关必须进入 `AppSettings` 持久化、旧状态规范化和所有 `ChatRequest`；隔离主目录仍只透传给 Codex。旧字段名可以为兼容保存状态继续保留，但产品文案不得再暗示命令防护只覆盖 Codex。

## 非目标

- 本切片不实现完整虚拟机、容器或 OS 级沙箱。
- 本切片不承诺静态识别任意二进制或任意外部脚本内部的全部文件操作。
- 本切片不实现删除隔离回收站、全盘备份或 Windows Job Object 进程树治理；这些作为后续加强项。
- 本切片自身不改变 `danger-full-access`、`workspace-write`、`approvalPolicy`、Claude `bypassPermissions` 的既有默认值。后续的 `agent-outside-workspace-write-access` SPEC 增加了默认开启的独立设置：用户关闭后，单次运行会收窄项目外写入，但仍不改变这些默认值的兼容基线。
- 本切片不为 Claude 增加隔离主目录；Claude 仍依赖共享命令防护兜住高风险删除。
