# Codex CLI 能力追平设计

## 数据模型

在共享 schema 中增加 Codex 执行控制字段：

- `approvalPolicy?: 'never' | 'on-request'`
- `networkAccessEnabled?: boolean`

字段先只出现在 `ChatRequest`：

- `ChatRequest` 用于从 renderer 传到 server/provider。
- 本切片先不把它落到 `ChatCard` 持久化，避免 UI 尚未提供入口时扩大状态迁移面。

默认值保持现有行为：

- `approvalPolicy = 'never'`
- `networkAccessEnabled = false`

## app-server 映射

- `thread/start` 与 `thread/resume`：传入归一化后的 `approvalPolicy`，让线程级配置跟当前卡一致。
- `turn/start`：传入同样的 `approvalPolicy`，确保单次请求也能覆盖。
- `sandboxPolicy`：
  - `read-only`：继续 `readOnly`，网络恒为 false。
  - `workspace-write`：继续 `workspaceWrite`，当 `networkAccessEnabled=true` 时传 `networkAccess: 'enabled'`，否则传 `restricted`。
  - `danger-full-access`：保持 `dangerFullAccess`。

## 兼容策略

旧 Codex app-server 若不支持这些字段，已有请求错误路径会按现有方式暴露错误；本次不做额外降级，因为 `approvalPolicy` 已是既有字段，`networkAccess` 是 sandboxPolicy 的子字段。

## 验证策略

- 先新增单元测试，证明 `on-request + workspace-write + networkAccessEnabled` 会进入 app-server JSON-RPC payload。
- 再实现 schema/default-state/state-store/provider 映射。
- 跑目标测试文件和 `pnpm test:quality`。
