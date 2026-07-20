# Agent 项目外写入权限需求

## 背景

当前 `workspacePath` 只是 Agent CLI 的工作目录，不是统一的文件系统权限边界：

- 普通 Codex 会话默认使用 `danger-full-access`；
- 普通 Claude 会话默认使用 `bypassPermissions`；
- Chill Vibe 额外注入的高风险删除防护会拦截常见的项目外递归删除，但它不等于“所有项目外写入都被禁止”。

用户需要在设置中直接决定：Agent 是否可以修改当前项目文件夹之外的文件，同时保留现有默认行为，避免升级后突然打断已有工作流。

## 需求

1. 在 `AppSettings` 增加全局布尔设置 `agentOutsideWorkspaceWriteEnabled`。
2. 新安装、旧状态缺字段时默认 `true`，即保持当前“允许项目外写入”的兼容行为；显式关闭必须被持久化和恢复。
3. 设置页“Agent 安全防护”区域增加“允许 Agent 修改项目文件夹外的文件”开关，并用简短说明讲清：
   - 开启：允许 Chill Vibe 请求当前 Full Access / bypass 权限，但不承诺突破 Codex、Claude、组织或机器级策略；
   - 关闭：尽可能把写入限制在当前项目和运行所需临时目录；
   - 读取用户级 Skill、配置和附件不因该开关被一并禁止。
4. 所有普通聊天、恢复/重试、Claude keepalive、Brainstorm 和 Git Agent 请求都必须携带该设置；调用方显式指定的更窄权限（例如 `read-only`）优先。
5. Codex 在设置关闭时使用 `workspace-write`，开启时保持 `danger-full-access`；管理员 requirements 仍可继续把权限收窄，Chill Vibe 不得绕过。
6. Claude 在设置关闭时：
   - `Edit` / `Write` / `NotebookEdit` 等直接文件工具不得写到规范化后的项目路径之外；symlink/junction 逃逸也必须按真实路径阻止；
   - macOS、Linux 和 WSL2 使用 Claude 官方严格 Bash sandbox，项目目录和会话临时目录可写，项目外额外读取目录保持只读，网络能力不因本设置被额外关闭；
   - 原生 Windows 因 Claude 官方 Bash sandbox 不受支持，使用 Chill Vibe `PreToolUse` 防护拦截直接文件写入和常见项目外 shell 写入形式；文案必须明确这不是完整 OS 沙箱。
7. “高风险删除命令防护”与“项目外写入”是两个独立开关：即使用户关闭高风险删除防护，只要项目外写入关闭，项目边界防护仍必须生效；反之亦然。
8. Claude keepalive 进程身份必须包含该设置及派生出的 sandbox/hook 配置；切换后不得复用旧权限进程。
9. 边界防护所需 Hook 或严格 sandbox 无法安全启动时，本次运行必须失败关闭并给出可理解的环境错误，不能静默恢复到更宽权限。
10. 更新架构文档，明确 `workspacePath` 的默认权限语义和新设置的跨 Provider 差异。
11. 开关只表达 Chill Vibe 的权限请求上限；Provider、组织或机器级策略继续拥有最终收紧权，设置文案不得让用户误以为应用可以绕过这些约束。

## 非目标

- 不实现虚拟机、容器或完整 Windows OS 沙箱。
- 不禁止 Agent 读取项目外的用户级 Skill、CLI 配置或用户主动附加的文件。
- 不提供逐项目白名单或多个额外可写目录；本切片只有一个全局“允许/不允许项目外写入”开关。
- 不改变审批模式、网络设置、高风险删除防护或 Codex 隔离主目录开关的既有默认值。
