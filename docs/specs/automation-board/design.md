# 自动化看板 — Design

## 核心洞察：看板项就是一张普通 ChatCard，只是没进 pane.tabs

本仓库的数据模型已经天然支持这件事，不需要为看板另造一套会话运行时：

- `BoardColumn.cards` 是 `Record<cardId, ChatCard>` —— 卡片的**唯一注册表**。
- `BoardColumn.layout` 是 pane 树，pane 只持有 `tabs: string[]`，即**卡片 id 的引用**。

也就是说，"这张卡是不是一个 tab"完全由 layout 里有没有它的 id 决定，与卡片本身无关。已实证的三条支撑：

| 事实 | 位置 | 意义 |
|---|---|---|
| `normalizePaneNode` 只剔除"tabs 里指向不存在卡片"的项，**从不因为卡片不在 tabs 里而删卡片** | `shared/default-state.ts:985` | 离层卡片能安全持久化 |
| `getOrderedColumnCards` 只被 `tests/playwright-state.ts` 使用 | 全仓搜索 | 它那句"把不在 layout 里的卡片也算进 tab 序"不会污染真实 UI |
| `attachStreamsForState` 遍历 `getOrderedColumnCards(column)` 重连流 | `src/App.tsx:4468` | **重启后看板项的流自动重连**，一行不用改 |

于是"拖出成 tab / 拖入成看板项"退化为**只改 `pane.tabs` 数组与看板的 lane 列表**，卡片对象一个字节都不动 —— 会话、`sessionId`、`streamId`、正在飞的流、消息全部原样保留。这就是 FR4 要求的"无缝"，不是靠迁移实现的，是靠不迁移实现的。

> 已知边界（必须防）：`server/state-store.ts:1606-1609` 在"归一化后 layout 是空 pane 但 cards 非空"时会强行 `createPane(Object.keys(cards))`，把**所有**卡片塞进一个 pane。看板项会因此在极端情况下泄漏成 tab。设计上要求：看板卡片自身永远在 layout 里，因此该分支不可达；但仍在 `normalizePersistedColumn` 处补一道"排除被任一看板 items 引用的 cardId"的过滤，作为兜底。

## 数据模型

### 卡片类型标识

`shared/models.ts` 新增，与现有 9 个工具卡完全同构：

```ts
export const AUTOMATIONBOARD_TOOL_MODEL = '__automationboard_tool__'
```

加入 `MODEL_OPTIONS`（label `Automation`, provider `codex`, aliases `board/kanban/automation/自动化`）与 `MODEL_PICKER_HIDDEN_TOOL_MODELS`。

### 看板卡片自身携带的 blob（`shared/schema.ts`）

```ts
export const automationBoardLanes = ['standby', 'running', 'done'] as const
export const automationBoardLaneSchema = z.enum(automationBoardLanes)

export const automationBoardItemSchema = z.object({
  cardId: z.string().min(1),
  lane: automationBoardLaneSchema,
  // 原始需求原文。冗余存一份是刻意的：监工要"检查每个原始需求"，
  // 而 card.messages[0] 会被 /compact、消息裁剪、sidecar 归档拿走。
  requirement: z.string().default(''),
  createdAt: z.string().datetime().optional(),
  // 进入 running 道的时刻，供监工判断"超过半小时没下文"。
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
})

export const automationBoardSchema = z.object({
  // 泳道内顺序 = 本数组内的相对顺序（按 lane 过滤后保序）。
  items: z.array(automationBoardItemSchema).default([]),
})
```

> **v2（2026-08-11）**：`supervisorCardId` / `supervisorExpanded` 已删除，`automationBoardItemSchema`
> 增加 `templateId: z.string().default('')`。监工不再是看板 blob 里的一个特殊指针，
> 而是"某个开了超管权限的模板实例化出来的普通项"。详见下文 **v2 一致化**。

`chatCardSchema` 增加 `automationBoard: automationBoardSchema.optional()`（optional 而非 default：绝大多数卡片不是看板，避免给每张卡都加一个空对象膨胀存档）。

### 按工作区持久化的模板与自动触发（`AppState` 级）

模板与自动触发配置的生命周期必须**长于看板卡片**（FR6/FR7 明确要求删掉 tab 不丢）。因此放 `AppState`，键为 `workspacePath`，与既有 `stickyNoteArchive: z.record(z.string(), …)` 同构：

```ts
export const automationBoardTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  requirement: z.string().default(''),
  provider: providerSchema.default('codex'),
  model: z.string().default(''),
  reasoningEffort: z.string().default('max'),
  thinkingEnabled: z.boolean().default(true),
  planMode: z.boolean().default(false),
  wakeTimerActive: z.boolean().default(false),
  wakeTimerMode: wakeTimerModeSchema.optional(),
  wakeTimerDurationMinutes: z.number().finite().optional(),
  repeatLoopActive: z.boolean().default(false),
  repeatLoopRemaining: z.number().int().min(0).optional(),
  createdAt: z.string().datetime().optional(),
})

export const automationBoardTriggerKinds = ['last-item-settled'] as const
export const automationBoardTriggerKindSchema = z.enum(automationBoardTriggerKinds)

export const automationBoardAutoTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  kind: automationBoardTriggerKindSchema.default('last-item-settled'),
  provider: providerSchema.default('claude'),
  model: z.string().default(''),
  reasoningEffort: z.string().default('max'),
  requirement: z.string().default(defaultAutomationBoardSupervisorRequirement),
  // 两次触发之间的最小间隔，防抖。
  minIntervalMinutes: z.number().finite().min(0).max(24 * 60).default(1),
})

export const automationBoardWorkspaceStateSchema = z.object({
  templates: z.array(automationBoardTemplateSchema).default([]),
  autoTrigger: automationBoardAutoTriggerSchema.default({ /* … */ }),
})
```

