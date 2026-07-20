# Codex 管理策略自动适配

## 背景

Chill Vibe 已允许用户在设置中控制 Agent 是否可写项目外文件，但 Codex app-server 当前仍会先按 IDE 请求上限启动线程，遭到本机或组织 requirements 拒绝后才降级。这会让用户反复看到“管理策略不允许原沙箱”的提示，误以为 IDE 无法管理权限。

## 需求

1. Codex app-server 支持 `configRequirements/read` 时，Chill Vibe 必须在创建或恢复线程前读取允许的审批与沙箱范围。
2. IDE 应在用户设置所表达的权限上限内，自动选择管理策略允许的最宽沙箱：`danger-full-access → workspace-write → read-only`。
3. 自动适配成功时不得先提交一个已知会被拒绝的线程请求，也不得弹出降权告警。
4. 旧版 Codex 不支持 requirements 查询时，保留现有“失败后逐级收窄”的兼容路径。
5. 设置文案必须明确：该开关决定 Chill Vibe 的请求上限，实际运行会自动服从 Codex、本机或组织管理策略，不会修改或绕过系统策略。

## 验收

- 管理策略只允许 `workspace-write` 时，首个 `thread/start` 就使用 `workspace-write`。
- 不产生“管理策略不允许原沙箱”的日志。
- 无 requirements 或旧 CLI 的既有行为保持兼容。

