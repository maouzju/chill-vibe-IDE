# Design: 派发子 agent 时可见可选模型并自主选择

## 1. 共享模型目录：`shared/models.ts`

```ts
export type SelectableModel = { provider: Provider; model: string; label: string }
export const listSelectableModelCatalog = (
  settings: Pick<AppSettings, 'requestModels' | 'localModelEntries'>,
): SelectableModel[]
```

顺序：目录可见项（按 `MODEL_OPTIONS` 原顺序）→ 设置里自定义默认名（目录缺失时补入，label `configured default`）→ 本地模型条目（`buildLocalModelOptions`）。去重按 `provider + model`。放在 `shared/` 是因为 MCP 子进程虽然不能 import 它（`automation-board-mcp.js` 是裸 Node 脚本），但 server 侧生成目录、渲染端将来复用都要同一份规则。

## 2. 子 agent 指令：`server/providers.ts`

新增两个纯函数（与 `getCodexAskUserQuestionInstruction` 同风格，中英文各一份）：

- `getCodexSubagentModelInstruction(language)`：候选来自 `getModelOptions('codex')` 过滤 `isModelPickerOptionVisible && !usesConfiguredDefault`，格式 `` `id` (label) ``。文案要点：这是用户的明确授权，可以自己设 `model` / `reasoning_effort`；轻任务（搜索/读代码/机械修改）用 luna/terra 配低档位，跨模块设计、难 bug 用 sol/astra；不填继承当前模型。
- `getClaudeSubagentModelInstruction(language)`：别名 → 目录 label/model 的映射固定为 `haiku→Haiku 4.5 / sonnet→Sonnet 5 / opus→Opus 5 / fable→Fable 5.1`，映射表由 `getModelOptions('claude')` 里 label 前缀匹配得出（目录升级时自动跟上，缺失别名不列）。文案要点同上。

接入点：`buildCodexArgs` 的 `systemPrompt` 数组、`buildCodexAppServerBaseInstructions`、`buildClaudeArgs` 的 `systemPrompt` 数组，各追加一项，放在 ask-user 指令之后、shell 安全指令之前。`buildCodexAppServerBaseInstructions` 顺带 export 供测试直接断言（避免为一段文案跑整个 app-server 假进程）。

为什么不用 `agents.default_subagent_model` / `CLAUDE_CODE_SUBAGENT_MODEL`：那是"替 agent 定死一个模型"，与本需求"让 agent 自己选"相反。

## 3. 超管目录注入

- `WorkspaceAdminMcpLaunchInput` 加可选 `modelCatalog?: SelectableModel[]`。
- `buildWorkspaceAdminMcpEnv` 有目录时写 `CHILL_VIBE_ADMIN_MCP_MODELS = JSON.stringify(catalog)`；codex 走 `-c mcp_servers.<name>.env.CHILL_VIBE_ADMIN_MCP_MODELS=<toml string>`（`formatTomlString` 已处理引号/反斜杠），claude 走 `--mcp-config` 的 `env`。
- `createWorkspaceAdminRuntime`：`loadStateForRenderer()` 读 settings（`server/state-store.js` 不反向依赖本模块，无循环），生成目录塞进 launch input；读失败时目录留空、其余照旧（超管回合绝不因目录失败而失败）。

## 4. MCP 子进程：`server/automation-board-mcp.js`

- 启动时 `parseModelCatalogEnv(process.env[...])`：JSON 解析失败 / 非数组 / 条目缺 provider|model 一律视为无目录。
- `buildWorkspaceAdminMcpToolDefinitions(catalog)`：无目录返回既有 `workspaceAdminMcpToolDefinitions`（保持导出，测试与旧行为不变）；有目录时把 create_session 的 `model.description` 换成"Model id for the new session. Omit to inherit this column's model. Available — codex: `a` (A), `b` (B); claude: `c` (C)."。不用 `enum`：目录只是候选，错误提示比 schema 拒绝对模型更友好，且省略仍合法。
- `resolveWorkspaceAdminCommandFromToolCall(name, args, columnId, selfCardId, catalog?)`：create 分支在有目录时校验 `model`（AC7），provider 推断只在 `provider` 缺省时发生。
- `tools/list` 返回按目录构建的定义；`tools/call` 把目录传进 resolve。

## 5. 超管指令：`server/automation-board-runtime.ts`

中英文各补一句（紧跟 create_session 那句之后）：provider/model 由你按任务自己选，候选见工具描述，轻任务选轻模型。

## 验证策略

红→绿：
- `tests/provider-system-prompt.test.ts`：codex exec instructions / app-server baseInstructions / claude append prompt 各含对应指令与目录 id。
- `tests/automation-board-mcp.test.ts`：目录化工具定义、AC7 三条校验、两条启动路径的 env、指令文案。
- `tests/model-catalog.test.ts`（新）：AC4 的过滤、补入与去重。
- `pnpm test:quality`；打包。