`appStateSchema` 增加 `automationBoards: z.record(z.string(), automationBoardWorkspaceStateSchema).default({})`。

默认监工需求文本常量放 `shared/schema.ts`（server 与 client 共用）：

```ts
export const defaultAutomationBoardSupervisorRequirement =
  '检查当前看板每个原始需求，以及 agent 结尾交付情况，自行决定是否进行鞭策还是将其移动到已完成列。' +
  '如果是 agent 正在等子任务，就过段时间再看看情况，如果他超过半小时没下文，就训斥一下他让他接着做。'
```

### 归一化（pitfall 5 / 6 必答项）

| 位置 | 要做的事 |
|---|---|
| `shared/default-state.ts` `createDefaultState` | `automationBoards: {}` |
| `shared/default-state.ts` `createCard` | **不**默认写 `automationBoard`（保持 undefined） |
| 新增 `createAutomationBoardCard(...)` | 建看板卡：`model = AUTOMATIONBOARD_TOOL_MODEL`，`automationBoard = { items: [], supervisorCardId: '', supervisorExpanded: false }` |
| 新增 `createDefaultAutomationBoardWorkspaceState()` | 模板空数组 + 默认 autoTrigger |
| `server/state-store.ts` `normalizePersistedCard` | 保留/修补 `automationBoard`；剔除 items 里 `cardId` 已不在 `column.cards` 的孤儿项 |
| `server/state-store.ts` `normalizePersistedColumn` | 计算本列所有看板引用的 cardId 集合，传给 layout 兜底分支排除（见上文边界） |
| `server/state-store.ts` state 顶层归一化 | `automationBoards` 缺失→`{}`；每个 entry 走 schema 的 default |

## 状态迁移的唯一决策出口（纯函数）

pitfall 246 的教训：停流与队列处置必须成对且集中；pitfall 248 的教训：编排必须是可断言返回值的纯函数，不是源码文本。因此所有"搬运一张卡"的副作用由**一个**纯函数决定，新文件 `src/components/automation-board-transitions.ts`：

```ts
export type AutomationBoardLocation =
  | { kind: 'lane'; lane: AutomationBoardLane }
  | { kind: 'tab' }

export type AutomationBoardTransitionEffects = {
  /** 请求中断当前运行（等价用户点停止）。 */
  interrupt: boolean
  /** 中断后如何处置排队消息。 */
  queue: 'keep' | 'clear'
  /** 搬运后要不要发起一次发送，以及发什么。 */
  send: 'none' | 'requirement' | 'continue'
  /** 是否记录 startedAt / completedAt。 */
  stamp: 'none' | 'started' | 'completed'
}

export const resolveAutomationBoardTransition = ({
  from,
  to,
  isStreaming,
  hasHistory,
}: {
  from: AutomationBoardLocation
  to: AutomationBoardLocation
  isStreaming: boolean
  hasHistory: boolean
}): AutomationBoardTransitionEffects => { … }
```

判定表（这就是被测的契约）：

| from | to | interrupt | queue | send | stamp |
|---|---|---|---|---|---|
| 任意 | `tab` | false | keep | none | none |
| `tab` / 其他道 | `standby` | `isStreaming` | keep | none | none |
| `tab` / 其他道 | `running` | false | keep | `isStreaming ? 'none' : hasHistory ? 'continue' : 'requirement'` | started |
| `tab` / 其他道 | `done` | `isStreaming` | keep | none | completed |
| `lane X` | `lane X`（重排） | false | keep | none | none |

要点：

- **出到 tab 永远是零副作用** —— 这正是"无缝"的定义。
- 已在跑的卡拖进 `running` 不重发（幂等），只是换个位置。
- `queue` 恒为 `keep`：看板搬运不跨工作区，排队消息的语境仍然有效（对比 `moveTab` 跨列时必须 `clear`）。留这个字段是为了让"以后真要清"时有唯一落点，而不是散在调用点。

## Reducer 变更（`src/state.ts`）

所有搬运遵循 pitfall 237 的范式：**前置一次性校验两端，任一端失效就原样返回**；同列跨容器"先插入目标、再摘除源、最后统一 `normalizeLayoutNode`"。

新增 `IdeAction` 变体：

```
createAutomationBoardItem   { columnId, boardCardId, lane, requirement, provider, model, reasoningEffort, thinkingEnabled, planMode, wake/repeat?, cardId? }
setAutomationBoardItemLane  { columnId, boardCardId, cardId, lane, index }
removeAutomationBoardItem   { columnId, boardCardId, cardId, deleteCard }
stampAutomationBoardItem    { columnId, boardCardId, cardId, patch: { startedAt?, completedAt? } }
moveAutomationBoardItemToPane { columnId, boardCardId, cardId, paneId, index? }
moveTabToAutomationBoard      { columnId, paneId, tabId, boardCardId, lane, index? }
ensureAutomationBoardSupervisor { columnId, boardCardId, provider, model, reasoningEffort }
saveAutomationBoardTemplate     { workspacePath, template }
removeAutomationBoardTemplate   { workspacePath, templateId }
renameAutomationBoardTemplate   { workspacePath, templateId, name }
updateAutomationBoardAutoTrigger { workspacePath, patch }
```

