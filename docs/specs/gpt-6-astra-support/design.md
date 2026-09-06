# GPT-6 Astra 支持设计

## 模型目录

在 `shared/models.ts` 增加 `GPT-6 Astra` Codex 条目及 `gpt-6-astra` 别名，使普通选择器、Brainstorm 和 `/model` 共用同一条目。

## 推理档位

2026-09-06 实测 Codex 0.153.4 `model/list`：Astra 提供 low/medium/high/xhigh/max/ultra，默认 low，supportsPersonality=false，serviceTiers 含 priority。Ultra 是 CLI 自动任务委派档，不是直接 API 的 reasoning.effort。

在 `shared/reasoning.ts` 提供上述六档；缺省采用 low，显式档位保留。Astra 判定统一在 shared/models.ts，不能在两个请求出口和 UI 分别手写名单。

## 关闭思考

Codex 请求构造不得向 Astra 发送 `none`。当 `thinkingEnabled === false` 且模型为 Astra 时发送 `low`；其它 Codex 模型保持现有行为。

app-server 和 exec 共用同一推理映射函数。聊天与自动化模板的 Astra 思考开关展示为开启且禁用；旧 false 状态显示实际 low，选深度时同步恢复 thinkingEnabled，避免 UI 选 max、请求仍发 low。不做启动时的存量迁移。

Astra 的 turn/start 省略 personality，保留其它模型透传及全局设置。Fast 不变，不添加新直连接口或实验上下文设置。

官方依据：https://developers.openai.com/api/docs/models/gpt-6-astra 、https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra 、https://developers.openai.com/codex/models 。

## 兼容与验证

不修改默认模型。新增共享模型/推理单测，并运行目标测试、质量检查及 Electron 构建。

本任务接续同一会话，按 AGENTS.md 的跟进工作默认留在当前分支；不提交或改动原有 provider-stream-recovery 与 AGENTS.md 的在途修改。验证使用针对性 Node 与双主题 UI 检查，不启动全仓库发布流水线。
