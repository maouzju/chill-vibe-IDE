# Codex 题组提问设计

## 协议格式

保留现有单题格式作为兼容入口：

```xml
<ask-user-question>{"header":"标题","question":"问题","multiSelect":false,"options":[...]}</ask-user-question>
```

新增题组格式：

```xml
<ask-user-question>{"questions":[{"header":"范围","question":"先处理哪部分？","multiSelect":false,"options":[...]},{"header":"验证","question":"需要哪种验证？","multiSelect":false,"options":[...]}]}</ask-user-question>
```

系统指令告诉 Codex：

- 只有一个问题时使用单题格式。
- 有多个彼此相关、可以一起回答的问题时使用 `questions[]`，题目数量不设上限。
- 每题提供 2-3 个选项，不主动添加 `Other`，不输出 XML 以外的文本。

## 服务端归一化

`server/codex-structured-output.ts` 增加共享的题目归一化函数：

1. 若顶层 `questions` 是数组，逐项读取并过滤无效题目，不截断有效题目。
2. 否则按旧顶层 `question/options` 解析单题。
3. 将第一道有效题复制到活动顶层的 `question/header/multiSelect/options` 字段，满足现有共享 schema。
4. 有多道有效题时额外写入 `questions`；单题保持旧活动形状，减少无关数据变化。

这样 renderer 无需新状态或新组件：`parseStructuredAskUserMessage()` 已优先读取 `questions[]`，`AskUserQuestionCard` 已支持逐题浏览和合并提交。

## 回答格式

沿用现有题组提交格式：

```text
[1] 第一题 → 选项 A
[2] 第二题 → 选项 B
```

该内容作为一条用户消息发回原 Codex 会话，使模型能一次获得全部选择。

## 兼容与边界

- 旧会话中的单题结构化消息继续正常恢复。
- 题组中无效条目被忽略；全部无效时保留为普通 assistant 文本，避免生成不可操作的空卡片。
- 本次不改变共享 schema，因为 `questions` 字段已经存在并由 Claude 题组使用。

## 验证策略

### 协议残片兜底

- 结构化卡片落地时，即使流式文本只收到 `<ask-user-question>` 起始残片，也必须清理该残片，不能向用户展示内部协议。

1. 红测证明 Codex 题组 XML 当前不能转成带 `questions[]` 的 ask-user 活动。
2. 单元测试覆盖题组解析、旧格式兼容、无效条目过滤。
3. 系统提示测试覆盖中英文题组协议。
4. 复用现有前端题组解析/提交测试，并运行 `pnpm test:quality`。
5. 题组卡片 UI 没有新增视觉结构，但仍运行主题验证并检查桌面与窄屏现有题组卡片。
