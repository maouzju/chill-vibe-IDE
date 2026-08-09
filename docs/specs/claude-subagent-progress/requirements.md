# Claude 子代理进度 UI — Requirements

## 背景

用户报告：Claude 派发子代理（`Task` 工具）后，聊天卡片上只剩一句「跑完我把方案给你」和一个通用的「已运行 3 分 24 秒」计时器，无法判断子代理跑了几个、跑到哪一步、是否卡住。

2026-08-09 实测（`claude 2.1.206`，`-p --verbose --output-format stream-json --include-partial-messages`，168 行 stdout）证明这**不是 CLI 的限制**：CLI 在顶层（`parent_tool_use_id` 为空）主动播报一整套子代理进度事件，宿主一行都没接。

实测到的顶层事件：

| 事件 | 关键字段 |
| --- | --- |
| `system:task_started` | `task_id`、`tool_use_id`、`description`、`subagent_type`、`task_type`、`prompt` |
| `system:task_progress` | `task_id`、`description`（当前动作）、`subagent_type`、`last_tool_name`、`usage.{total_tokens,tool_uses,duration_ms}` |
| `system:task_updated` | `task_id`、`patch.{status,end_time}` |
| `system:task_notification` | `task_id`、`status`、`output_file`、`summary` |

现状：`server/providers.ts` 处理 `event.type === 'system'` 时只认 `subtype === 'init'`（见 2754 行附近），其余全部丢弃。全仓库产品代码对 `task_progress` / `subagent_type` 零引用。

根源是一条写错的假设，`server/providers.ts` 2815 行附近注释称「the CLI now runs it silently and waits for it」，据此只放宽了停滞看门狗，没有做任何 UI。

## 目标

1. Claude 派发子代理期间，聊天流中出现与 Codex 一致的「子智能体运行中」面板，实时显示每个子代理的身份、当前动作与状态。
2. 复用既有的 `agents` 活动结构与渲染组件，**不新增 schema、不改渲染层**。
3. 子代理全部结束后面板自然收敛（与 Codex 的 `status` 视图语义一致：只列运行中的子代理）。

## 功能需求

- **FR1**：收到 `system:task_started` 时登记一个子代理，状态为运行中，携带 `subagent_type` 作为角色、`description` 作为名称。
- **FR2**：收到 `system:task_progress` 时更新该子代理的当前动作预览，内容需包含当前动作描述、正在使用的工具名，以及已用时长/工具调用次数等可读的进度量。
- **FR3**：收到 `system:task_updated` 且 `patch.status` 为终态时，将该子代理置为对应终态。
- **FR4**：收到 `system:task_notification` 时按其 `status` 结算该子代理终态。
- **FR5**：面板只展示仍在运行的子代理；全部结束后展示空态而非残留旧条目。
- **FR6**：活动预览按子代理保留最近若干条，超出后丢弃最旧的，避免无界增长。
- **FR7**：非子代理相关的 `system` 事件不受影响，`init` 的既有会话 ID 行为保持不变。

## 非功能需求

- **NFR1**：不改动 `shared/schema.ts` 的 `agents` 结构，不改动 `src/components/StructuredBlocks.tsx` 的渲染。
- **NFR2**：解析器为纯函数式状态机，不依赖计时器与 I/O，可被 Node 测试直接驱动。
- **NFR3**：字段缺失或类型异常时静默忽略该事件，不得抛错中断整条流。
- **NFR4**：不得影响既有的停滞看门狗行为与 `parent_tool_use_id` 相关的 keepalive 判定。

## 验收标准

- 按实测录得的真实事件序列驱动追踪器，可依次得到「登记 → 进度更新 → 收敛」的活动快照。
- 子代理全部完成后，快照中的 `agents` 为空数组。
- 既有 Claude 流解析测试与 Codex 子代理测试全部保持通过。
