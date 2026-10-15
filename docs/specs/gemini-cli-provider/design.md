# Gemini CLI Provider — Design

## 数据层
- `providerSchema` 扩成 `['codex','claude','gemini']`。所有 `Record<Provider,…>` 表补 `gemini` 键；schema 里 `requestModels` / `systemPrompts` 等对象 schema 对 `gemini` 加 `.default(...)`，于是旧存档 parse 时自动补齐（需求 8）。
- 本地模型条目 `harness` 改用独立的 `localModelHarnessSchema = z.enum(['codex','claude'])`，Gemini 不进本地模型路径。

## 运行层（server/gemini-runtime.ts）
- `buildGeminiArgs(request)`：`-o stream-json --approval-mode yolo [-m model] [--resume sessionId]`，prompt 走 stdin（避免 Windows 命令行长度与引号问题，`-p` 已废弃，stdin 内容会作为输入）。系统提示词拼在 prompt 前（Gemini CLI 无 append-system-prompt 参数；`GEMINI_SYSTEM_MD` 会整段替换内置提示词，过重）。
- `createGeminiStreamParser(sink)`：逐行 JSON；
  - `init` → `sink.onSession(session_id)`
  - `message(role=assistant)` → `sink.onDelta(content)`
  - `tool_use` / `tool_result` → `sink.onActivity`（command 类活动，状态 in_progress → completed/failed）
  - `error(severity=error)` → `sink.onLog`
  - `result` → success: `sink.onDone()`（带 stats）；error: `sink.onError(message)`
  - 进程退出但无 result → 非 0 时 onError(stderr 摘要)，0 时 onDone。
- `launchProviderRun` 在 codex 分支之前加 `gemini` 分支调用 `launchGeminiRun`。

## 模型目录
`shared/models.ts` 增 `DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'` 与目录项；`getDefaultModel` 改为 switch。

## UI
provider 标签 `Gemini`；模型选择器按 provider 分组自动出现。
