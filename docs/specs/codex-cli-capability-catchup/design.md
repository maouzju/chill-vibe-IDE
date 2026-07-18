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
  - `workspace-write`：继续 `workspaceWrite`，把 `networkAccessEnabled` 归一化为布尔值
    `networkAccess: true | false`。Codex 0.144.1 的 app-server schema 明确要求 boolean，
    不能沿用 `externalSandbox` 使用的 `enabled` / `restricted` 字符串枚举。
  - `danger-full-access`：保持 `dangerFullAccess`。

## 兼容策略

旧 Codex app-server 若不支持这些字段，已有请求错误路径会按现有方式暴露错误；
`approvalPolicy` 已是既有字段，`workspaceWrite.networkAccess` 使用协议要求的 boolean。

## 验证策略

- 先新增单元测试，证明 `on-request + workspace-write + networkAccessEnabled` 会进入 app-server JSON-RPC payload。
- 再实现 schema/default-state/state-store/provider 映射。
- 跑目标测试文件和 `pnpm test:quality`。

## 托管权限冲突恢复

Codex app-server 在 `thread/start` / `thread/resume` 合并请求参数与管理员
`requirements` 时，可能拒绝 Chill Vibe 的默认
`approvalPolicy=never + danger-full-access`。恢复流程保持在单次 provider 运行内：

1. 仅当错误明确来自 `requirements` 且指出当前沙箱不被允许时进入恢复。
2. 优先调用 `configRequirements/read` 读取当前进程已经解析好的有效约束；新 CLI
   可从 `allowedSandboxModes` 或内置 `allowedPermissionProfiles` 得出允许的沙箱。
3. 按 `danger-full-access → workspace-write → read-only` 选择仍被允许的最宽模式；
   当前模式已被拒绝，因此实际回退只会选择其后的候选项。
4. 若旧 CLI 不支持读取约束，则依次尝试更窄的内置模式；只有同类
   `requirements` 冲突才继续尝试，其他错误立即按原路径返回。
5. 更新本次运行内的 `currentRequest`，确保后续 `turn/start` 使用同一沙箱；不更新
   Chill Vibe 持久化状态，也不调用 Codex 配置写接口修改权限字段。
6. 记录一条简短兼容日志，说明管理员策略已把本次运行收窄到哪个模式。
