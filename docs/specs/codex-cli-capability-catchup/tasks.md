# Codex CLI 能力追平任务

- [x] 对照本机 Codex CLI 0.130.0 help / app-server schema，确认缺口。
- [x] 写 SPEC，限定第一片补齐范围。
- [x] 加红测：Codex app-server payload 支持 on-request 审批和 workspace-write 网络开关。
- [x] 扩展 ChatRequest schema，暂不落持久化状态。
- [x] 扩展 provider app-server 参数映射。
- [x] 跑目标测试和质量检查。
- [x] 重启当前开发运行时。

## 后续可补（明确不属于本次发布）

- [ ] 给 UI 增加 per-card / per-run 控制入口：审批策略、workspace-write 网络开关、额外可写目录。
- [ ] 对接 app-server 的审批请求事件，让 `on-request` 不只是协议可表达，而是能在 IDE 内完成批准/拒绝。
- [ ] 继续评估 Codex CLI 0.130.0 的 cloud / plugin / remote-control / hooks / goals / review 等能力，按产品价值分片补齐。

## 托管权限兼容

- [x] 加红测：管理员策略禁止 `danger-full-access` 时，默认 Codex 会话自动改用允许的最宽沙箱并完成。
- [x] 加红测：workspace-write 的 `networkAccess` 必须为 boolean，覆盖开关两种状态。
- [x] 实现 `configRequirements/read` 解析与旧 CLI 的逐级沙箱回退，不写回用户权限配置。
- [x] 修正 workspace-write app-server payload，移除错误的字符串网络权限值。
- [x] 加强 Hook 信任写入断言，确保唯一持久化键仍是 `hooks.state`。
- [x] 运行针对性 provider 测试、`pnpm test:quality`、`pnpm electron:build`，并重启当前 Electron 开发运行时。
