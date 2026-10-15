# Gemini CLI Provider — Requirements

## 背景
Chill Vibe 只支持 `codex` / `claude` 两个本地 CLI。用户要求接入 Google 的 Gemini CLI（`gemini`），并在模型选择器里提供 2026-10 时点最新的 Gemini 系列型号。

## 需求
1. `gemini` 作为第三个 provider：卡片可以选 Gemini 模型，消息经本地 `gemini` CLI 执行（遵守 AGENTS.md「AI 请求走本地 CLI」）。
2. 流式输出：解析 `gemini -o stream-json` 的 JSONL 事件（init/message/tool_use/tool_result/error/result），助手文本增量显示、工具调用以活动条显示、result 结束回合并记录 token 用量。
3. 续聊：`init.session_id` 回写为卡片 sessionId，下一轮用 `--resume <session_id>` 续接。
4. 停止：可中断（杀子进程），不阻塞其它卡。
5. 模型目录（2026-10-14 依据 ai.google.dev/gemini-api/docs/models）：
   - 选择器可见：Gemini 4 Argon（`gemini-4-argon`）、Gemini 3.1 Pro（`gemini-3.1-pro-preview`）、Gemini 3.8 Flash（`gemini-3.8-flash`，默认）、Gemini 3.5 Flash Lite（`gemini-3.5-flash-lite`）。
   - 隐藏但保留别名：`gemini-3.6-flash`、`gemini-2.5-pro`、`gemini-2.5-flash`。
6. 设置：默认模型 `requestModels.gemini`、系统提示词/接口配置（`providerProfiles.gemini`，填 key 时注入 `GEMINI_API_KEY`，填 baseUrl 时注入 `GOOGLE_GEMINI_BASE_URL`）。
7. 环境检查 / provider 状态列出 Gemini CLI 是否安装。
8. 旧存档（没有 gemini 键）必须无损升级：缺键补默认值。

## 非目标（首版）
- 图片附件、跨 CLI fork/换模型无损手术、keepalive 进程池、超管/浏览器控制/JEV MCP 注入、思考档位、本地模型条目（harness 仍只允许 codex/claude）、slash 原生命令列表。

## 补充（2026-10-15）：环境一键配置
- 环境检查新增 `gemini`，标记 `optional`：缺失不计入 `environment.ready`、不进「缺少工具」提示、不触发引导弹窗。
- 一键安装（install-missing）在 Claude/Codex 之后尝试安装 `@google/gemini-cli`，失败只记一行日志，不让整次配置失败。
- 「更新 CLI」可单独选 Gemini；选「全部」时只在本机已装 Gemini 时才更新它，不给没装的人硬塞。