`moveAutomationBoardItemToPane` 与 `moveTabToAutomationBoard` 是两个**原子**动作：

- 前者：校验 `board.items` 含该 cardId **且** 目标 paneId 在本列 layout 中存在；然后一次 `updateColumn` 内同时写 `cards[boardCardId].automationBoard.items`（移除项）与 `layout`（插入 tab）。
- 后者：校验源 pane 含该 tabId **且** 目标看板卡片存在且是看板类型；然后一次 `updateColumn` 内同时写 layout（摘除 tab，随后 `normalizeLayoutNode` 统一折叠）与 items（追加项，`requirement` 取卡片首条 user 消息或 draft）。

两者都**不产生 `sessionHistory` 归档**（对比 `closeTab`）—— 卡片没有被关闭，只是换了展现容器。

## 运行编排（`src/App.tsx`）

新增一个薄编排层，所有实际动作都走既有 handler，不另开捷径：

```ts
const applyAutomationBoardTransition = async (
  columnId: string,
  boardCardId: string,
  cardId: string,
  from: AutomationBoardLocation,
  to: AutomationBoardLocation,
  laneIndex?: number,
) => {
  const card = getColumn(columnId)?.cards[cardId]
  const effects = resolveAutomationBoardTransition({
    from, to,
    isStreaming: card?.status === 'streaming',
    hasHistory: hasAutomationBoardHistory(card),
  })
  // 1) 结构先落地（原子 reducer 动作）
  // 2) effects.interrupt → requestStopForCard(cardId, 'automation-board')
  // 3) effects.send === 'requirement' → sendMessageRef.current?.(columnId, cardId, requirement, [])
  //    effects.send === 'continue'    → sendMessageRef.current?.(columnId, cardId, '', [])
  // 4) effects.stamp → stampAutomationBoardItem
}
```

`send` 走 `sendMessageRef.current`（`src/App.tsx:5484` 赋值），与手机监工写命令、唤醒发车、循环重复用的是**同一个入口**。空续传由既有 `canSendEmptyContinuation` 门控（`src/app-helpers.ts`），已被 pitfall 169 钉住三道门都放行。

### 看板 tab 的橙色运行态（FR8）

纯派生，不写 `status`：

```ts
// src/components/automation-board-state.ts
export const automationBoardHasActiveRun = (
  board: AutomationBoard | undefined,
  cards: Record<string, ChatCard>,
) => …  // 任一 running 道项或监工卡 status === 'streaming' 或 backgroundWorkPending
```

`PaneView` 的 `const isStreaming = card.status === 'streaming'`（`src/components/PaneView.tsx:1149`）改为
`card.status === 'streaming' || automationBoardHasActiveRun(card.automationBoard, column.cards)`。

这样 `is-streaming` class 复用现有橙色样式，且完全避开 pitfall 113（磁盘上不会留假 streaming 卡）。

### 自动触发判定（纯函数）

```ts
// src/components/automation-board-auto-trigger.ts
export const resolveAutomationBoardAutoTriggerDecision = ({
  config, settledCardId, board, cardStatuses, lastFiredAtMs, nowMs,
}): { fire: boolean; reason: 'disabled' | 'not-board-item' | 'still-running'
      | 'supervisor-busy' | 'throttled' | 'ready' } => …
```

规则：

1. `config.enabled === false` → `disabled`
2. `settledCardId` 不是本看板 `running` 道的项 → `not-board-item`（**监工自己结束不算**，因为监工不在 items 里）
3. 还有别的 running 道项在跑或 `backgroundWorkPending` → `still-running`
4. 监工卡 `status === 'streaming'` → `supervisor-busy`（防递归）
5. `nowMs - lastFiredAtMs < minIntervalMinutes * 60_000` → `throttled`
6. 否则 `ready`

挂载点：复用既有"卡片稳定完成"广播（wake timer 已用的同一处，`src/App.tsx:2898` 附近的 `wakeTimerCompletionTimersRef` 稳定窗口）。这样"AI 真的结束了"这个判断与唤醒链共用同一个已经调好的判据（`shouldConfirmWakeTimerCompletion`，含 `backgroundWorkPending`），不重造。

触发动作：`ensureAutomationBoardSupervisor` → 若监工卡不存在则建（provider/model 取 config），然后 `sendMessageRef.current?.(columnId, supervisorCardId, config.requirement, [])`。`lastFiredAt` 存进程内 ref（不入盘：重启后允许再触发一次是可接受且更安全的行为）。

## 计划唤醒 / 循环重复（FR5）

**零逻辑改动。** `wake-timer.ts` 的 `armWakeTimerBatch` 已经接受一个抽象的有序 id 列表参数 `paneTabIds` 并用 `indexOf(ownerCardId) - 1` 取"左邻"。看板语境只是换传参：

- 普通 tab：`paneTabIds = pane.tabs`
- 看板项：`paneTabIds = 该项所在泳道的有序 cardId 列表`

于是"左侧 tab" 自动变成"上方需求"，判定函数一个字符不改。变的只有两处**表现**：

1. i18n 文案：新增 `wakeTimerModeAboveItemLabel`（"上方需求"）等，看板语境下渲染这一套而不是"左侧 tab"那一套。
2. CSS：普通卡把唤醒状态条放在 composer 左侧（`.composer-wake-timer-status`，`src/components/ChatCard.tsx:949`）；看板项卡用 `.automation-board-item-wake`，`flex-direction: column` 放在项卡片顶部。

