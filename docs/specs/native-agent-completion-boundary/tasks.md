# 原生 Agent 完成边界 — 任务

- [x] 调查 Claude Code 2.1.206 与 Codex CLI 0.144.1 的原生多 Agent 生命周期。
- [x] 冻结需求与设计，确认 Claude 使用 Stop Hook 后台状态，Codex 保持根/子线程隔离。
- [x] 添加 Stop Hook 命令、sidecar 解析与 `buildClaudeArgs` 红测。
- [x] 添加 Claude parser 完成分类红测。
- [x] 扩展 done 协议与运行时 `backgroundWorkPending` 状态。
- [x] 门控音效、闪窗、完成光、运行时长、wake timer、延后发送与 Auto-Urge。
- [x] 收紧 unsolicited turn-start gate，并在 active stream 中持续过滤 sidechain。
- [x] 补齐 Claude/Codex 定向回归并确认红转绿。
- [x] 运行 `pnpm test:quality`。
- [x] 运行 `pnpm electron:build`，报告 zip 与可运行目录。
- [x] 使用 `pnpm dev:restart` 重启当前 Electron 开发运行时并核验日志/进程。
