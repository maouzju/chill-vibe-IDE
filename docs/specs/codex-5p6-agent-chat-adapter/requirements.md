# Codex 5.6 与 Agent 聊天参数适配需求

## 背景

Codex CLI 0.144.1 已将 GPT-5.6 Sol、Terra、Luna 列为推荐模型，并在本地模型目录中暴露了更细的推理档位、人格覆盖和 Fast 服务档。Chill Vibe 仍以 GPT-5.5 和 Codex `xhigh` 作为新会话默认值，Git 模型说明也把推理强度混在模型示例里，导致默认体验、模型选择和 app-server 请求参数落后于当前 CLI。

## 需求

1. 新安装或缺失设置的 Codex 默认模型必须为 `gpt-5.6-sol`。
2. 新建 Codex Agent 会话的默认推理强度必须为 `medium`，与官方默认 Power 档一致。
3. Git 卡片 AI 默认使用 `gpt-5.6-terra medium`，兼顾日常分析质量、速度和成本。
4. Codex 模型选择必须显式提供 Sol、Terra、Luna，并继续保留 GPT-5.5 作为兼容选项。
5. 推理强度选项必须按模型能力显示：
   - Sol / Terra：`low`、`medium`、`high`、`xhigh`、`max`、`ultra`。
   - Luna：到 `max`，不显示 `ultra`。
   - GPT-5.5 与其他旧 Codex 模型：到 `xhigh`。
6. 设置页必须提供 Codex Agent 人格覆盖：跟随 Codex、无预设、友好、务实。
7. 设置页必须提供 Codex Fast 加速开关；默认关闭，开启后通过 app-server 发送 `serviceTier: "priority"`。由于该服务档费用较高，用户每次从关闭切换为开启时都必须先看到明确的费用与影响范围警告，并主动二次确认；取消确认不得改变设置，关闭 Fast 不需要确认。
8. 人格和 Fast 参数必须覆盖普通聊天、恢复/重试、Brainstorm 与 Git Agent 请求。
9. 旧保存状态缺少新字段时必须安全回落到“跟随 Codex”和“关闭 Fast”。
10. 已保存的非空模型名称不得自动替换，避免覆盖用户主动选择或让既有会话失效。
11. Codex 流式正文必须保留 app-server 的 `itemId`。同一条 Agent 消息即使被并行命令、子 Agent 活动或补发的活动快照穿插，也只能更新同一个正文气泡，不得留下单字、半句或重复的正文碎片；最终 `assistant_message` 必须原位收敛为完整内容。
12. Codex 流式正文如果暂时或永久停在一个尚无内容的 Markdown 围栏开头（例如末尾只有 ```` ```json ````），聊天区不得显示空代码框；后续一旦收到真实代码内容，必须正常恢复代码块展示。

## 非目标

- 不自动开启 `on-request` 审批；IDE 还没有完整的审批交互闭环。
- 不默认开放 workspace-write 网络权限。
- 不默认开启 Fast、Max 或 Ultra，避免无意增加延迟、并行度或用量。
- 不把 API 专属的 `reasoning.mode=pro` 注入 Codex CLI app-server。
