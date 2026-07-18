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

## 流式消息身份

Codex app-server 的 `item/agentMessage/delta` 同时提供正文增量和 `itemId`。后端将该 `itemId` 作为可选字段随 `delta` 事件传到 renderer；Claude 没有对应稳定标识时继续使用原有的当前气泡逻辑。

renderer 对带 `itemId` 的 Codex 增量使用 `provider + streamId + itemId` 生成稳定消息 ID。活动事件仍可结束普通的“当前气泡”边界，但同一 `itemId` 后续再次出现时必须复用已经存在的消息，而不是新建碎片。增量合并缓冲按稳定消息 ID 分槽，而不是按卡片单槽保存，避免同一卡片的多个 Agent item 在一个刷新窗口内互相覆盖。最终 `assistant_message` 按同一稳定 ID 替换流式正文，并丢弃尚未刷新的同消息增量缓冲，避免完整快照后再次追加尾部字符。

Markdown 渲染前的消息清理额外识别“位于正文末尾、尚未闭合且内部没有任何非空内容”的围栏开头。此类残留通常来自流被命令活动穿插、恢复或中断时刚好停在 ```` ```json ````；renderer 只隐藏这个空围栏，不删除前面的正文，也不改动已经包含代码内容或已经闭合的围栏。后续增量补入代码后，原消息会按新内容重新渲染为正常代码块。

## UI

在设置页“模型”区域的 Codex 默认模型后新增两个紧凑字段：

- Agent 人格：跟随 Codex / 无预设 / 友好 / 务实。
- Fast 加速：复选框，静态说明“更快，但费用和用量更高”。从关闭切换为开启时先保持设置不变，打开应用内确认对话框，说明 priority 服务档会作用于普通聊天、恢复、Brainstorm 与 Git Agent；只有用户点击“了解费用并开启”后才写入设置。取消、关闭弹窗或按 Escape 都保持关闭；从开启切换为关闭立即生效。

复用现有设置控件和主题 token，不增加新的装饰性边框。

## 验证

1. 红测锁定默认模型、默认推理档和模型级推理菜单。
2. 红测锁定设置归一化与 ChatRequest 参数映射。
3. 红测锁定 app-server `turn/start` 的 personality / serviceTier payload 与旧 CLI 降级。
4. 运行目标单测、`pnpm test:quality`、双主题相关检查。
5. 完成后运行 `pnpm electron:build` 并重启当前开发运行时。
6. 回归模拟同一 Codex `itemId` 的正文增量被命令活动穿插，确认消息数量保持为一且最终快照完整替换。
7. 回归模拟正文停在空的 Markdown 围栏开头，确认不渲染空代码框；有实际代码内容和完整闭合的代码块保持不变。
