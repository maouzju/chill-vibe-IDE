# Codex CLI 能力追平需求

## 背景

本机 Codex CLI 0.130.0 已经在 `codex app-server` 协议里暴露更细的执行控制能力：按 turn/thread 指定 approval policy、approval reviewer，以及 workspace-write 沙箱的网络访问和额外可写目录。Chill Vibe 目前只固定传 `approvalPolicy: 'never'`，并且 workspace-write 不区分网络访问，导致 IDE 里的 Codex 执行控制落后于当前 CLI。

## 需求

1. Chill Vibe 的 Codex app-server 请求必须能表达当前 CLI 支持的 approval policy，至少支持：
   - `never`：保持现有无审批自动执行行为。
   - `on-request`：让 Codex 在需要时发起审批请求。
2. workspace-write 沙箱必须能表达网络访问开关：
   - 默认仍关闭网络，保持现有安全边界。
   - 当请求显式开启时，传给 app-server 的 `sandboxPolicy.networkAccess` 必须为 `enabled`。
3. 新能力必须兼容旧保存状态：旧卡片没有新字段时按现有行为运行。
4. 现阶段先补齐后端协议与持久化能力，不强行改变默认 UI 行为。
5. 不能影响 Claude 路由，也不能绕过已有 provider profile / proxy 路由。

## 非目标

- 不实现完整 Codex Desktop/TUI 的审批交互界面。
- 不接入 Codex Cloud、remote-control、plugin marketplace 管理 UI。
- 不改变默认安全策略：默认仍为 `approvalPolicy=never`、网络关闭。
