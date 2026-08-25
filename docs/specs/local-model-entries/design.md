# 自定义本地模型条目 — 设计

## 核心思路

**不新增 provider，把本地模型伪装成一个"模型选项"。**

`ChatCard` 的模型选择器已经有「自定义模型注入」的机制（`src/components/ChatCard.tsx:3602-3604`：`custom ? [custom, ...MODEL_OPTIONS] : MODEL_OPTIONS`），且选项值格式就是 `` `${provider}:${model}` ``（`getSelectValue`）。本地条目只要变成一个 `ModelOption`，就能天然融入选择器、天然带上 provider 切换，UI 侧改动极小。

真实模型名与端点信息不进 `card.model`，而是用一个**令牌**指向条目，在后端最上游翻译一次。

## 数据模型（shared/schema.ts）

```ts
export const localModelEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  harness: providerSchema.default('claude'),   // 复用 'codex' | 'claude'，不新增 provider
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
})
export type LocalModelEntry = z.infer<typeof localModelEntrySchema>
```

`appSettingsSchema` 新增 `localModelEntries: z.array(localModelEntrySchema).default([])`。
默认值同步 `shared/default-state.ts` 的 `createDefaultSettings`（给 `[]`）与 `shared/schema.ts` 内的 settings 默认对象。

归一化 `createLocalModelEntry(overrides, options)`（仿 `createAutoUrgeProfile`，default-state.ts:344）：
- `id` 空 → `options.fallbackId` → `createId()`
- `harness` 非法 → `'claude'`
- 各字符串 `normalizeText`（trim）
- `normalizeLocalModelEntries(list)`：非数组 → `[]`；逐项过滤非对象；**`model` 为空的条目直接丢弃**（无真实模型名的条目无法工作）；id 去重。

## 令牌（shared/models.ts）

```ts
export const LOCAL_MODEL_TOKEN_PREFIX = '__local__:'
export const buildLocalModelToken = (id: string) => `${LOCAL_MODEL_TOKEN_PREFIX}${id}`
export const parseLocalModelToken = (model?: string | null): string | null
export const isLocalModelToken = (model?: string | null) => parseLocalModelToken(model) !== null
export const buildLocalModelOptions = (entries: LocalModelEntry[]): ModelOption[]
```

选 `__local__:` 前缀的两个理由（都不是随意的）：
1. 与既有工具卡令牌（`__git_tool__` 等，`shared/models.ts:177`）风格一致，一眼可辨非真实模型名。
2. `resolveSlashModelInput` 的 `customModelNamePattern = /^[A-Za-z0-9][\w.:+\-/]{1,63}$/` **要求首字符是字母数字**，下划线开头天然落选 —— 用户无法通过 `/model __local__:xxx` 手打出一个指向不存在条目的令牌。这是白捡的护栏，不要改成 `local:`。

`buildLocalModelOptions` 产出 `{ label: entry.label || entry.model, provider: entry.harness, model: buildLocalModelToken(entry.id) }`。

## 后端路由（server/providers.ts）

**关键：在最上游翻译一次，下游零改动。**

`launchProviderRun`（:2827）拿到 `request` 后、调 `resolveProviderRuntime`（:2888）之前：

1. `parseLocalModelToken(request.model)` → 命中则从 settings 取出对应 entry；
2. `resolveProviderRuntime(provider, entry)` —— 给它加**可选第二参数**：传了 entry 就用 `entry.baseUrl` / `entry.apiKey`，不传则走原来的 `getActiveProviderProfile` 全局逻辑（另外两个调用点 :1413 / :4136 不传，行为不变）；
3. 把 `request.model` 替换成 `entry.model`（真实模型名）后再往下走 —— `buildClaudeArgs` / `buildCodexArgs` / 流解析器**完全不需要改**，它们看到的就是一个普通模型名。

条目查不到（被删了）时：不注入端点，`request.model` 回落到 `getDefaultModel(provider)`，并 `onLog` 一句提示，避免卡片卡死在无效模型上（requirements #5）。

⚠️ `resolveProviderRuntime` 里 `if (!apiKey) return baseEnv`（:536）这条短路必须保留 —— 但 entry 分支要用 `entry.apiKey`，所以 UI 侧必须保证 apiKey 非空（见下）。

