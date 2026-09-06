# GPT-6 Astra 支持需求

## 目标

在不改变现有 Codex 默认模型和历史会话行为的前提下，让 Chill Vibe IDE 可明确选择 `gpt-6-astra`，并正确处理其推理能力限制。

## 需求

1. Codex 模型选择器、斜杠命令和共享模型目录提供 GPT-6 Astra。
2. Astra 支持 `low`、`medium`、`high`、`xhigh`、`max` 和 Codex 的 `ultra` 档；新选 Astra 缺省采用 `low`，显式档位保留。
3. Astra 不支持关闭推理；选择该模型时关闭思考状态必须降为合法的 `low` 请求。
4. 不自动迁移现有默认模型、卡片模型或会话模型。
5. 保留自定义模型名和旧模型兼容路径。
6. Astra 不发送人格参数；保留用户的人格和 Fast 全局设置，Fast 继续正常透传。
