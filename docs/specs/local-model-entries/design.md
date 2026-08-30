# 自定义本地模型条目 — 设计

## 核心思路

**不新增 provider，把本地模型伪装成一个"模型选项"。**

`ChatCard` 的模型选择器已经有「自定义模型注入」的机制（`src/components/ChatCard.tsx（模型选项构造处）`：`custom ? [custom, ...MODEL_OPTIONS] : MODEL_OPTIONS`），且选项值格式就是 `` `${provider}:${model}` ``（`getSelectValue`）。本地条目只要变成一个 `ModelOption`，就能天然融入选择器、天然带上 provider 切换，UI 侧改动极小。

真实模型名与端点信息不进 `card.model`，而是用一个**令牌**指向条目，在后端最上游翻译一次。

## 数据模型（shared/schema.ts）

```ts
export const localModelEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  harness: providerSchema.default('codex'),    // 复用 'codex' | 'claude'，不新增 provider
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
- `harness` 非法 → `'codex'`（默认值的理由见下文「默认 harness 为什么是 codex」）
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

`launchProviderRun`（provider launch 入口）拿到 `request` 后、调 `resolveProviderRuntime`（:2888）之前：

1. `parseLocalModelToken(request.model)` → 命中则从 settings 取出对应 entry；
2. `resolveProviderRuntime(provider, entry)` —— 给它加**可选第二参数**：传了 entry 就用 `entry.baseUrl` / `entry.apiKey`，不传则走原来的 `getActiveProviderProfile` 全局逻辑（其它不带条目的调用点保持原行为）；
3. 把 `request.model` 替换成 `entry.model`（真实模型名）后再往下走 —— `buildClaudeArgs` / `buildCodexArgs` / 流解析器**完全不需要改**，它们看到的就是一个普通模型名。

条目查不到（被删了）时：不注入端点，`request.model` 回落到 `getDefaultModel(provider)`，并 `onLog` 一句提示，避免卡片卡死在无效模型上（requirements #5）。

⚠️ `resolveProviderRuntime` 里 `if (!apiKey) return baseEnv` 这条短路必须保留；本地条目在后端先用占位串 `local`，因此 UI 可让 apiKey 留空。

## 渲染层

- `src/components/ChatCard.tsx（模型选项构造处）`：`base` 前面并入 `buildLocalModelOptions(settings.localModelEntries)`。本地条目排在最前，便于识别。
- `src/components/ChatCard.tsx（模型合法性判断处）`（`MODEL_OPTIONS.some(...)` 判断模型是否属于该 provider）需要把本地令牌也算作合法，否则切换时会被判为非法模型。
- 条目被删除后，仍指向它的卡片：`selectOptions.find(...) ?? selectOptions[0]`（模型选择兜底处）已有兜底，配合后端回落即可，无需额外状态迁移。
- `AutomationBoardCard.tsx（模型选项消费处）` 也消费 `MODEL_OPTIONS`；本次**不改**（看板模板另有语义，超出需求范围），在 tasks 里记为已知不覆盖面。

## 设置 UI（src/App.tsx）

在「路由」面板（`id="app-panel-routing"`）内、provider profile 区之后，新增「本地模型」小节，照抄 profile 的列表 + 草稿模式（沿用现有 profile 草稿/保存模式）：

- 每行：显示名、harness 下拉（Claude CLI / Codex CLI）、Base URL、API Key、模型名、删除按钮
- 新建草稿区 + 「添加」按钮
- **apiKey 可留空**，后端统一补为 `local` —— 避免把本地服务不需要的密钥变成保存门槛
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

## 四个必须处理的连带点（漏掉就是线上 bug）

### 1. Claude keepalive 池的 key 必须含 baseUrl

`server/providers.ts（keepalive 池构造处）` 的 keepalive 池跨 turn 复用 CLI 进程，而 `ANTHROPIC_BASE_URL` 是**进程启动时定死在 env 里的**。同一张卡从条目 A 换到条目 B（不同 baseUrl），若池 key 不变就会**继续用旧进程 = 旧端点**，表现为"换了模型但没生效"。

池签名必须把生效的 baseUrl 算进去。相关既有测试：`tests/claude-keepalive-signature.test.ts`、`tests/claude-session-pool.test.ts`。

### 2. 路由签名变化必须作废原生 session

`src/state.ts:100-110` 的 `providerRoutingSignature` 目前只看 active profile 的 `id/baseUrl/apiKey`，变了就 `clearProviderNativeSessions`（:161-172）。

本地条目绕过了 active profile，所以**签名不会变** → 换端点时不清 session → **把上一家的 session id 发给下一家**。这类跨家 session 串台此前已有先例（见 provider profile 切换的处理）。签名计算必须把卡片当前选中的本地条目（其 baseUrl/apiKey）纳入。

### 3. `selectCardModel` 的全局偏好写入要挡住令牌

`src/state.ts:1396-1405`：换模型时会把模型名写进 `settings.requestModels[provider]` 与 `column.model` 作为"下次新建卡的默认"。若把 `__local__:<id>` 写进去，之后条目被删，新建的卡就会**默认落到一个不存在的条目**上。

处理方式与既有工具卡令牌一致——`rememberGlobalPreference` 的判定本就排除 `isToolCardModel`，本地令牌照此办理：**不写全局偏好，只作用于当前卡**。这也符合需求 #4「逐卡生效」。

### 4. 本地推理必须绕开断线续传代理

`resilientProxyEnabled` 默认开启（首字节 90s / 停顿 60s / 最多重试 6 次）。这套参数是为云端中转
设计的，套到本地推理上会直接引发雪崩：

- 本机 27B 模型啃 4 万 token 的 prompt 远超 90 秒 → 首字节超时
- 代理换一条连接重试，但 **Ollama 收不到取消信号**，仍在算那个已经没人要的结果
- 6 次重试堆出 6 个算不完的僵尸任务，全挤在 Ollama 的单个推理槽位上

2026-08-29 实测（本机 Ollama + `huihui_ai/Qwen3.8-abliterated:27b`）：27 条并发连接、单个请求
恒定 `5m5s` 后 500、GPU 400W 满载空转两小时。**堆积发生在推理侧，关掉界面也停不下来。**

因此 `resolveProviderRuntime` 对本地推理端点一律跳过代理，判定取两个条件的或：

- `localEntry` 存在 —— 覆盖局域网上的本地推理（192.168 段的 LM Studio 不是 loopback，但同样
  慢、同样收不到取消信号）
- `isLoopbackBaseUrl(baseUrl)` —— 覆盖用户不建条目、直接在「接口配置」里手填本机端点那条路径

只判其一都会漏。守卫测试见 `tests/provider-routing-runtime.test.ts` 的
`never routes a local model entry through the resilient proxy` 及相邻三条（含反向守卫：
云端 profile 必须保留代理）。

**不要用"把首字节超时调到上限 600s"代替。** 那是治标，且重试对本地推理本就无意义 —— 云端超时
多半是网络抖动，重发有用；本地超时只是"还没算完"，重发只会让同一个模型从头再算一遍。

注意这与 `src/App.tsx` 的**流恢复**重试（`getRecoverableStreamRetryLimit`）不是一回事：那一层
在流真的断开后带着 sessionId 续传，对本地模型仍然有效，不在本条的关闭范围内。

## 其他连带面

- `App.tsx 有多个发送入口计算 `resolvedModel`，令牌翻译若放前端就要改多处 —— 这正是选择**在后端最上游翻译**的理由，前端 4 处一行都不用动。
- `src/hooks/persistence-queue.ts` 的 action 持久化白名单，新增的本地条目 action **必须登记**，否则设置改了不落盘。
- 设置面板"默认模型"输入框有两处重复渲染（两处默认模型输入框），本次不涉及，但新增 UI 若放同一区域需留意别只改一处。