## 渲染层

- `src/components/ChatCard.tsx:3602-3604`：`base` 前面并入 `buildLocalModelOptions(settings.localModelEntries)`。本地条目排在最前，便于识别。
- `src/components/ChatCard.tsx:495`（`MODEL_OPTIONS.some(...)` 判断模型是否属于该 provider）需要把本地令牌也算作合法，否则切换时会被判为非法模型。
- 条目被删除后，仍指向它的卡片：`selectOptions.find(...) ?? selectOptions[0]`（:3612）已有兜底，配合后端回落即可，无需额外状态迁移。
- `AutomationBoardCard.tsx:204` 也消费 `MODEL_OPTIONS`；本次**不改**（看板模板另有语义，超出需求范围），在 tasks 里记为已知不覆盖面。

## 设置 UI（src/App.tsx）

在「路由」面板（`id="app-panel-routing"`，:9617）内、provider profile 区之后，新增「本地模型」小节，照抄 profile 的列表 + 草稿模式（:9761-9870 / `updateDraft`:2263 / `updateProviderProfile`:2317）：

- 每行：显示名、harness 下拉（Claude CLI / Codex CLI）、Base URL、API Key、模型名、删除按钮
- 新建草稿区 + 「添加」按钮
- **apiKey 输入框默认填 `local`**，并在为空时阻止保存 —— 直接对应「apiKey 为空会让 baseUrl 静默失效」这个坑
- `cliRoutingEnabled` 关闭时，本小节顶部显示一条警告（本地条目同样不会生效）

i18n 文案加进 `src/app-panel-text.ts`（中英两套，:1-30 的 `getPanelText` 结构）。

## 测试

新增 `tests/local-model-entries.test.ts`（注册进 `tests/index.test.ts`，按字母序）：
- `createLocalModelEntry` / `normalizeLocalModelEntries`：非法 harness 回退、trim、空 model 丢弃、id 去重、老 state（undefined）→ `[]`
- `buildLocalModelToken` / `parseLocalModelToken`：往返、非令牌返回 null、`customModelNamePattern` 拒绝令牌（护栏回归测试）
- `buildLocalModelOptions`：label 回退到 model、provider 取 harness