`repeatLoopActive` / `repeatLoopRemaining` 同理为零改动 —— `resolveRepeatLoopCompletion` 只看卡片字段，且它的 `MODEL_PICKER_HIDDEN_TOOL_MODELS.has(card.model)` 守卫对看板**项**卡片（真实模型）放行、对看板**容器**卡片（工具模型）拦住，语义刚好正确。

## 拖放（FR4）

`src/dnd.ts` 的 `DragPayload` 联合新增两个成员，并在 `readDragPayload` 加对应的运行时校验分支（与现有三个成员同构）：

```ts
| { type: 'automation-board-item'; columnId: string; boardCardId: string; cardId: string; lane: AutomationBoardLane }
| { type: 'automation-board-template'; workspacePath: string; templateId: string }
```

落点矩阵（沿用既有 `is-drop-*` 提示类与 `scheduleDragHintExpiry` 看门狗，watchdog 超时**只清视觉提示**，payload 交给 `releaseDragPayloadIfStale` —— pitfall 196）：

| 目标元素 | 接受的 payload | 动作 |
|---|---|---|
| `.pane-tab-bar` / `.pane-tab` | 追加 `automation-board-item`（同列） | `moveAutomationBoardItemToPane` |
| `.pane-content`（边缘） | 追加 `automation-board-item`（同列） | 先 split 再 `moveAutomationBoardItemToPane` |
| `.automation-board-lane` | `tab`（同列）/ `automation-board-item` / `automation-board-template` | 按 `resolveAutomationBoardTransition` |

跨列一律拒绝（不 `preventDefault`，因此不出落点提示也不能 drop），理由见 requirements FR4。

拖拽源：项卡片头部整体 `draggable`。**禁止**在其 mousedown 上 `preventDefault`（pitfall 176/454：那会让 `dragstart` 永不触发）；需要防抢焦点时走显式焦点转移。

## 紧凑渲染（FR3 / NFR1）

新文件 `src/components/AutomationBoardCard.tsx` + `src/components/automation-board-item-window.ts`。

- 每个项卡片只渲染 `renderableMessages` 的**末 N 条**（默认 6）。裁剪发生在 `buildRenderableMessages` 之后、markdown 渲染之前，因此不会对全量 messages 跑解析。
- 复用现有渲染件：`MessageBubble`（`src/components/MessageBubble.tsx`）与 `chat-card-rendering.tsx` 的 markdown 链（含 `closeUnclosedMarkdownSpans`、`stripLeakedClaudeToolXml`、本地图片链 —— pitfall 138/139/177/178 全部随之生效，不能绕过自己写渲染)。
- 状态指示只用**静态边框**。任何呼吸动画若要加，必须限定在 `.pane-tab-panel.is-active:not([hidden])` 前缀下并登记进 `tests/idle-animation-budget.test.ts` 的 allowlist（pitfall 218）。v1 直接不加动画。

DOM 骨架：

```
.automation-board                      (card body, flex column)
  .automation-board-lanes              (flex row, 3 列, 各自可纵向滚动)
    .automation-board-lane[data-lane]
      .automation-board-lane-head      (标题 + 计数)
      .automation-board-lane-body      (drop target)
        .automation-board-item         (状态边框在这里, 复用 chat card 三态 token)
      .automation-board-lane-compose   (仅 standby 道: 输入新需求)
  .automation-board-supervisor         (可折叠的监工紧凑聊天 + 配置入口)
  .automation-board-templates          (底部模板条, 每项 draggable)
```

## 看板 MCP（FR7）

### 为什么不能照抄 archive-recall

`server/archive-recall.ts` 把快照**写成一个静态 JSON 文件**，路径经 env 传给 MCP 子进程（`server/archive-recall-mcp.js:303` `loadSnapshotFromEnv`）。监工需要的是**实时读 + 写回**，静态文件两头都不满足。

### 采用的桥接：loopback HTTP + 命令转发

完全照 `server/remote-monitor.ts` 已验证的形状：一个只绑 `127.0.0.1` 的 `http.Server`（端口 0 随机 + bearer token），**自身不改任何 state**，写操作一律 `dispatchCommand` 转发给渲染进程复用电脑端 handler（remote-monitor 文件头注释里明确定下的规矩）。

新文件：

| 文件 | 职责 |
|---|---|
| `server/automation-board-bridge.ts` | loopback HTTP 服务 + deps 接口；`createAutomationBoardBridge(deps)` → `{ start(), stop(), status() }`（照 `createRemoteMonitorManager` 的形状，不是一次性的 start 函数） |
| `server/automation-board-mcp.js` | stdio JSON-RPC MCP 服务器（协议帧照抄 `archive-recall-mcp.js` 的 `Content-Length` 实现），所有工具经 `fetch` 打到 bridge |
| `server/automation-board-runtime.ts` | 为监工回合生成 provider runtime overrides 的**纯函数**（codex `-c mcp_servers.*` / claude `--mcp-config`）+ 系统提示补充；`execPath` / `isElectron` 由调用方传入，函数内不读 `process` |
| `server/automation-board-session.ts` | 进程内状态：镜像表 + 懒启动的 bridge + 命令 dispatcher 登记；`createAutomationBoardSupervisorRuntime(request)` 是 providers.ts 唯一的入口 |

鉴权细节（实现时确定）：token 只走 `Authorization: Bearer`，查询串里带 token 会被拒；socket 对端与 `Host` 头都必须是 loopback，否则 403（在校验 token 之前）。

