# 自定义本地模型条目 — 需求

## 背景

Chill Vibe 目前只能用 `codex` / `claude` 两个 CLI 连各自的官方端点或中转站。想用本机跑的模型（Ollama / LM Studio / llama.cpp / vLLM）时，只能去「路由 → provider profile」里改 `baseUrl`，而那是**全局单选**的：一个 provider 同时只有一个 active profile，改了之后所有用该 provider 的卡片一起被切走，无法「这张卡用本地模型、那张卡用云端」。

2026-08-23 实测确认：本地推理服务已能直接说 CLI 听得懂的话（Ollama 0.32.9 提供标准 Anthropic `/v1/messages`，含 SSE 与 `thinking_delta`；OpenAI 兼容端点则对应 Codex CLI），所以**不需要新增 provider，复用现有两个 CLI 当 harness 即可**。缺的只是一层「让用户把本地端点存成可选条目」的配置与选择能力。

## 需求

1. **本地模型条目（新概念）**：用户可在设置里维护一组条目。**只有两项必填**：
   - `harness`：这条用哪个 CLI 驱动，`claude` 或 `codex`（下拉选择）
   - `model`：真实模型名，原样传给 CLI（例：`qwen3-coder:30b`）。本机已装的 Ollama 模型
     直接可选（复用已有的 `fetchOllamaStatus`），同时保留手输，以便接 LM Studio / vLLM 等
     不在 Ollama 列表里的服务。

   其余三项留空即可，收进「高级」折叠区，只在连非默认端口或远程机器时才需要：
   - `label` 显示名（留空则显示模型名）
   - `baseUrl`（留空 → 本机 Ollama 地址，且 **codex 自动补 `/v1`**、claude 用主机根）
   - `apiKey`（留空 → 占位串 `local`）

   > 让用户去记「codex 要带 /v1、claude 不带」是纯粹的负担：填错的表现是
   > `404 page not found, url: .../responses`，光看报错完全看不出是少了 `/v1`。
   > 同理 apiKey 留空会让 baseUrl 静默失效。这两个默认值一律由后端补齐，不推给用户。
2. **增删改**：设置面板提供列表 + 新建草稿 + 保存 + 删除，与现有 provider profile 的编辑体验一致。
3. **出现在模型选择器**：配置好的条目作为选项出现在模型卡片/模型选择菜单中，与内置模型并列但可区分（分组或标记）。
4. **选中即生效（逐卡）**：某张聊天卡选中某个本地条目后，**只有该卡**改用该条目的 harness CLI + `baseUrl` + `apiKey` + 真实模型名；其他卡不受影响，全局 provider profile 不被改写。
5. **归一化与容错**：
   - `harness` 非法值回退到 `claude`；
   - 字段做 trim；`label` 为空时回退显示 `model`；
   - 条目被删除后，仍指向它的卡片回退到该 provider 的默认模型，不得让卡片卡在无效模型上；
   - 老版本 `state.json`（无此字段）加载后必须得到空列表而不是报错。
6. **不破坏现有行为**：不配置任何条目时，模型选择器、provider profile、`cliRoutingEnabled` 等一切行为与现状完全一致。

## 非目标

- 不新增第三个 provider（不动 `providerSchema`），不写新的流解析器。
- 不做模型能力探测、不校验 `baseUrl` 是否可达、不校验模型名是否存在（与现有「自定义模型名不校验」的既定策略一致，见 `shared/models.ts` 里关于中转站的说明）。
- 不接管 Ollama 的安装/拉取（那已由 `server/ollama-manager.ts` 覆盖，且服务于鞭策判官，与本需求无关）。
- 不解决本地推理本身的性能问题（无 prompt caching、小模型工具调用不可靠等）——那是模型与推理服务侧的事。

## 已知约束（实测）

- `server/providers.ts` 中 `if (!apiKey) return baseEnv`：**apiKey 为空会让 baseUrl 静默失效**。本地条目在到达这行之前就把空值换成占位串，所以用户可以留空。
- `settings.cliRoutingEnabled` 关闭时整段 env 注入被跳过，本地条目同样不生效——需要在 UI 上提示，而不是让用户困惑。
