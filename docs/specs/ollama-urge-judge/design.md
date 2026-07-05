# 鞭策本地大模型判定 + Ollama 集成 — 设计

## 数据模型（shared/schema.ts）

`autoUrgeProfileSchema` 新增：

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `judgeMode` | `'keyword' \| 'local-model'` | `'keyword'` | 判定方式 |
| `judgeModel` | string | `''` | local-model 模式所选 Ollama 模型名 |

新增 Ollama schemas：`ollamaStatusSchema`（installed/running/version/models/recommendedModel{name,totalMemoryGb}/task{state,kind,model,logs}）、`ollamaJudgeRequestSchema`、`ollamaJudgeResponseSchema`。归一化在 `createAutoUrgeProfile`（judgeMode 非法回退 keyword，judgeModel 文本归一）。

## server/ollama-manager.ts（仿 setup-manager）

纯函数（可单测）：
- `resolveOllamaBaseUrl(env)`：`CHILL_VIBE_OLLAMA_URL` 或 `http://127.0.0.1:11434`。
- `recommendOllamaModel(totalMemBytes)`：≥30GB→`qwen3:8b`；≥14GB→`qwen3:4b`；否则 `qwen3:1.7b`。返回 `{name, totalMemoryGb}`（文案由前端 i18n）。
- `buildUrgeJudgePrompt(text)`：中文严格验收判定 prompt + 尾部截断的最后一段文字。
- `parseUrgeJudgeVerdict(content)`：解析 JSON（容忍 markdown fence 包裹），返回 boolean 或 null。

`OllamaManager` 类（注入 `fetchImpl`/`spawn`/`env`/`totalMemBytes` 便于测试）：
- `getStatus()`：`where.exe ollama` 判 installed；`GET /api/version`（短超时）判 running + version；`GET /api/tags` 列模型；附 recommendedModel + 当前 task。
- `startInstall()`：未安装 → `winget install --id Ollama.Ollama -e --silent --accept-*`；已安装未运行 → detached `ollama serve`。task 状态机 idle/running/success/error + logs（同 SetupManager）。
- `startPull(model)`：spawn `ollama pull <model>`，行日志，退出码定成败。
- `judge({model, text})`：`POST /api/chat`，`stream:false`、`format` 传 JSON schema（`{shouldContinue: boolean}` required）、`temperature 0`，解析 `message.content`。

## 路由（server/index.ts）

- `GET /api/ollama/status`
- `POST /api/ollama/install`（202）
- `POST /api/ollama/pull` `{model}`（202）
- `POST /api/ollama/judge` `{model,text}` → `{ok, shouldContinue?}`（失败 `{ok:false,error}`）

## Electron 桥（四件套，仿 setup）

backend.ts 懒建 `OllamaManager` + 4 方法（fetchOllamaStatus / runOllamaInstall / runOllamaPull / judgeUrgeWithOllama）；main.ts `ipcMain.handle` ×4；preload.ts 暴露 ×4；electron.d.ts 类型 ×4。src/api.ts：desktop 优先，fetch fallback（web 模式走 Vite proxy → Express）。

## 判定链路（renderer）

`chat-auto-urge.ts`：
- `AutoUrgeState` 加可选 `judgeMode`；
- `evaluateAutoUrge` 在 active/enabled 检查后**先做 ask-user 拦截**：`latestTurnHasPendingAskUser(messages)`（最后一条用户消息之后存在 `meta.kind==='ask-user'`）→ `skip`，两种 trigger、两种模式都拦；
- stream-finished + `judgeMode==='local-model'` → 返回新 kind `{kind:'judge', message}`（不做关键词检查）；manual-activation 不判定直接 send（用户显式打开就是要催）；
- 新增 `getLatestAssistantTurnText(messages)`：最新回合最后一条非 ask-user、非空 assistant 文本，尾部截 4000 字符。

`ChatCard.tsx`：
- `autoUrgeStateRef` 加 `judgeMode`/`judgeModel`（来自 activeAutoUrgeProfile）；新增 `cardStatusRef`（渲染期赋值）；
- `runAutoUrge` 处理 `kind:'judge'`：无 judgeModel → 放弃；调 `judgeUrgeWithOllama`；`shouldContinue===false` → card 源关闭卡鞭策（global 源不写卡）；`true` → 发送前校验 `cardStatusRef.current==='idle'`（判定期间用户可能已手动发消息）；请求失败/不可解析 → 静默放弃。

## 设置 UI（App.tsx）

- profile 编辑卡：成功关键词行前加"判定方式" select；`local-model` 时关键词输入替换为"判定模型" select（选项 = ollamaStatus.models ∪ 当前 judgeModel），Ollama 未运行/无模型时显示引导提示。
- 自动鞭策块尾部加 **Ollama 管理小节**：状态行、按钮（安装/启动、装推荐模型、刷新）、task 运行时日志尾部 + 2s 轮询（task running 时）。
- `updateAutoUrgeProfile` 的 Pick 类型加 `judgeMode`/`judgeModel`。

## 测试

- `tests/chat-auto-urge.test.ts`：ask-user 拦截（两种 trigger、已回答不拦）、judge kind 返回、getLatestAssistantTurnText。
- `tests/auto-urge-settings.test.ts`：judgeMode 默认/非法回退、judgeModel 保留。
- `tests/ollama-manager.test.ts`（新，注册 index.test.ts）：recommendOllamaModel 阈值、parseUrgeJudgeVerdict 容错、resolveOllamaBaseUrl、judge()（注入 fetch mock）。
- UI 浅层接线以 `test:quality` + 手动为门（Playwright harness 现有噪音，pitfall 25/34）。
