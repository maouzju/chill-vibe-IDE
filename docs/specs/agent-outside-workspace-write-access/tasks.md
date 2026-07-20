# Agent 项目外写入权限任务

- [x] 阅读仓库规则、UI 原则、现有权限链和 Agent 高风险删除防护 SPEC。
- [x] 确认当前行为：`workspacePath` 不是统一权限边界，Codex 默认 Full Access，Claude 默认 bypassPermissions。
- [x] 编写 requirements / design / tasks，确定默认开启以保持兼容。
- [x] 红测：默认设置与旧状态迁移保留 `agentOutsideWorkspaceWriteEnabled`。
- [x] 红测：Codex / Claude 请求透传；Codex 关闭后解析为 `workspace-write`，显式更窄 sandbox 优先。
- [x] 红测：直接文件工具和常见 shell 写入不能越过规范化工作区；两个安全开关互相独立。
- [x] 红测：Claude 支持平台注入严格 sandbox、额外读取目录只读；原生 Windows 不注入不支持的 sandbox；keepalive 身份随设置变化。
- [x] 实现 schema、默认值、规范化、reducer 可更新字段和请求映射。
- [x] 实现 Codex sandbox 解析和共享 Hook 项目边界判定。
- [x] 实现 Claude sandbox / Windows Hook 兜底与 keepalive 回收。
- [x] 设置页增加双语开关和说明，更新主题覆盖。
- [x] 更新 `docs/design.md` 与安全防护 SPEC 的相关说明。
- [x] 运行目标测试、`pnpm test:quality` 和双主题视觉回归并审查差异（仅刷新本功能直接影响的 6 张设置快照；全量 theme sweep 的其余 8 项既有无关快照漂移未接受）。
- [x] 运行 `pnpm electron:build`，报告 zip 与可执行目录。
- [x] 重启当前开发运行时并检查端口、进程和日志。
- [x] 明确“开启仅允许请求、不能绕过 Provider/组织/机器策略”的设置文案与 SPEC。
- [x] 用显式开启新开关的回归测试锁定 Codex requirements 仍会安全收窄且不改用户配置。
- [x] 重新运行目标测试、质量、双主题视觉验证、打包与开发运行时重启。