扩 `tests/provider-routing-runtime.test.ts`：
- 传 entry 时注入 entry 的 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`，且**不受全局 active profile 影响**
- 不传 entry 时行为与现状逐字节一致（回归护栏）

## 不装 Ollama 也必须能用

模型名输入框用 `<datalist>` 而不是 `<select>`：本机已装的 Ollama 模型作为**建议项**出现，
但输入框本身永远可以手输。LM Studio / llama.cpp / vLLM 的模型不在 Ollama 列表里，
若做成受限下拉，这些用户直接被挡在门外。

配好之后的选择器**完全不依赖 Ollama**：`buildLocalModelOptions` 只读 `settings.localModelEntries`，
和本机装没装 Ollama、Ollama 有没有在跑都无关。

两个已修的相关缺陷：

1. **探测时机漏了路由页。** 原来的条件是「设置页 + 开了自动鞭策」（那是鞭策判官的需求），
   而本地模型 UI 在路由页 —— 结果打开路由页时 `ollamaStatus` 还是 null，**装了 Ollama 也
   列不出任何模型**。已抽成 `shouldSyncOllamaStatus`（`src/app-helpers.ts`）并加测试。
2. **空列表提示判错了条件。** 原来写 `ollamaStatus?.running === false`，而 `undefined === false`
   为假，于是「探测失败」和「从未探测」这两种情况反而不提示，用户只看到一个空输入框。
   改为判 `models.length === 0` —— 没装、没启动、装了但没拉模型、探测失败，对用户都是同一件事。

## 三个必须处理的连带点（漏掉就是线上 bug）

### 1. Claude keepalive 池的 key 必须含 baseUrl

`server/providers.ts:1413` 的 keepalive 池跨 turn 复用 CLI 进程，而 `ANTHROPIC_BASE_URL` 是**进程启动时定死在 env 里的**。同一张卡从条目 A 换到条目 B（不同 baseUrl），若池 key 不变就会**继续用旧进程 = 旧端点**，表现为"换了模型但没生效"。

池签名必须把生效的 baseUrl 算进去。相关既有测试：`tests/claude-keepalive-signature.test.ts`、`tests/claude-session-pool.test.ts`。

### 2. 路由签名变化必须作废原生 session

`src/state.ts:100-110` 的 `providerRoutingSignature` 目前只看 active profile 的 `id/baseUrl/apiKey`，变了就 `clearProviderNativeSessions`（:161-172）。

本地条目绕过了 active profile，所以**签名不会变** → 换端点时不清 session → **把上一家的 session id 发给下一家**。这类跨家 session 串台此前已有先例（见 provider profile 切换的处理）。签名计算必须把卡片当前选中的本地条目（其 baseUrl/apiKey）纳入。

### 3. `selectCardModel` 的全局偏好写入要挡住令牌

`src/state.ts:1396-1405`：换模型时会把模型名写进 `settings.requestModels[provider]` 与 `column.model` 作为"下次新建卡的默认"。若把 `__local__:<id>` 写进去，之后条目被删，新建的卡就会**默认落到一个不存在的条目**上。

处理方式与既有工具卡令牌一致——`rememberGlobalPreference` 的判定本就排除 `isToolCardModel`，本地令牌照此办理：**不写全局偏好，只作用于当前卡**。这也符合需求 #4「逐卡生效」。

## 其他连带面

- `App.tsx` 有 **4 个** 发送入口计算 `resolvedModel`（:6090 / :6253 / :6666 / :6873），令牌翻译若放前端就要改 4 处 —— 这正是选择**在后端最上游翻译**的理由，前端 4 处一行都不用动。
- `src/hooks/persistence-queue.ts:277-279` 有 action 持久化白名单，新增的本地条目 action **必须登记**，否则设置改了不落盘。
- 设置面板"默认模型"输入框有两处重复渲染（:8794 / :10279），本次不涉及，但新增 UI 若放同一区域需留意别只改一处。

## 实测：两个 harness 各自能连什么（2026-08-23，接本机 Ollama 0.32.9 端到端验证）

路由层本身已验证正确：令牌被翻成真实模型名、端点与密钥都跟着条目走、故意放的云端 profile
没有泄漏进来。但**CLI 侧的兼容性是另一回事**，这里记下当天的实测结论，避免有人重走一遍：

| harness | 打的端点 | 对 Ollama 的结果 |
|---|---|---|
| Codex CLI | `<baseUrl>/responses`（Responses API） | ❌ 404 —— Ollama 只有 `/v1/chat/completions` |
| Claude CLI | `<baseUrl>/v1/messages` | ⚠️ 进程起得来、`system/init` 也发了，但**始终没向 Ollama 发出请求**，120s 超时且 stderr 全空 |

两条重要的负面结论：

1. **不要试图给 Codex 注入 `wire_api = "chat"` 来迁就本地服务。** 当日版本的 Codex CLI 已经
   移除该值，注入后 CLI 直接死在配置解析上（"`wire_api = \"chat\"` is no longer supported"），
   连启动都做不到 —— 比 404 更糟。守卫测试见 `tests/provider-routing-runtime.test.ts` 的
   "never injects a wire api override"。
2. **Codex harness 的 baseUrl 要自己带 `/v1`。** 默认值是 `https://api.openai.com/v1`，
   用户若只填 `http://127.0.0.1:11434`，CLI 会去打 `http://127.0.0.1:11434/responses`。
   Claude harness 则相反，填到主机根即可（`ANTHROPIC_BASE_URL` 后面由 CLI 补 `/v1/messages`）。

Claude CLI 卡住的根因**尚未查清**，需要单独一轮排查（怀疑是它在发首个请求前还有一步握手或
校验）。在那之前，本功能对 Ollama 属于"配得上、跑不通"；对已经实现 Responses API 或
Anthropic Messages API 的其它本地服务（如较新的 vLLM、LM Studio）则未验证，可能可用。

## 非目标 / 已知不覆盖

- 不改 `AutomationBoardCard` 的模型选择（它用 `provider::model` 双冒号格式，另一套语义）。
- 不做端点可达性探测。
