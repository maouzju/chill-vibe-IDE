# GPT-6.1 Sol 支持需求

## 目标

在不改变现有 Codex 默认模型和历史会话行为的前提下，让 Chill Vibe IDE 可明确选择 `gpt-6.1-sol`（2026-09-29 发布），并正确处理它的推理档位与人格限制。

## 需求

1. 共享模型目录、模型选择器、`/model`、头脑风暴请求模型和子 agent 模型目录提供 GPT-6.1 Sol；别名 `gpt-6.1-sol`、`6.1`、`6.1-sol`、`sol-6.1`、`sol6.1`、`gpt61sol`。
2. 裸别名 `sol`、`6` 仍指向 GPT-6 Sol，`DEFAULT_CODEX_MODEL` 不变；不自动迁移默认模型、卡片模型或会话模型。
3. 提供 `low`、`medium`、`high`、`xhigh`、`max` 和 Codex 的 `ultra` 六档；新选该型号缺省 `low`，显式档位保留。
4. 该型号不支持 `none`：关闭思考必须降为合法的 `low` 请求（app-server 与 exec 共用出口）；聊天与自动化模板的思考开关展示为开启且禁用，选深度时清掉旧的 `thinkingEnabled=false`。
5. 该型号不发送 `personality`；保留用户的人格和 Fast 全局设置，Fast 继续透传。
6. 保留自定义模型名和其它型号行为：GPT-6 Sol、GPT-6 Luna、GPT-5.6 系仍接受 `none`。


## 2026-10-01 模型选择器清理

按用户截图划线范围，从普通聊天、头脑风暴、自动化模板及同源的模型候选目录中隐藏 GPT-6 Sol、GPT-5.6 Sol、GPT-5.6 Terra、GPT-5.6 Luna 和 GPT-5.5。

- 保留可见型号：GPT-6.1 Sol、GPT-6 Luna、GPT-6 Astra、Fable 5.1、Opus 5.5、Sonnet 5.5、Haiku 5.5（2026-10-09 起由 Haiku 4.5 换代，见下）。
- 复用 `hiddenFromPicker`，不删除旧型号条目、别名或能力判定，不改写已保存的卡片和用户默认模型。
- 已使用旧型号的卡片仍显示其真实模型；共享超管候选仍按既有规则补入用户显式配置的默认型号。
- 这是小范围静态目录清理，沿用本规格和 `docs/ui-principles.md`，不新增 SPEC；按低风险目录配置变更做实现后验证。
- 验证目录过滤、历史兼容、子 agent 候选，以及深浅主题和宽窄窗口的真实菜单；不接受与此无关的全量快照变化。

## 2026-10-09 Haiku 5.5 换代

- Claude Haiku 5.5（2026-10-07 发布，API id `claude-haiku-5-5`，无日期戳）进目录并接管裸别名 `haiku`；别名 `haiku-5.5`、`claude-haiku-5-5`。
- Haiku 4.5 `hiddenFromPicker`，精确 id `claude-haiku-4-5-20251001` 与别名 `haiku-4.5` 保持可解析，已保存的卡片不改写。
- 子 agent 的 `haiku` 别名由 `buildClaudeAgentAliasModelEnv` 经 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 钉到 5.5；提示词映射同源跟随。
- 2026-10-09 用 CLI 2.1.280 实测：`--model claude-haiku-5-5` 可用（仅打印 `unrecognized_model` 日志），`--model haiku` 在钉住环境变量后落到 5.5；上下文窗口由 CLI 自报，无按型号表需改。
- 小范围静态目录变更，按低风险处理，不新增 SPEC。
