# Requirements: 子 agent 面板显示模型

## Background

2026-09-21 核实三条派发链路（Claude `Agent` 工具、Codex `spawn_agent`、超管 `create_session`）都能给子 agent 指定模型，但子 agent 面板（`StructuredAgentsCard` 的 `view: 'status'`）只显示昵称 / 角色 / 路径 / 状态 / 最近活动，用户看不到某个子 agent 实际跑在哪个模型上。`streamAgentsActivitySchema` 卡级虽有 `model` / `reasoningEffort` 字段，但 state.json 里 50 张历史卡全为 null，子 agent 条目（`streamAgentEntrySchema`）连字段都没有。

数据源（均已对着真实协议核实）：

- Codex app-server v2 `thread/started` 的 `thread` 对象带 `model` 与 `reasoningEffort`（`codex app-server generate-json-schema` 的 `Thread` 定义）。子线程继承父模型时这两个字段同样有值。
- Claude CLI stream-json 的 sidechain 行（`parent_tool_use_id` 非空）里 `type: 'assistant'` 的 `message.model` 是子 agent 实际使用的模型 id（别名 `haiku` 等已被 CLI 解析成真实 id）。`system:task_*` 事件不带模型。

## User stories

1. 作为用户，Codex 派出子 agent 后，我能在面板每个条目上看到它用的模型与思考档位。
2. 作为用户，Claude 派出子 agent 后，我能在面板条目上看到它实际用的模型 id，不需要自己去翻 subagents jsonl。
3. 作为用户，旧版本落盘的 agents 卡（没有这两个字段）继续正常渲染，不出现空白或 undefined。

## Acceptance criteria

- `streamAgentEntrySchema` 新增可选 `model` 与 `reasoningEffort`，缺省时解析成功，`publicAgent` 不输出 undefined 键。
- Codex 追踪器：`thread/started` 携带 `model` / `reasoningEffort` 时写入对应子 agent 条目；后续快照都带这两个值；缺失时不写。
- Claude 追踪器：收到 `parent_tool_use_id` 指向已知子 agent（按 `tool_use_id` 或合成 id 关联）的 `assistant` sidechain 行且 `message.model` 为字符串时，把模型写入该条目并返回一张新快照；sidechain 行仍保持 `handled: false`（pitfall #223 的边界不动）；同一模型重复到达不重复推快照。
- 渲染：状态视图每个条目在标题行右侧显示 `model`（有 `reasoningEffort` 时追加 ` · effort`），样式与 `structured-agent-path` 同级、低对比；无 model 时不渲染该元素。
- 视觉回归：`theme-check` 的 Codex 子 agent 状态夹具补上 model / effort，快照按明暗双主题有意更新。