## 默认 harness 为什么是 codex（2026-08-30 改）

**结论先行：新建条目默认 `codex`。** 下面这张表是同机、同模型、同一句「OK」的实测：

| harness | 一句「OK」的 token 开销 | 占 32K 上下文 | 耗时 |
|---|---|---|---|
| Codex CLI | 9,164 | 28% | 数秒 |
| Claude CLI | **27,387** | **84%** | **299 秒** |

差的不是常数而是数量级，且 Claude 那一列直接把 32K 上下文吃掉八成 —— 留给真正工作的空间所剩
无几。24GB 显存放一个 27B Q4 模型时，65K 上下文已经占到 22453/24564 MiB（91%），没有余量再
往上抬。**这不是调参能解决的，是 harness 自带的系统提示与工具定义摊在每一轮上。**

第二个理由是「关闭思考」开关。用户报「IDE 的思考关闭之后似乎没效果」，根因是三层叠加：

1. Claude CLI **根本没有关思考的开关**，`--effort` 只收 low/medium/high/xhigh/max，
   于是 IDE 的开关只能翻成 `--effort low`（`shared/reasoning.ts` 的 `toClaudeEffortFlagValue`，
   同一处注释里记着 pitfall #289）。
2. 本地条目当时默认就是 claude harness。
3. Ollama 的 `/v1/messages` 只认 `thinking:{"type":"disabled"}`、**无视 budget 大小**，
   所以 low 和 max 在它那儿行为完全一致 —— 而 Claude CLI 永远不会发出 `disabled`。

Codex 侧没有这个问题：关思考落 `model_reasoning_effort="none"`（`server/providers.ts` 的 Codex 参数构造处），
实测能让 Responses 的输出块从 `['reasoning','message']` 变成 `['message']`，思考是真的关掉了。

被否决的替代方案：

- **保留 claude 默认、只在 UI 加一句提示。** 用户得先读懂提示、再理解两个 CLI 的协议差异才能
  自救；默认值本就该指向当下能用的那一个。
- **绕开两个 CLI、直接打 Ollama 的 HTTP 接口。** 被 `AGENTS.md` 的硬约束挡住（所有 AI 请求
  必须走 `claude`/`codex` 路由路径），且本仓库的 provider 差异散落在 30+ 文件的分支与
  `Record<Provider,X>` 表里。codex 的 9K 开销已经可接受，问题原本就特指 claude 的 27K。