`AutomationBoardBridgeDeps`：

```ts
export type AutomationBoardBridgeDeps = {
  /** 实时看板镜像（由渲染进程推送，见下）。 */
  readBoardMirror: (boardCardId: string) => AutomationBoardMirror | null
  /** 单个项的最近转录，走 transfer 压缩后返回有界条数。 */
  readItemTranscript: (cardId: string, limit: number) => Promise<AutomationBoardTranscriptEntry[] | null>
  /** 转发写命令给渲染进程；false = 当前没有可接收的窗口（HTTP 503）。 */
  dispatchCommand: (command: AutomationBoardCommand) => boolean
}
```

### 实时镜像：渲染进程推，主进程存

`loadStateForRenderer()` 读盘的快照在流式期间会被节流（pitfall 54/114），对监工来说太旧。因此渲染进程主动推一份**极小、有界**的镜像到主进程：

```ts
export type AutomationBoardMirrorItem = {
  cardId: string
  lane: AutomationBoardLane
  requirement: string        // 截断至 2000 字符
  title: string
  provider: string
  model: string
  status: string
  backgroundWorkPending: boolean
  wakeTimerActive: boolean
  wakeTimerWakeAt?: string
  repeatLoopActive: boolean
  startedAt?: string
  completedAt?: string
  lastActivityAt?: string    // 最后一条消息的 createdAt —— "超过半小时没下文"的判据
  lastMessagePreview: string // 截断至 400 字符
  messageCount: number
}
```

推送时机：定时轮询 + **签名闸门**（`getAutomationBoardMirrorSignature`），间隔 2000ms。签名只覆盖 lane / status / backgroundWorkPending / messageCount / lastActivityAt —— 单条消息的流式增长**不**刷新签名，否则每个 delta 都会跨一次 IPC，节流等于白做。

镜像还随身带每项最近 12 条转录（`recentEntries`），这样 `read_board_item` 不需要另开一条请求/应答通道。载荷预算在两处执行：`buildAutomationBoardMirror`（渲染端）与 `publishAutomationBoardMirror`（server session）各跑一遍同一套上限（requirement 2000 / preview 400 / 单条 600 / 条数 12），任何绕过前者的调用方也无法把整段转录送给模型（pitfall 183）。

### MCP 工具集

只暴露看板域，不给任意文件/命令权限（NFR5）：

| 工具 | 读/写 | 说明 |
|---|---|---|
| `list_board_items` | 读 | 全部项：lane、原始需求、状态、`startedAt`、`lastActivityAt`、最后消息预览 |
| `read_board_item` | 读 | 单项最近 N 条转录（默认 20，上限 60），经 transfer 压缩 |
| `move_board_item` | 写 | `{ cardId, lane }` → `setAutomationBoardItemLane`（走 App 编排，因此中断/执行语义自动正确） |
| `send_board_item_message` | 写 | `{ cardId, message }` → `sendMessage`（这就是"鞭策"） |
| `set_board_item_wake_timer` | 写 | `{ cardId, mode, durationMinutes }` → 复用卡片唤醒 handler（"过段时间再看看情况"） |

写工具返回的是"命令已投递"，不是"已生效"——与 remote-monitor 同语义。监工要确认结果就再 `list_board_items` 一次。

### 接入 provider 启动

- **Codex**：照 `server/archive-recall.ts:69-88`，`-c mcp_servers.chill_vibe_board.command=…` + `.args=…` + `.env.*=…`（env 里带 `CHILL_VIBE_BOARD_MCP_URL` / `_TOKEN` / `_BOARD_ID`；Electron 下同样要带 `ELECTRON_RUN_AS_NODE=1`）。
- **Claude**：`buildClaudeArgs`（`server/providers.ts:3880`）追加 `--mcp-config <json>` + `--strict-mcp-config`。`permissionMode` 已是 `bypassPermissions`，MCP 工具无需额外 allowlist。
- 仅当 `request` 标记为"这是看板监工回合"时注入。新增请求字段 `automationBoardSupervisor?: { boardCardId: string; columnId: string }`（`chatRequestSchema`，两个字段都必填），由渲染端在监工发送时带上。
- Claude 侧同时发 `--strict-mcp-config`：本次启动只认这里给的 server，不继承用户 `~/.claude` 里配置的其它 MCP。
- 桥接准备失败时降级为"没有工具的普通回合"，绝不因此让整个回合失败。
- 系统提示追加一段说明（照 `getCodexArchiveRecallInstruction` 的形状），告诉模型这些工具存在、以及"鞭策"的含义。

## 测试策略

按 AGENTS.md Tier 1 与 pitfall 248：**测纯函数与 reducer 的真实返回值，不测源码文本**。

| 新测试文件 | 覆盖 |
|---|---|
| `tests/automation-board-transitions.test.ts` | 上面那张判定表逐格；重点钉死"出到 tab 零副作用"与"已在跑拖进 running 不重发" |
| `tests/automation-board-state.test.ts` | reducer：原子搬运（两端任一失效则整体不变）、lane 重排保序、孤儿项剔除、`automationBoardHasActiveRun` 派生 |
| `tests/automation-board-auto-trigger.test.ts` | 六条判定规则，特别是"监工自己结束不触发"与防递归 |
| `tests/automation-board-mcp.test.ts` | MCP 工具的纯逻辑（参数校验、快照→文本渲染、写工具生成的 command 形状） |

全部注册进 `tests/index.test.ts`（pitfall 3）。

