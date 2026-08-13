# Claude 子代理进度 UI — Design

## 结论：只缺一个翻译层

Codex 侧的整条链路已经齐备，Claude 侧缺的只是「把 CLI 的 `system:task_*` 事件翻译成 `agents` 活动」这一层：

| 层 | Codex | Claude（本次） |
| --- | --- | --- |
| 事件源 | `thread/started`、`item/*` 等 JSON-RPC 通知 | `system:task_started` / `task_progress` / `task_updated` / `task_notification` |
| 翻译层 | `server/codex-agent-status.ts` | **新增** `server/claude-agent-status.ts` |
| 数据结构 | `streamAgentsActivitySchema`（`shared/schema.ts` 1439 行附近） | 复用，零改动 |
| 渲染 | `StructuredAgentsCard`（`src/components/StructuredBlocks.tsx` 480 行附近） | 复用，零改动 |

## 字段映射

以 2026-08-09 实测样本为准：

| CLI 字段 | `StreamAgentEntry` 字段 | 说明 |
| --- | --- | --- |
| `task_id` | `threadId` | 子代理稳定标识，同一 `task_id` 的后续事件都归并到同一条目 |
| `description`（`task_started`） | `nickname` | 例：`Count .ts files in server dir` |
| `subagent_type` | `role` | 例：`Explore`；渲染为 `名称 [角色]` |
| `description`（`task_progress`） | `activity[]` 一行 | 例：`Running List top-level .ts files by name` |
| `last_tool_name` | 拼进同一条 `activity` 行 | 例：`· PowerShell` |
| `usage.tool_uses` / `usage.duration_ms` | 拼进同一条 `activity` 行 | 例：`· 2 次工具 · 17.8s` |
| `patch.status`（`task_updated`） | `status` | `completed` / `failed` / `cancelled` 等映射到 `StreamAgentStatus` |
| `status`（`task_notification`） | `status` | 同上，作为终态兜底 |

状态映射：`completed → completed`、`failed`/`error` → `errored`、`cancelled`/`interrupted` → `interrupted`、其余未知终态 → `completed`；未见终态前为 `running`。

## 模块设计

`server/claude-agent-status.ts` 导出 `createClaudeAgentStatusTracker()`，与 Codex 版保持同构：

- `handleEvent(event)` → `{ handled, activity? }`；只在状态真正变化时返回 `activity` 快照，避免无谓重渲染。
- `snapshot()` → `StreamAgentsActivity`，`view: 'status'`，`agents` 仅含运行中的条目（与 Codex 的 `isRunningStatus` 过滤一致）。
- `hasRunningAgents()` → 供调用方判断是否仍有子代理在跑。
- 活动预览上限沿用 Codex 的 `maxPreviewItems` 量级，按 `task_id` 各自保留最近若干条。

`itemId` 取 `claude-agent-status`，保证整轮内是同一张卡片被就地更新，而不是每次进度都新开一张。

## 接线点

`server/providers.ts` 的 Claude stdout 折叠器中，紧邻既有 `system`/`init` 分支（2754 行附近）加入子代理分支：

```
if (event.type === 'system' && typeof event.subtype === 'string' && isClaudeAgentStatusEvent(event)) {
  const update = agentTracker.handleEvent(event)
  if (update.activity) sink.onActivity(...)
  return
}
```

要点：

- 必须放在 `parseClaudeStructuredOutput` 之前并直接 `return`，避免这些事件再落入通用活动路径。
- `init` 分支保持在最前，会话 ID 行为不变（NFR7）。
- 追踪器实例与折叠器同生命周期（每轮一个），轮次结束自然释放。

## 被否决的替代方案

- **解析 sidechain 行（`parent_tool_use_id` 非空的 assistant/user 事件）来推断进度**：实测一次简单派发只有 7 条 sidechain，且其语义是子代理的完整消息体，需要自建一套工具调用状态机；而 `system:task_progress` 已经是 CLI 归纳好的进度摘要，字段更稳、量更小。sidechain 留给后续的「子代理明细展开」需求。
- **新增独立的 `claude-agents` 活动种类**：会连带改 schema、i18n 与渲染层，且用户看到的是两套外观不一致的面板。复用 `agents` 更省且视觉统一。

## CLI 心跳节律（2026-08-09 实测，决定了静默兜底的必要性）

`task_progress` **不是定时心跳**，而是「子代理每完成一次工具调用」触发一次。实测一个子代理内部执行 `Start-Sleep -Seconds 100`：

```
 36.5s  task_started    Run sleep command and report output
 39.6s  task_progress   Running Sleep 100 seconds then print DONE   duration_ms=3100
        ← 整整 155 秒零事件 ←
195.1s  task_progress   Monitoring: Wait for ...                    duration_ms=158563
```

`usage.duration_ms` 是该子代理的**累计运行时长**（195.1 − 36.5 = 158.6s，与 158563ms 吻合）。

推论：面板忠实反映最后一次心跳是正确行为，但对用户而言与「卡死」无法区分。因此每个运行中的子代理额外挂一行本地推算的已运行时长，由宿主侧 15s 周期重发驱动。这一行必须排在 `activity` 末尾——渲染层对活动做 `slice(-3)` 尾切。

## 任务类型分流（2026-08-09 实测）

CLI 用同一套 `system:task_*` 上报后台 shell 命令：

| | `task_type` | `subagent_type` |
| --- | --- | --- |
| 子代理 | `local_agent` | 有（如 `Explore`） |
| 后台命令 | `local_bash` | 无 |

不分流会让一条普通后台命令在「正在运行的子智能体」面板里冒充成子代理。判定采用 `task_type.includes('agent')`，而非与 `local_agent` 全等——Agent 工具的远程隔离模式会带别的 agent 前缀，全等会漏掉整类远程子代理。终态事件（`task_updated` / `task_notification`）不带 `task_type`，靠 `task_id` 只对已登记的子代理生效，天然免疫。

## 风险

- CLI 未来调整 `system:task_*` 字段名会导致面板静默失效。缓解：解析器对缺字段静默降级（NFR3），并由回归测试锁住实测样本的字段形状。

## 渲染层回归：面板被工具分组循环吞掉（2026-08-12 修复）

后端链路全通、`state.json` 里能搜到 `agent-status:claude` 的 agents 消息，但用户完全看不到面板。

根因在 `src/components/chat-card-parsing.ts` 的 `buildRenderableMessages`：派发子代理**必然**先产生一张 `Task`/`Agent` 工具卡，紧随其后的 agents 状态卡因而落进工具分组循环；该循环只认 `command` / `tool` / `edits`，其余一律交给 `isEmptySkippableMessage` 判定——而所有结构化卡片的 `content` 恒为空（`app-helpers.ts` 的 `createStructuredActivityMessage` 写死 `content: ''`），于是能正常解析的 agents 卡被当成「解析失败的坏卡」静默丢弃。`todo` 卡同病。

修复：分组循环里先用各自的 parse 函数判定，遇到可解析的 agents / todo 卡就 `break`，交回外层已有的 `if (todo || agents)` 分支渲染成独立卡片。

被否决：把 `'agents'` 从 `isEmptySkippableMessage` 的 kind 名单里删掉——那会让真正 `structuredData` 缺失的坏卡渲染成空气泡。

守卫：`tests/chat-card-parsing.test.ts` 三条——工具卡后、两张工具卡之间、以及「无 structuredData 的坏 agents 卡仍应丢弃」。
