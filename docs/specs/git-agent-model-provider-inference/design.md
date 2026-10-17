# Git 卡片 AI 模型按模型名选择 CLI — 设计

## 归属判定（`shared/models.ts`）

`inferProviderFromModel(model): Provider | null`

1. `canonicalizeModelAlias` 规范化；空串、工具卡令牌、本地模型令牌返回 `null`。
2. 精确比对 `MODEL_OPTIONS`（排除工具卡项）的 `model` / `label` / `aliases`；命中的 provider
   唯一时返回它。占位项（`claude`、`gpt`、`gemini` 等别名，`model: ''`）也在这里命中。
3. 目录外按 `PROVIDER_FAMILY_PATTERNS` 认家族，关键字必须在词首（行首或非字母数字之后），
   避免 `photogpt` 之类误命中：
   - claude：`claude|anthropic|opus|sonnet|haiku|fable`
   - gemini：`gemini`
   - codex：`gpt|codex|openai|o\d`
4. 恰好一族命中才返回，零个或多个返回 `null`，由调用方兜底。

## Git 卡接线（`src/components/git-operation-hub.ts`）

`resolveGitAgentModel(gitAgentModel) => { provider, model, reasoningEffort }`

- 按空白拆词；末尾词属于三家 CLI 档位并集（`GIT_AGENT_EFFORT_TOKENS`）且不止一个词时才当强度。
- 模型短语按顺序尝试，第一个能被目录认出的胜出（`inferProviderFromModel` + `resolveSlashModel`）：
  1. 整段（多词标签 `Sonnet 5.5`、`Gemini 3.1 Pro`）；
  2. 首词是 CLI 名（占位项）时取其余词（`Claude Sonnet 5.5`）；
  3. 首词（`sonnet high` 之外夹杂的错拼档位等）；
  4. 都不认识：首词原样，`provider = inferProviderFromModel(首词) ?? 'codex'`。
- `reasoningEffort`：Codex 原样透传；Claude / Gemini 走 `normalizeReasoningEffortForModel`。

`buildAgentRequest(context, prompt, { readOnly })`：

- `provider` 来自 `resolveGitAgentModel`；`buildCodexChatRequestOverrides(provider, ...)`
  对 Claude / Gemini 只保留通用安全开关，不带 personality / serviceTier。
- 分析请求传 `readOnly: true`；Codex 额外带 `sandboxMode: 'read-only'`。

冲突同步：`openAgentSession({ provider, model?, reasoningEffort })` 同样取自 `resolveGitAgentModel`，
不传 readOnly（要改文件解冲突）。

## 只读请求（`chatRequestSchema.readOnly`）

| CLI | 实现 | 位置 |
| --- | --- | --- |
| Codex | 没传 `sandboxMode` 时 `readOnly` → `read-only` 沙箱 | `getCodexSandboxMode`（`server/providers.ts`） |
| Claude | `--permission-mode dontAsk` + `--settings.permissions.deny = [Write, Edit, MultiEdit, NotebookEdit, Bash, PowerShell]` | `buildClaudeArgs` |
| Gemini | `--approval-mode default`（无头模式下 gemini-cli 直接排除 shell / edit / write_file / web_fetch） | `buildGeminiArgs`（`server/gemini-runtime.ts`） |

Claude 只靠 dontAsk 不够：2026-10-17 实测 CLI 2.1.280，用户 `~/.claude/settings.json` 的
`permissions.allow` 含 `Bash` / `Write` / `Edit` 时，dontAsk 照样写出文件；deny 优先于 allow，补上后
读文件正常、写和执行被拒。`readOnly` 也计入 Claude keepalive 签名，避免复用读写模式的常驻进程。

## 解析（`src/components/git-agent-panel-utils.ts`）

Codex 的回答正文会被整条 `assistant_message` 覆盖；Claude / Gemini 只有增量，累计的是整轮全部文本。
`parseAnalysisResult` 先试「首个 `{` 到末个 `}`」，失败后用 `findBalancedJsonObjects` 找所有配平的
顶层对象，从后往前逐个解析，第一个带 summary 或合法策略的胜出。

## 设置界面（`src/App.tsx`）

「Git 卡片 AI 模型」标题行右侧加 `.settings-tag.git-agent-model-provider-tag`，文本为
`getProviderLabel(language, provider) + ' CLI'`，`provider` 用 `resolveGitAgentModel` 算出，
与真实路由同源。