- **在模型层关思考**（`ollama create` 加 `PARAMETER think false`）。实测 `Error: unknown
  parameter 'think'` —— 这是 API 字段，不是模型参数，模型层关不掉。

已选 claude 的老条目不受影响：默认值只作用于新建与非法值回落，显式存下的 `'claude'` 原样保留。

## 实测：两个 harness 各自能连什么（2026-08-23，接本机 Ollama 0.32.9 端到端验证）

> ⚠️ **下表已过时，仅作历史记录。** 当日「Codex CLI → 404」是因为 Ollama 0.32.9 没有
> `/v1/responses`；0.32.15 已补上该端点，codex harness 实测可用。当初选 claude 当默认正是
> 因为 codex 打不通，这个前提已不成立 —— 见上一节。

路由层本身已验证正确：令牌被翻成真实模型名、端点与密钥都跟着条目走、故意放的云端 profile
没有泄漏进来。但**CLI 侧的兼容性是另一回事**，这里记下当天的实测结论，避免有人重走一遍：

| harness | 打的端点 | 对 Ollama 的结果 |
|---|---|---|
| Codex CLI | `<baseUrl>/responses`（Responses API） | ❌ 404 —— Ollama 只有 `/v1/chat/completions` |
| Claude CLI | `<baseUrl>/v1/messages` | ⚠️ 当日：进程起得来、`system/init` 也发了，但**始终没向 Ollama 发出请求**，120s 超时且 stderr 全空 |

两条重要的负面结论：

1. **不要试图给 Codex 注入 `wire_api = "chat"` 来迁就本地服务。** 当日版本的 Codex CLI 已经
   移除该值，注入后 CLI 直接死在配置解析上（"`wire_api = \"chat\"` is no longer supported"），
   连启动都做不到 —— 比 404 更糟。守卫测试见 `tests/provider-routing-runtime.test.ts` 的
   "never injects a wire api override"。
2. **Codex harness 的 baseUrl 必须带 `/v1`，但现在不用用户自己记了。** Codex CLI 的默认值是
   `https://api.openai.com/v1`，它在此之后直接拼 `/responses`；用户若只填
   `http://127.0.0.1:11434`（Ollama 官方文档里到处都是这个不带 `/v1` 的地址），CLI 会去打
   `http://127.0.0.1:11434/responses` 并返回 `404 page not found, url: /responses` ——
   光看这条报错根本看不出是少了 `/v1`。
   Claude harness 则相反，填到主机根即可（`ANTHROPIC_BASE_URL` 后面由 CLI 补 `/v1/messages`），
   替它加 `/v1` 会打成 `/v1/v1/messages`。

   2026-08-30 补丁：`normalizeLocalModelBaseUrl(harness, baseUrl)`（`server/providers.ts`）在拼
   env 的地方按 harness 分岔兜住这个差异，去掉尾部斜杠后只给 codex 补 `/v1`，且幂等（已带
   `/v1` 的地址不会变成 `/v1/v1`）。
   原先的补丁只在 baseUrl **留空**时生效，于是「先按 claude 填好主机根、之后再改 harness」
   和「照 Ollama 文档手填主机根」这两条路径都会掉进夹缝。
   被否决的替代方案：在 UI 切 harness 时顺手改写用户填的地址 —— 那是在用户眼皮底下动他的
   输入框，且绕不开手填这条路径。守卫测试见 `tests/provider-routing-runtime.test.ts` 的
   `adds the /v1 suffix when a codex local entry supplies a host root` 与反向守卫
   `never appends /v1 for a claude local entry`。

### 后续（2026-08-29）：上表 Claude CLI 那一行的根因已查清，且已修

当日"始终没向 Ollama 发出请求"的根因是 **`~/.claude/settings.json` 的 `env` 优先级高于进程
环境变量** —— `resolveProviderRuntime` 只把 `ANTHROPIC_*` 注入到 spawn 的 env 里，被用户级
配置整个盖掉，CLI 拿着用户原本的云端端点在跑。修复是改走 `--settings` 深合并层精确压住 `env`
这一个键（不能换 `CLAUDE_CONFIG_DIR` 隔离，那会连用户的 `CLAUDE.md`、skills、MCP 一起丢）。
根因与守卫见 `tests/claude-settings-env-override.test.ts`。

同日实测已观测到 Claude CLI **确实向本机 Ollama 发出了 `POST /v1/messages` 并拿到 200**，
上表那一行的现象不再复现。当天真正卡住的是另一件事 —— 断线续传代理的超时重试雪崩，见前文
「四个必须处理的连带点」的第 4 条。

对已实现 Responses API 或 Anthropic Messages API 的其它本地服务（如较新的 vLLM、LM Studio）
仍未逐一验证。

## 非目标 / 已知不覆盖

- 不改 `AutomationBoardCard` 的模型选择（它用 `provider::model` 双冒号格式，另一套语义）。
- 不做端点可达性探测。