Playwright 在本机当前不可靠（pitfall 25/34/252），因此 UI 验证走真实 Electron 手动驱动 + Node 单测覆盖判定逻辑；`tests/theme-check.spec.ts` 的快照在 Playwright 恢复后补。

---

# v2 一致化：监工模板化 + 超管权限（2026-08-11）

v1 里"监工"是一个横切所有层的特殊实体：schema 里一个 `supervisorCardId` 指针、reducer 里一个
`ensureAutomationBoardSupervisor`、App 里一个 `runAutomationBoardSupervisor`、UI 里一整个
`.automation-board-supervisor` 区、请求上一个 `automationBoardSupervisor` 标记、MCP 镜像里两个
`supervisor*` 字段。而"模板"是另一套完全平行的概念，两者做的事高度重合（都是"用一段预设需求文本
+ 预设模型起一个 agent 回合"）。

v2 把两套合成一套，代价是一次性的重构，收益是**监工不再有任何专属代码路径**。

## 三条替换

| v1 | v2 |
|---|---|
| `board.supervisorCardId` 指向的特殊卡片 | 一个 `builtIn: true` 的模板 + 它实例化出来的普通看板项 |
| `automationBoardWorkspaceState.autoTrigger`（工作区唯一一套） | `template.trigger`（每个模板各自一套） |
| 请求标记 `automationBoardSupervisor: { boardCardId, columnId }` | 卡片字段 `card.adminAccess: boolean` → 请求标记 `adminAccess: { columnId }` |

## 数据模型（v2）

```ts
// 看板项：记住自己是哪个模板生出来的，这是防自触发的唯一依据。
automationBoardItemSchema.templateId: z.string().default('')

// 模板：多了权限、触发器、实例指针，以及内置标记。
automationBoardTemplateTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  kind: automationBoardTriggerKindSchema.default('last-item-settled'),
  // 触发时实例落到哪条道。默认 running = 立即执行。
  lane: automationBoardLaneSchema.default('running'),
  minIntervalMinutes: z.number().finite().min(0).max(24 * 60).default(1),
})

automationBoardTemplateSchema = z.object({
  …v1 全部字段,
  adminAccess: z.boolean().default(false),
  builtIn: z.boolean().default(false),
  trigger: automationBoardTemplateTriggerSchema.default(…),
  // 上一次由本模板触发生成、仍活着的实例卡。空串 = 下次触发要新建。
  instanceCardId: z.string().default(''),
})

// 工作区级容器：autoTrigger 整个删掉。
automationBoardWorkspaceStateSchema = z.object({
  templates: z.array(automationBoardTemplateSchema).default([]),
})

// 卡片级权限。optional 而非 default：绝大多数卡片没有它，
// 不给每张卡在 state.json 里加一个 false。
chatCardSchema.adminAccess: z.boolean().optional()
```

`createDefaultAutomationBoardWorkspaceState()` 返回的 `templates` 里**默认带一个**内置监工模板
（`createDefaultAutomationBoardSupervisorTemplate()`）：`builtIn: true`、`adminAccess: true`、
`provider: 'claude'`、`requirement: defaultAutomationBoardSupervisorRequirement`、
`trigger.enabled: false`（用户自己去开）。

归一化（pitfall 5/6）：

| 位置 | 要做的事 |
|---|---|
| `normalizePersistedCard` | 剔除 `automationBoard.items` 里 `cardId` 已不在 `column.cards` 的孤儿项（不变）；不再修补 `supervisorCardId` |
| state 顶层 | 旧存档的 `automationBoards[ws].autoTrigger` 若存在且 `enabled`，**迁移**成内置监工模板的 `trigger`（保 requirement / provider / model / minIntervalMinutes），然后丢弃该字段 |
| `automationBoards[ws].templates` 为空 | 补种内置监工模板；已有 `builtIn: true` 的就不重复种 |

## 触发判定（纯函数，取代 `resolveAutomationBoardAutoTriggerDecision`）

`src/components/automation-board-auto-trigger.ts`：

```ts
export type AutomationBoardTriggerReason =
  | 'disabled' | 'not-board-item' | 'self-triggered'
  | 'still-running' | 'throttled' | 'ready'

export const resolveAutomationBoardTemplateTriggerDecisions = ({
  templates, board, settledCardId, cardActivity, lastFiredAtMs, nowMs,
}: {
  templates: readonly AutomationBoardTemplate[]
  board: AutomationBoard | undefined
  settledCardId: string
  cardActivity: Record<string, AutomationBoardCardActivity>
  lastFiredAtMs: Record<string, number>   // templateId → ms
  nowMs: number
}): Array<{ templateId: string; fire: boolean; reason: AutomationBoardTriggerReason }>
```

逐模板判定，规则顺序即 requirements FR7 的五条。两处与 v1 的关键差异：

- v1 靠"监工不在 items 里"防自触发（规则 `not-board-item`）。v2 监工实例**就在** items 里，
  所以改用 `settledItem.templateId === template.id` → `self-triggered`。**这是本次重构最容易
  写错的一处**：漏了它，监工每答完一轮就把自己再叫起来，无限自触发。
- v1 的 `supervisor-busy` 被 `still-running` 吸收：监工实例是 running 道的普通项，它在跑时
  规则 4 天然拦住。

## 触发动作 = 复用"拖模板进泳道"

`src/App.tsx`：

