# Chill Vibe IDE 设计文档

## 1. 设计原则

### 1.1 Board First

界面不是“先进入项目，再进入会话”，而是直接进入看板。用户打开后看到的就是所有并行中的工作流。

### 1.2 Card Is Chat

每个卡片就是完整会话页面，不进入二级详情页，不做额外跳转。

### 1.3 Quiet UI

顶部工具条尽量收敛，控制按钮以图标为主，把注意力留给卡片正文和工作区配置。

### 1.4 Stretch With Work

聊天内容默认向下增长，卡片保留手动拉伸能力，用来调节最低可视高度，而不是把消息困在一个小滚动区里。

## 2. 信息架构

### 2.1 顶层结构

- 整个页面只有一个横向看板容器。
- 看板中是多个工作区列。
- 最右侧是一个加号占位列，用于新增列。

### 2.2 列结构

每一列包含：

- 拖拽手柄
- 列标题，以及 provider / workspace / model 摘要
- 设置、复制、新增卡片、删除等图标按钮
- 展开的工作区设置区
- 垂直堆叠的聊天卡片

### 2.3 卡片结构

每张卡片包含：

- 标题
- 会话状态与会话 ID 摘要
- 删除与拖拽图标
- 消息列表
- 输入区，以及发送 / 停止图标
- 底部拉伸手柄

## 3. 交互设计

### 3.1 列拖拽

- 通过列头手柄拖动
- 在目标列左半区或右半区落下
- 分别对应插入到目标列前后

### 3.2 列宽调整

- 列之间的分隔手柄可横向拖动，用于给当前工作流快速让出更多横向空间。
- 单列最窄宽度为 130px，允许临时压缩成窄栏，但不应破坏列头与列内容的对齐关系。

### 3.3 卡片拖拽

- 通过卡片头部手柄拖动
- 可在同列内重排
- 可跨列移动
- 可拖到列底部空白处插入到末尾

### 3.4 卡片高度拉伸

- 卡片底部有专用拉伸手柄
- 用户拖动后改变卡片最小高度
- 内容超出时继续向下增长，而不是强制固定在内部滚动框

### 3.5 新增列

- 顶部新增按钮已移除
- 看板最右侧保留一个加号占位列
- 点击后复制最近一列的 provider / workspace / model 作为默认值

## 4. 视觉设计

### 4.1 总体方向

- 中性浅色底
- 柔和边框和阴影
- 明确的看板块状分组
- 少文案、少噪音、少装饰

### 4.2 图标策略

- 设置、复制、删除、发送、停止、新增、拖拽均使用图标按钮
- 文字保留给标题、路径和状态这类信息本体

### 4.3 状态反馈

- Ready：绿色弱强调
- Running：暖色弱强调
- Error：红色弱强调
- Drop 提示：目标边缘高亮

## 5. 数据模型

```ts
type Provider = 'codex' | 'claude'

type AppState = {
  version: 1
  columns: BoardColumn[]
  updatedAt: string
}

type BoardColumn = {
  id: string
  title: string
  provider: Provider
  workspacePath: string
  model: string
  cards: ChatCard[]
}

type ChatCard = {
  id: string
  title: string
  sessionId?: string
  sessionModel?: string
  status: 'idle' | 'streaming' | 'error'
  size?: number
  messages: ChatMessage[]
}
```

说明：

- `workspacePath` 决定 CLI 的工作目录
- `workspacePath` 只是 CLI 的 cwd，不是文件系统权限边界。普通 Codex 会话仍可保持既有 `danger-full-access + approvalPolicy=never`，但 IDE 默认注入独立的 `PreToolUse` 高风险删除防护，并在设置中允许用户明确关闭；Hook 未被当前 CLI 发现、信任或启用时必须失败关闭，不能静默裸跑。
- Codex Agent 主目录隔离默认开启：Windows 隔离 `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH`，让 PowerShell 自动 `$HOME` 指向 Chill Vibe 数据目录下的 Agent home，同时保留既有 `HOME` 兼容 Git 全局配置；macOS/Linux 隔离 `HOME`。所有平台显式保留原始 `CODEX_HOME`，登录、原生会话和 Skill 不迁移。
- `sessionId` 对应 provider 原生会话 ID
- `sessionId` 只在当前 provider 路由配置下有效；切换、删除或修改活跃 provider profile 后，相关 provider 的旧会话 ID 必须失效，后续请求改用可见历史重新开始，避免把旧供应商的原生加密上下文续到新供应商
- `sessionModel` 记录该原生会话开始时使用的实际请求模型；继续会话前必须与本次请求模型一致。旧状态里没有 `sessionModel` 的会话视为模型未知，改模型后不能盲目续用，必须用可见历史开启新会话。
- 已完成且包含历史图片附件的聊天也应保留 `sessionId` / `providerSessions`。重启后优先用 provider 原生会话恢复上下文，而不是把历史图片附件重新塞进 fresh-session replay；如果原生恢复真的失效，再走既有 stale-session → fresh-session 回退。
- `size` 表示卡片的最小高度

