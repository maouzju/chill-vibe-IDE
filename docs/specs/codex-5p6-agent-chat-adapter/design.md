# Codex 5.6 与 Agent 聊天参数适配设计

## 官方基线

- Codex CLI：0.144.1。
- 默认 Power 档：`gpt-5.6-sol` + `medium`。
- Terra：日常工作均衡档；用于 Git 分析默认值。
- Luna：清晰、重复、高吞吐任务；不提供 Ultra。
- Max：单 Agent 更深推理；Ultra：通过子 Agent 并行处理可拆分任务。
- Fast：app-server 的 `serviceTier: "priority"`，速度更快但增加用量。

官方参考：

- https://developers.openai.com/api/docs/guides/latest-model.md
- https://learn.chatgpt.com/docs/models.md
- https://learn.chatgpt.com/docs/config-file/config-reference

## 模型与推理能力

`shared/models.ts` 维护可见模型目录和默认模型：

- `DEFAULT_CODEX_MODEL = "gpt-5.6-sol"`
- `DEFAULT_GIT_AGENT_MODEL = "gpt-5.6-terra medium"`
- 新增 Sol / Terra / Luna 选项，GPT-5.5 保留为旧模型。

`shared/reasoning.ts` 从 provider 级固定菜单升级为模型级能力菜单：

- Codex 基础菜单保留 low 到 xhigh。
- Sol / Terra 追加 max、ultra。
- Luna 只追加 max。
- 不受支持的持久化档位向下归一：Luna 的 ultra 变 max；旧模型的 max/ultra 变 xhigh。
- Codex 缺省档从 xhigh 调整为 medium；已有卡片的显式值保持不变。

## 持久化设置

在 `AppSettings` 增加：

```ts
codexPersonality: "default" | "none" | "friendly" | "pragmatic"
codexFastMode: boolean
```

缺失字段分别归一为 `default` 和 `false`。

## 请求映射

在 `ChatRequest` 增加可选字段：

```ts
personality?: "none" | "friendly" | "pragmatic"
serviceTier?: "priority"
```

renderer 使用共享 helper 从设置生成请求覆盖：

- `codexPersonality === "default"` 时省略 `personality`。
- `codexFastMode === true` 时发送 `serviceTier: "priority"`。
- Claude 请求不带这些字段。

Codex app-server 在 `turn/start` 发送上述字段。它们是 turn 级覆盖，能作用于新线程、恢复线程和后续 turn；默认省略时继续服从用户 Codex 配置。

## 兼容策略

- 继续保留现有 `effort` 兼容重试。
- 当旧 CLI 明确拒绝 `personality` 或 `serviceTier` 时，移除这组可选 Agent 参数重试一次，不删除 effort、模型、沙箱或系统提示词。
- UI 中只给当前 Codex 请求展示这些设置，不改变 Claude 行为。

## UI

在设置页“模型”区域的 Codex 默认模型后新增两个紧凑字段：

- Agent 人格：跟随 Codex / 无预设 / 友好 / 务实。
- Fast 加速：复选框，说明“更快，但会增加用量”。

复用现有设置控件和主题 token，不增加新的装饰性边框。

## 验证

1. 红测锁定默认模型、默认推理档和模型级推理菜单。
2. 红测锁定设置归一化与 ChatRequest 参数映射。
3. 红测锁定 app-server `turn/start` 的 personality / serviceTier payload 与旧 CLI 降级。
4. 运行目标单测、`pnpm test:quality`、双主题相关检查。
5. 完成后运行 `pnpm electron:build` 并重启当前开发运行时。