```ts
const fireAutomationBoardTemplateTrigger = (columnId, boardCardId, templateId) => {
  const template = …
  const reuse = template.instanceCardId &&
    board.items.some((item) => item.cardId === template.instanceCardId)

  if (reuse) {
    // 已有实例：确保它在目标道（走既有 applyAutomationBoardTransition，
    // 于是"移进 running 要不要发送"的语义完全复用），再发一次需求文本。
    applyAutomationBoardTransition(…, { kind: 'lane', lane: template.trigger.lane })
    void sendMessageRef.current?.(columnId, template.instanceCardId, template.requirement, [])
  } else {
    // 没有实例：与用户手动把模板拖进泳道**同一个 handler**。
    const cardId = instantiateTemplate(columnId, boardCardId, templateId, template.trigger.lane)
    applyAction({ type: 'setAutomationBoardTemplateInstance', workspacePath, templateId, cardId })
  }
}
```

`instantiateTemplate` 建卡时把 `adminAccess: template.adminAccess` 写进卡片，把
`templateId: template.id` 写进看板项 —— 这两个字段就是 v2 的全部"监工性"。

## 超管权限的接线

1. **卡片字段** `card.adminAccess`。UI 开关在 composer 设置菜单（`src/components/ChatCard.tsx`
   的 `.composer-settings-menu`），与 planMode 同级；开启时卡片头部出现盾牌角标。
2. **发送时** `src/App.tsx` 的 `buildChatRequest` 分支：`card.adminAccess === true` 时带
   `adminAccess: { columnId }`。**不是**由调用方决定 —— 调用方决定就会漏（唤醒发车、循环重复、
   队列 dispatch、MCP 转发都是发送入口）。判定放在唯一必经的请求构建处。
3. **服务端** `server/providers.ts` 把 `request.automationBoardSupervisor` 的判定换成
   `request.adminAccess`；`createAutomationBoardSupervisorRuntime` 改名
   `createWorkspaceAdminRuntime`，按 `columnId` 而非 `boardCardId` 取镜像。

## MCP 作用域：从"看板"扩到"工作区列"

requirements FR10 要求"操作其他会话"，不限于看板项。因此镜像的键从 `boardCardId` 换成
`columnId`，内容从"看板的项"换成"这一列的全部会话卡"：

```ts
export type WorkspaceSessionMirrorItem = {
  cardId: string
  title: string
  provider: string
  model: string
  status: string
  backgroundWorkPending: boolean
  // 这张卡在看板里的位置。不在任何看板里就是 undefined（普通 tab）。
  board?: { boardCardId: string; lane: AutomationBoardLane; requirement: string
            startedAt?: string; completedAt?: string }
  // 在 pane.tabs 里就是 true。看板项与 tab 不互斥地看：一张卡只可能是其中之一。
  isTab: boolean
  wakeTimerActive: boolean
  wakeTimerWakeAt?: string
  repeatLoopActive: boolean
  lastActivityAt?: string
  lastMessagePreview: string
  messageCount: number
  recentEntries: […]
}
```

排除项：工具卡（`MODEL_PICKER_HIDDEN_TOOL_MODELS`，包括看板容器卡自己）不进镜像 ——
模型对它们没有可操作语义。**请求方自己也不进镜像**由 MCP 侧按 env 里的 `SELF_CARD_ID` 过滤，
避免监工把自己列出来又给自己发消息。

镜像签名 `getWorkspaceSessionMirrorSignature` 仍然刻意**排除**单条消息正文增长
（pitfall 258），只覆盖 cardId / lane / status / backgroundWorkPending / messageCount /
lastActivityAt。推送节流仍是 2000ms。

### 工具集（v2 命名）

| 工具 | 读/写 | 说明 |
|---|---|---|
| `list_sessions` | 读 | 本工作区全部会话：标题、provider/model、状态、看板归属与泳道、静默分钟数、最后消息预览 |
| `read_session` | 读 | 单个会话最近 N 条转录（默认 20，上限 60） |
| `send_session_message` | 写 | `{ cardId, message }` → `sendMessage`（"鞭策"） |
| `move_session_to_lane` | 写 | `{ cardId, lane }` → 移进看板某道。目标看板：该卡已在某看板则用那个，否则用本列第一张看板卡；本列没有看板则报错 |
| `set_session_wake_timer` | 写 | `{ cardId, mode, durationMinutes }` |

命令 schema `automationBoardCommandSchema` 的成员随之改名并把 `boardCardId` 改成可选
（`move-session-to-lane` 由 App 侧解析目标看板）。

### 系统提示

`getAutomationBoardSupervisorInstruction` → `getWorkspaceAdminInstruction(language)`。措辞从
"你是看板监工"改成"你被授予了这个工作区的超管权限"，因为开这个开关的可能是任何会话，不一定
是监工。监工的"该怎么当监工"那部分语义留在**模板的需求文本**里 —— 那才是它该待的地方。

## UI 变更

- 删除整个 `.automation-board-supervisor` 区块与它的 i18n / CSS。
- 模板条的每个模板加一个展开箭头，展开出 `.automation-board-template-config`：名称、需求文本、
  provider/model、超管权限开关、触发器（开关 / 泳道 / 最小间隔）、"恢复默认文案"（仅 `builtIn`）。
- 模板触发器开启时，模板胶囊上显示一个闪电角标，一眼可见"这个模板会自己跑"。
- `ChatCard` composer 设置菜单加一行"超管权限"，开启时该行高亮为警示色（`--danger-*` 系列 token），
  并在卡片头部渲染盾牌角标。双主题都要过。

## 布局与宽度适配（v2.1）

