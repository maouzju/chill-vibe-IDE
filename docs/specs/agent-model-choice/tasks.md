# Tasks: 派发子 agent 时可见可选模型并自主选择

## Slice 1 - 共享目录 + 子 agent 指令

- [x] 红：`tests/model-catalog.test.ts` 过滤 / 补入 / 去重。
- [x] 红：`tests/provider-system-prompt.test.ts` codex exec、app-server、claude 三处指令断言。
- [x] 绿：`shared/models.ts` `listSelectableModelCatalog`；`server/providers.ts` 两个指令函数 + 三个接入点 + export `buildCodexAppServerBaseInstructions`。

## Slice 2 - 超管目录注入

- [x] 红：`tests/automation-board-mcp.test.ts` 目录化定义 / AC7 校验 / env / 指令。
- [x] 绿：runtime env、session 读 settings、mcp.js 目录解析与校验、指令文案。

## Slice 3 - 收尾

- [x] 窄测试 + `pnpm test:quality`。
- [x] 更新 `docs/specs/workspace-admin-create-session/requirements.md` AC12 的补充说明。
- [x] 打包 `pnpm electron:build`：`dist/release-20260921-105303/Chill Vibe-0.20.25-win.zip`（可执行 `win-unpacked/Chill Vibe.exe`，asar 内已核对含两段自选文案与 `CHILL_VIBE_ADMIN_MCP_MODELS`）。

Verification (2026-09-21): 红→绿 —— `tests/model-catalog.test.ts` 新文件 3 用例先因缺导出整文件红、实现后 3/3 绿；`tests/provider-system-prompt.test.ts` 3 新用例先红（指令缺失）后绿（123/123）；`tests/automation-board-mcp.test.ts` 5 新用例（目录化定义 / AC7 三条校验 / 两条启动路径 env / 指令文案 / 真 stdio 子进程 tools/list + 拒绝未知模型不触桥）先红后绿（51/51，连同模型目录 54/54）。受 `shared/models.ts` 影响的 `models` / `local-model-entries` / `codex-empty-continuation` 26/26 绿。`pnpm test:quality` 通过。

End-to-end (2026-09-21, real CLIs with Chill Vibe's own prompt builders):
- Claude 2.1.263 (`claude-opus-5` root, `--append-system-prompt` from `buildClaudeArgs`): Agent tool_use `{subagent_type:"Explore", model:"haiku"}`, sidechain `message.model = claude-haiku-4-5-20251001`; root reported it chose haiku for the light task.
- Codex 0.153.4 app-server (`gpt-6-astra` root, `baseInstructions` from `buildCodexAppServerBaseInstructions`): rollout `function_call spawn_agent` args `{model:"gpt-5.6-luna", reasoning_effort:"low", fork_turns:"none"}` — first spawn with an explicit model on this machine (previous 42 calls in September had none). The probe's read-only sandbox blocked the child's shell, so the turn timed out after spawning; irrelevant to model choice.
- `codex exec` path: the CLI injects `<multi_agent_mode>` forbidding proactive spawning and the run had no `spawn_agent` in its tool list, yet the model still answered "gpt-5.6-luna" — exec mode is not the app path Chill Vibe uses; do not treat that self-report as evidence.
