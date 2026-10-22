# 新模型自动发现 — Design

## 纯函数 `shared/model-discovery.ts`
- `parseModelListIds(body)`：兼容 Anthropic / OpenAI（`data[].id`）与 Google（`models[].name` 去 `models/` 前缀）。
- `isChatModelCandidate(provider, id)`：家族前缀（claude-/gpt-|o\d/gemini-）+ 噪声黑名单（compact、auto-review、embed、tts、whisper、image、audio、realtime、moderation、search、transcribe）+ 去掉 `-YYYYMMDD` 快照。
- `parseModelVersion(provider, id)` → `{ family, version: number[] }`：
  - Claude `claude-<tier>-<maj>(-<min>)?` → family `claude:<tier>`；
  - Codex `gpt-<ver>(-<tier>)?` → family `codex:<tier|base>`；
  - Gemini `gemini-<ver>-<tier…>` → family `gemini:<tier…>`（去 `-preview`）。
- `findDiscoveredNewModels({ provider, ids, customModels, seen })`：去掉目录已有 / 自定义已有 / 已提示；同家族要求版本 > 目录同家族最大版本；家族目录里没有（新档位）则要求主版本 ≥ 该 provider 目录最大主版本。
- `buildDiscoveredModelLabel(provider, id)`：`claude-opus-6-1` → `Opus 6.1`，`gpt-6.2-sol` → `GPT-6.2 Sol`，`gemini-4-pro` → `Gemini 4 Pro`。
- 键 `provider:model`，已提示名单存 `settings.seenDiscoveredModels: string[]`（schema 默认 `[]`，归一化去重去空）。

## 服务端 `server/model-discovery.ts`
- `resolveModelDiscoveryEndpoint(provider, settings, io)`：按 requirements #2 解析 `{ url, headers }`；io 注入 `readFile`/`env`/`homedir` 便于单测。Codex TOML 只做节感知的正则解析（`model_provider`、`[model_providers.<name>]` 下的 `base_url`/`env_key`），没有 `model_provider` 时用官方 `https://api.openai.com/v1`。
- `discoverProviderModels(settings)`：三个 provider 并发 fetch，10s 超时，返回 `{ provider, ids, error? }[]`。
- HTTP `GET /api/models/discover`；桌面走 IPC `desktop:discover-models`（backend.ts / main.ts / preload.ts / electron.d.ts）。

## 渲染端 `src/App.tsx`
- `loadStatus==='ready'` 后延迟 8s 调一次（每次启动一次，useRef 防重入），结果存 `discoveredModels` state；
  `newDiscoveredModels = useMemo(findDiscoveredNewModels …)` 依赖 settings，所以加入 / 忽略后自然消失。
- 弹窗可见条件同换代弹窗，并要求换代弹窗不在显示（避免叠窗）。复用 `structured-preview-*` + `model-upgrade-list` 样式。
- 「加入下拉」/「全部加入」：追加 `modelPickerCustomModels` + `seenDiscoveredModels`；「忽略」/Esc/点背景：只追加 `seenDiscoveredModels`。

## 被否决
- 直接改 `MODEL_OPTIONS` 运行时目录：目录被子 agent 提示词、超管 MCP、换代表共用，未验证的型号混进去会让 agent 选到不能用的模型。
- 经 CLI 问模型列表（Codex `model/list`）：返回的是 CLI 内置表，不是中转站实际上架的，发现不了「CLI 还没跟上」的新型号。
- 静默自动加入：用户口味是「不打扰但要让我点头」，自动加会让下拉越来越长。