看板卡活在**可调宽的列 / 可拆分的 pane**里，它的宽度与视口宽度没有任何关系：三列铺开的 1440
视口下，一列只有 ~460px。v2 的断点写成 `@media (max-width: 900px)`，量的是视口，所以在真实使用
中几乎永不触发 —— 三条泳道被压到每条 ~140px，标题截成两个字、"加入待命"竖成一列。

v2.1 全部改成**容器查询**，并且分两层量：

| 容器 | `container-name` | 量什么 | 用来决定 |
|---|---|---|---|
| `.automation-board` | `automation-board` | 整块看板的 inline-size | 泳道的栅格轨数、模板配置面板是单栏还是双栏 |
| `.automation-board-lane` | `automation-board-lane` | 单条泳道的 inline-size | 待命道 composer 是否折行、项卡片是否让出型号标签 |

分两层是必须的：宽屏三轨时一条泳道 ~460px，窄屏单轨时反而有 ~450px —— 只看看板宽会把两种
完全不同的处境判成同一档。

泳道栅格三档：

| 看板宽 | 布局 |
|---|---|
| ≥ 760px | 三轨并排（默认） |
| 520–759px | 待命 + 执行中并排，已完成 `grid-column: 1 / -1` 铺满下面一行，行高 1.5fr / 1fr |
| < 520px | 三条竖排，`grid-auto-rows: minmax(10.5rem, auto)`，整块看板纵向滚动 |

中间那档刻意**不是**"三轨挤一挤"：一条泳道低于 ~240px 就装不下「标题 + 型号标签 + 状态点」
这一行。竖排档必须把 `grid-template-rows` 显式交回 `none`，否则上一档那条两行的定义会把第三条
泳道挤成 0 高。

> `.automation-board` 自身的 `padding` / `gap` **不能**写进 `@container automation-board`：元素不
> 匹配以自己为容器的查询。它们保持定值，只有后代跟着宽度变。

排版上同时统一了圆角与层级：泳道 / 项卡片 / 模板配置面板 / 输入框全部走 `--r-xs`，型号标签与
模板胶囊走 `--r-pill`，泳道头部换成 `--panel-soft` 色带（滚动时标题不再和内容糊在一起），泳道
计数变成小胶囊。模板胶囊上那三个 icon-button 与项卡片一级操作行同处理 —— 静息只剩图标，框和
底色留给 hover / focus（ui-principles「Idle Chrome Must Recede」）。这些覆盖选择器都必须凑到
三段（0,3,0）才压得过 `:root[data-theme='dark'] .icon-button`。

宽看板（≥ 900px）下模板配置面板改双栏：名称 | 模型 配一行，需求 textarea / 说明文字 / 触发器分组 /
操作行整行跨栏。为此把 JSX 里的"模型"字段提到"需求"之前 —— 两个单行字段相邻，双栏时才不会
出现"名称旁边空着半个面板"，同时 tab 顺序仍与视觉顺序一致。

## 测试策略（v2 增量）

| 文件 | 覆盖 |
|---|---|
| `tests/automation-board-auto-trigger.test.ts` | 改写为模板级：五条规则逐条；**自触发防护**（settled item 的 templateId 命中本模板必须 `self-triggered`）；多模板各自独立节流 |
| `tests/automation-board-state.test.ts` | 模板 CRUD 带 trigger/adminAccess；`setAutomationBoardTemplateInstance`；item.templateId 落地；删掉 supervisor 相关用例 |
| `tests/automation-board-persistence.test.ts` | 旧存档（含 `autoTrigger` + `supervisorCardId`）加载后：autoTrigger 迁移进内置模板的 trigger、supervisor 指针被丢弃、内置模板被补种 |
| `tests/automation-board-mirror.test.ts` | 列级镜像：tab 卡与看板项都在里面、工具卡被排除、签名排除正文增长 |
| `tests/automation-board-mcp.test.ts` | 新工具名与参数校验；`move_session_to_lane` 的目标看板解析；请求方自过滤 |
| `tests/chat-request-admin-access.test.ts`（新） | `card.adminAccess` → 请求带 `adminAccess`；关掉就不带 |
| `tests/automation-board-layout.spec.ts`（v2.1，已入 `pnpm test:theme`） | **固定视口 1440**、只改同时开几列（1/2/3 列 → 看板 ~1409/704/468px）：栅格轨数 3/2/1、窄档每条泳道仍 > 240px、composer 一行、宽档配置面板双栏且跨栏项跨栏、竖排下展开抽屉不出卡；双主题各三档视觉快照 + 配置面板展开态 + 抽屉展开态 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 看板项卡片泄漏成 tab（state-store 空 layout 兜底分支） | `normalizePersistedColumn` 排除被 items 引用的 cardId |
| 拖出后流断 | 结构变更不触碰卡片对象；`resolveAutomationBoardTransition` 对 `to.kind === 'tab'` 恒返回零副作用，并被测试钉死 |
| 10+ 并发项把渲染压死 | 项卡片零无界动画、有界消息条数、状态派生用 memo；复用既有 delta flush 自适应退让（pitfall 189） |
| 监工递归自触发 | 判定规则 2 与 4；`lastFiredAt` 节流 |
| MCP 子进程拿到过宽权限 | 只暴露看板域工具；bridge 只绑 loopback + token；写操作转发给渲染进程 |
| 旧存档加载失败 | 所有新字段 optional/default，`automationBoards` 顶层 default `{}`；normalizePersistedCard 修补而非拒绝 |
