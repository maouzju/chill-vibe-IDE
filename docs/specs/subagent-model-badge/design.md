# Design: 子 agent 面板显示模型

## 数据模型

`shared/schema.ts` `streamAgentEntrySchema` 追加：

```ts
model: z.string().optional(),
reasoningEffort: z.string().optional(),
```

两个字段都是可选、无默认，老数据零迁移。卡级 `model` / `reasoningEffort` 保留不动（那是 Codex 旧版 `collabAgentToolCall` 的调用级覆盖，语义不同）。

## Codex 追踪器（`server/codex-agent-status.ts`）

- `TrackedAgent` 继承自 `StreamAgentEntry`，自动获得两个字段。
- `ensureAgent` 的 patch 类型加入 `model` / `reasoningEffort`，非空才写。
- `thread/started` 分支从 `thread` 上 `readString('model')` / `readString('reasoningEffort')` 传入。
- `publicAgent` 按已有模式条件展开两个字段。

## Claude 追踪器（`server/claude-agent-status.ts`）

- 新增 `toolUseIds: Map<toolUseId, taskId>`：`task_started` / `task_progress` 带 `tool_use_id` 时登记（合成条目本身以 `workflow:<toolUseId>` 为 id，可直接由 `syntheticClaudeAgentId` 反推）。
- `handleEvent` 顶部对 sidechain 行的早退改成：若 `type === 'assistant'` 且 `message.model` 是字符串，则按 `parent_tool_use_id` 解析出条目（先查 `toolUseIds`，再查合成 id 经 `resolveTask`），条目存在且 `model` 有变化时写入并返回 `{ handled: false, activity: snapshot() }`；其余情况维持 `{ handled: false }`。
- 为什么不用 `Agent` 工具 `input.model`：那是别名（`haiku`）且多数派发不填；sidechain 的 `message.model` 是 CLI 解析后的真实 id，且子 agent 一开口就有。
- 为什么不解析 sidechain 的其它内容：与文件顶部既有 ADR 一致，sidechain 不自建工具状态机，这里只读一个字段。

## 渲染（`src/components/StructuredBlocks.tsx`）

状态视图条目的 `structured-agent-status-title-row` 内，在 `structured-agent-path` 之后、状态标签之前插入：

```tsx
{agent.model ? (
  <span className="structured-agent-model">
    {agent.reasoningEffort ? `${agent.model} · ${agent.reasoningEffort}` : agent.model}
  </span>
) : null}
```

样式：等宽字体、`--ink-3` 次要文字色、字号略小于 path，紧跟 path 之后、状态标签之前；`white-space: nowrap; overflow: hidden; text-overflow: ellipsis` 让长模型 id 在窄卡上省略而不是把状态标签挤出行外。不加 title 提示——path 元素也没有，保持面板安静。

渲染层解析 `parseStructuredAgentsMessage`（`src/components/chat-card-parsing.ts`）是逐字段白名单拷贝，必须显式透传 `model` / `reasoningEffort`，否则 schema 与追踪器都对了面板仍是空的（实现时正是这一层让渲染测试保持红）。

## 验证策略

- 红→绿：`tests/codex-agent-status.test.ts`（thread/started 带 model/effort → 快照条目带值；缺失不带）、`tests/claude-agent-status.test.ts`（sidechain assistant 写入 model、保持 handled:false、重复不推快照、未知 parent 不动）、`tests/structured-chat-blocks.test.tsx`（状态视图渲染 model 徽标 / 无 model 不渲染）。
- `pnpm test:quality`。
- Playwright `theme-check` 里 Codex 子 agent 状态快照有意更新（夹具补 model / effort）。