- Provider request model changes must sync to the Electron backend immediately, not only through delayed state persistence, so the next CLI launch uses the same configured model shown in the renderer.

## 6. 技术设计

### 6.1 前端

- React 管理界面和交互
- 原生 HTML Drag and Drop 实现拖拽排序
- reducer 管理列和卡片状态
- 自动保存布局

### 6.2 后端

- Express 提供状态与会话 API
- 统一封装本地 Codex / Claude CLI
- Codex / Claude skill 互相复用时，斜杠菜单、提示词注入和实际 CLI 文件读取权限必须一致；Claude 复用 Codex 用户级 skill 时，需要预授权对应 `.codex` / `CODEX_HOME` 目录。
- 斜杠命令列表必须在当前聊天卡片激活后后台预热，不能等用户输入 `/` 才启动 provider 探测。Claude 原生命令探测会启动一次 CLI，按工作区和语言缓存 5 分钟；技能目录仍通过前端 5 秒刷新窗口重新扫描，使新建技能无需重启即可出现，同时避免反复启动 Claude CLI 阻塞菜单。
- 使用 SSE 将流式输出推给前端
- 助手消息使用 Markdown 渲染时，外层消息容器不得把源文本的空白行再次按 `pre-wrap` 原样展开；Markdown 自己负责段落、列表与代码块的间距。若 provider 把一组行内代码反引号错误地跨空白行拆开，渲染前应把两段合回同一条 Markdown 行，避免一条中文句子被拆成裸反引号和大段异常留白。
- 每个 provider 回合为“兜底改动卡”保留的 Git 工作区基线必须有硬上限：优先保留已跟踪的脏文件，单文件最多 256 KiB、每回合最多 256 个详细文件 / 4 MiB；相同基线正文通过 32 MiB 有界内容寻址缓存跨会话复用。超限文件仍必须展示文件名和省略原因，不能因差异正文超限而静默消失；启动时已脏但未保留正文的文件不得伪造相对 HEAD 的本轮差异。
- Codex shell tools run through PowerShell on Windows. The Codex base instructions must warn that search patterns containing embedded double quotes, especially JSON literals, should use single quotes, a here-string/script file, or `rg --fixed-strings` instead of a double-quoted PowerShell argument, otherwise PowerShell can fail with `TerminatorExpectedAtEndOfString`.
- Codex destructive-command protection is structural rather than prompt-only: an IDE-owned `PreToolUse` hook canonicalizes deletion targets and blocks user-home/workspace-root ancestors, paths outside the workspace, drive roots, `.git`, Codex/Chill Vibe data, unresolved/runtime-expanded variables, recursive wildcards, relative recursive-delete targets, PowerShell `$home` assignment collisions, `TemporaryDirectory` + bind-mount cleanup hazards, and broad destructive Git operations. Relative recursive deletes fail closed because the current hook payload omits a shell tool's separate `workdir`; explicit absolute workspace-child targets remain allowed. The session-flags hook is trusted by exact key/hash through `hooks/list` + `config/batchWrite`; never use `--dangerously-bypass-hook-trust`, which would also run unrelated untrusted hooks.
- 当当前 provider 的本地 CLI 不可用时，聊天发送仍然要进入应用层校验，并在卡片内追加“本地 CLI 不可用”的系统提示；不能只禁用发送按钮让用户反复点击却没有反馈。
- Claude 流式输出的健壮性（`server/claude-structured-output.ts` + `server/providers.ts` + `server/provider-stream-recovery.ts`）：
  - 模型偶尔把工具调用打成文本（`<function_calls>`/`<invoke>`/`<parameter>`）。增量去除器会剥离这些 XML；遇到**未闭合**的工具调用/ask-user 块时，`flush()` 必须**丢弃**而不是原样吐出——否则渲染层（ReactMarkdown，仅 remark-gfm）会吃掉标签只留下 `<parameter>` 里的内层文本（如 `count`），形成孤立气泡。容器常被换行美化，所以 `<function_calls>` 需容忍其后空白。
  - If malformed Claude text reaches final assistant text (not only streamed deltas), the provider final-assistant path must run the same stripper before emitting deltas, and the renderer fallback must still remove complete or unterminated `<function_calls>` / `<invoke>` blocks plus nested attribute-bearing `<parameter ...>` blocks; otherwise Markdown hides the tags but shows inner values like `count`.
  - When Claude prefixes a malformed typed tool call with retry chatter such as "tool call format broke, retrying" / "工具调用格式坏了，我重新发", suppress that chatter together with the stripped XML and surface only the bounded resume-session recovery. The user should not see fake progress bubbles that describe a broken internal call. Renderer-side fallback must also hide persisted retry chatter such as `call\nEdit 工具反复解析失败,改用 Write 整文件重写。` when it sits next to real tool/edit activity, so old saved transcripts do not keep showing provider protocol noise after a parser fix.
  - When Claude is only mentioning those XML tag names in prose, a leading backtick is enough proof that the tag is user-visible text; stream it immediately instead of waiting for the next body byte, or the live reply looks cut off at the tag.
  - 一轮如果**只**产出了被剥离的工具调用文本（没有真正执行工具、没有有效正文），干净的 `result` 会让聊天静默“停住”。用 `shouldRecoverEmptyToolCallTurn(...)` 判定后改发可恢复的 `resume-session` 错误，交给前端有上限的重试机制自动续跑。
  - Claude 流路径带有失速看门狗：每条 stdout 行都会重置计时器，长时间静默且无终止事件时发可恢复的 `stalled …` 错误；但**有命令在执行时必须停表**（`resolveLocalStreamStallTimeoutMs` 在 `openCommandCount > 0` 时返回 `null`），因为 CLI 执行工具期间本就没有 stdout，否则会误杀正常的长命令。
  - Claude CLI can start a later Bash/tool_use or finish the turn without emitting a local-command completion block for the previous command. The parser must settle the still-open command as `completed` when the next command starts or when the final `result` arrives; otherwise old command rows keep animated blue dots forever and the stream watchdog stays disarmed.
  - Codex app-server command terminal states include `completed`, `failed`, and `declined`. All three must replace the matching `in_progress` activity and stop its blue-dot animation; dropping `failed` leaves finished commands looking active forever.
  - 手动停止或用户打断运行时，前端 `finishStoppedStream` 必须把当前卡片里仍是 `in_progress` 的命令活动落成 `declined`，再追加“这次运行已停止”提示；否则命令行已经停了，但旧命令行卡片仍会保留蓝点动画。
  - Claude 的扩展思考（thinking）默认要显示，和 Codex 的 reasoning 一致。`--include-partial-messages` 会把思考以 `content_block_start/delta(thinking_delta)/stop` 的 partial 事件流式吐出（位于答案文本之前的 index 0）。`createClaudeStructuredOutputParser` 按块索引累积 `thinking_delta`，在 `content_block_stop` 时吐出一条 `kind: 'reasoning'`、`status: 'completed'` 的 activity，复用与 Codex 完全相同的「思考中」卡片渲染。`signature_delta` 只是校验元数据，忽略即可；思考被省略（omitted display，无 `thinking_delta`）时不产出任何 reasoning 块。reasoning 是模型内部独白，**不算**用户可见产出，所以 `sawStructuredActivity` 不能被 reasoning 置真（`structuredActivityCountsAsTurnOutput('reasoning') === false`）；否则思考默认开启后，会悄悄让「工具调用被打成文本」的空轮兜底（`shouldRecoverEmptyToolCallTurn`）失效。

### 6.3 持久化

- 布局保存在 `.chill-vibe/state.json`
- 工作区配置、卡片顺序、消息历史一并保存

### 6.4 关闭工作区

- 关闭工作区列必须先进入应用内二级确认，不能一次点击就移除。
- 确认文案需要说明：关闭只会从看板移除该工作区列，不会删除磁盘上的项目文件。
- 有内容的会话在列移除前会保存到该工作区的历史会话里，之后可从“历史会话”恢复；空白草稿不会生成历史记录。
- 如果关闭时仍有运行中的任务，先停止任务并清掉该列未发送的排队消息，再移除工作区列。

## 7. 已落地实现

- 看板式主界面
