# Requirements: 派发子 agent 时可见可选模型并自主选择

## Background

2026-09-21 用户明确本意：**agent 派发子 agent 时，要能看到自己有哪些模型可选，并且能自己选**。实测现状（`scripts/probe-codex-tool-schema.mjs` + Claude CLI 2.1.263 二进制）：

| 链路 | 能否看到候选 | 能否自己选 |
|---|---|---|
| Claude `Agent` 工具 | 只看到别名 `sonnet/opus/haiku/fable`，不知道本环境对应哪些模型 | 能，但没人告诉它可以 |
| Codex `spawn_agent` | 工具描述列出 5 个模型 | CLI 自带描述写着 *Do not set the model field unless the user explicitly asks*，模型于是从不选（本机 9 月 42 次调用 0 次带 model） |
| 超管 `create_session` | `model` 是自由字符串，描述只说"默认继承本列模型"，**没有候选** | 能填，但只能瞎猜 id |

## User stories

1. 作为 Claude 卡里的 agent，派发 Agent 时我知道 haiku/sonnet/opus/fable 在本环境对应哪些模型，并被明确允许按任务轻重自己选。
2. 作为 Codex 卡里的 agent，派发 spawn_agent 时我被明确授权自己设 `model` / `reasoning_effort`，不必等用户点名，并知道本环境可用的模型清单。
3. 作为超管 agent，调用 create_session 时工具描述直接列出本工作区可选的 provider/模型（含用户配置的本地模型），我按任务选；填了不存在的模型会被拒绝并告知候选，只填模型不填 provider 时系统能推断 provider。
4. 作为用户，我在设置里配的本地模型条目和自定义默认模型名，会出现在超管的候选里。

## Acceptance criteria

### 子 agent 提示（两条 CLI 链路）

- AC1 Codex 的系统提示（exec `instructions=` 与 app-server `baseInstructions` 两条路径）都包含一段「spawn_agent 模型自选」指令：明确授权自己设 `model` / `reasoning_effort`，列出 Chill Vibe 模型目录里 Codex 可见模型的 id，给出"轻任务用轻模型、难任务用强模型、不填则继承当前模型"的选型原则。
- AC2 Claude 的 `--append-system-prompt` 包含一段「Agent 模型自选」指令：列出 `haiku / sonnet / opus / fable` 四个别名及其在本环境目录中对应的模型名，明确允许自己选，同样给出选型原则。
- AC3 两段指令中英文各一份，随 `language` 切换；不改变既有指令的顺序与内容。

### 超管 create_session

- AC4 新增共享辅助 `listSelectableModelCatalog(settings)`：返回 `{ provider, model, label }[]`，包含模型目录里对选择器可见的真实模型（排除工具卡、`hiddenFromPicker`、`usesConfiguredDefault` 占位项）、各 provider 在设置里配置的默认模型名（目录里没有时以 `configured default` 标注补入）、以及 `localModelEntries`（以 `__local__:<id>` 令牌 + 标签形式）。
- AC5 超管 MCP 子进程通过环境变量 `CHILL_VIBE_ADMIN_MCP_MODELS`（JSON）拿到该目录；codex `-c mcp_servers.*.env.*` 与 claude `--mcp-config` 两条启动路径都要带上。
- AC6 `create_session` 的 `model` 参数描述按 provider 分组列出候选（`id (label)`），并说明省略时继承本列模型。没有目录时（旧环境）退回现有描述。
- AC7 带目录时：`model` 不在目录里 → 工具返回错误并列出候选，不投递命令；`model` 在目录里但与显式 `provider` 不匹配 → 错误；只给 `model` 不给 `provider` → 命令里自动补上目录中的 provider。
- AC8 超管指令中英文都补一句：create_session 的 provider/模型由你按任务自己选，候选见工具描述。
- AC9 旧环境兼容：没有 `CHILL_VIBE_ADMIN_MCP_MODELS` 时行为与现在完全一致（`tests/automation-board-mcp.test.ts` 既有断言全绿）。

## Non-goals

- 不改 Claude 别名的实际解析（不注入 `ANTHROPIC_DEFAULT_*_MODEL`）：别名→模型由 CLI 决定，Chill Vibe 只负责告诉 agent 对应关系。
- 不把本地模型条目开放给 Agent / spawn_agent：子 agent 跑在父进程同一端点里，换不了 baseUrl。
- 不在 UI 上新增任何设置项。
