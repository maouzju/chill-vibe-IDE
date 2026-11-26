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

## 中转站心跳（server/gemini-sse-proxy.ts，2026-11-26）
- 用户填了自定义端点时，`GOOGLE_GEMINI_BASE_URL` 指向本机回环上的清洗代理，代理再转发到真正的端点；没填端点（官方）不套。
- 代理只做一件事：把流式回复规整成 CLI 认得的 `data: <JSON>` 事件——丢掉 SSE 注释心跳（`: ping`）和 `event` / `id` / `retry` 字段，统一换行。不重试、不改内容、不记录请求正文。
- 为什么必须有：gemini-cli 0.24.5 的流解析器不认 SSE 注释，中转站首字慢时发的心跳会让整段回复被判成 `Incomplete JSON segment at the end`（AGENTS.md pitfall #492）。
- 不吞报错：非流式回复原样透传；挂着 event-stream 头的裸 JSON 报错体原样放行；最后一个事件真被截断时保持原样。
- 与「断线续传代理」开关无关（那是 OpenAI / Anthropic 流格式的重试层，Gemini 不走）。代理起不来时退回直连。
- 已知限制：心跳被吞后 CLI 在首字前收不到任何字节，首字超过 5 分钟（Node fetch 的分块间隔超时）仍会断。

## 模型目录
`shared/models.ts` 增 `DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'` 与目录项；`getDefaultModel` 改为 switch。

## UI
provider 标签 `Gemini`；模型选择器按 provider 分组自动出现。
