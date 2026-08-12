# 自动化看板 — Tasks

切片原则：每一片都能单独跑测试、单独回滚。结构层先落地并被测试钉住，再往上叠 UI，最后接 MCP。

## Slice 1 — 数据模型与归一化

- [x] `shared/models.ts`：`AUTOMATIONBOARD_TOOL_MODEL`、`MODEL_OPTIONS` 条目、`MODEL_PICKER_HIDDEN_TOOL_MODELS`
- [x] `shared/schema.ts`：lane / item / board / template / autoTrigger / workspaceState schema；`chatCardSchema.automationBoard?`；`appStateSchema.automationBoards`；`defaultAutomationBoardSupervisorRequirement`；`chatRequestSchema.automationBoardSupervisor?`
- [x] `shared/default-state.ts`：`createAutomationBoardCard`、`createDefaultAutomationBoardWorkspaceState`、`createDefaultState` 带 `automationBoards: {}`
- [x] `server/state-store.ts`：`normalizePersistedCard` 修补 `automationBoard` + 剔孤儿项；`normalizePersistedColumn` 空 layout 兜底排除 items 引用的 cardId；顶层 `automationBoards` 归一化
- [x] 测试：旧存档（无新字段）加载不报错且补齐默认值；孤儿项被剔除；看板项不被塞进兜底 pane

## Slice 2 — 迁移决策纯函数（先红后绿）

- [x] `src/components/automation-board-transitions.ts`：`resolveAutomationBoardTransition`
- [x] `src/components/automation-board-state.ts`：`automationBoardHasActiveRun`、`getAutomationBoardLaneItems`、`hasAutomationBoardHistory`、`getAutomationBoardLaneCardIds`（唤醒用的有序 id 列表）
- [x] `tests/automation-board-transitions.test.ts`：判定表逐格 + 两条重点断言
- [x] 注册进 `tests/index.test.ts`

## Slice 3 — Reducer

- [x] `src/state.ts` 新增 11 个 `IdeAction` 变体与实现
- [x] 原子搬运：`moveAutomationBoardItemToPane` / `moveTabToAutomationBoard` 前置校验两端
- [x] `tests/automation-board-state.test.ts`：原子性（两端任一失效整体不变）、lane 重排保序、派生函数
- [x] 注册进 `tests/index.test.ts`

## Slice 4 — 看板 UI

- [x] `src/components/AutomationBoardCard.tsx`：三泳道 + 项卡片 + 待命道输入 + 模板条 + 监工区
- [x] `src/components/automation-board-item-window.ts`：末 N 条裁剪
- [x] `src/components/ChatCard.tsx`：`isAutomationBoardCard` 分支 + `isToolCard` 归类 + `cardUsesComposer` 排除
- [x] `src/components/PaneView.tsx`：tab 图标；`isStreaming` 改为含 `automationBoardHasActiveRun`
- [x] 空态工具栅格 + 模型选择器 + 设置开关（照现有工具卡的 `*CardEnabled` 形状）
- [x] `shared/i18n.ts`：zh-CN + en 全套新文案（含"上方需求"一套唤醒文案）
- [x] `src/index.css`：看板布局 + 项卡片三态边框（复用现有 token，双主题）+ 唤醒条置顶变体

## Slice 5 — 拖放

- [x] `src/dnd.ts`：两个新 payload 成员 + `readDragPayload` 校验分支
- [x] `PaneView`：tab 栏 / 内容区接受 `automation-board-item`
- [x] `AutomationBoardCard`：泳道接受 `tab` / `automation-board-item` / `automation-board-template`
- [x] 跨列拒绝；watchdog 只清视觉提示；项头 draggable 且不 preventDefault mousedown

## Slice 6 — 运行编排

- [x] `src/App.tsx`：`applyAutomationBoardTransition`（结构 → 中断 → 发送 → 打时间戳）
- [x] 新需求项创建 / 模板实例化 / 项删除的 handler
- [x] 唤醒在看板语境下传泳道 id 列表而不是 `pane.tabs`
- [x] 看板卡片的 props 装配（沿用 ChatCard 现有 prop 传递路径）

## Slice 7 — 自动触发与监工

- [x] `src/components/automation-board-auto-trigger.ts`：`resolveAutomationBoardAutoTriggerDecision`
- [x] `tests/automation-board-auto-trigger.test.ts` + 注册
- [x] `src/App.tsx`：挂到既有"卡片稳定完成"广播；`ensureAutomationBoardSupervisor` + 发送
- [x] 监工配置 UI（在看板内，可改 provider/model/需求文本/开关/最小间隔），写 `automationBoards[workspacePath].autoTrigger`

## Slice 8 — 看板 MCP

- [x] `server/automation-board-bridge.ts`：loopback HTTP + token + deps
- [x] `server/automation-board-mcp.js`：stdio JSON-RPC + 5 个工具
- [x] `server/automation-board-runtime.ts`：codex `-c` / claude `--mcp-config` 注入 + 系统提示补充
- [x] `server/providers.ts`：监工回合识别与注入接线
- [x] `electron/backend.ts` + `electron/main.ts`：镜像推送入口 + 命令广播（照 `dispatchRemoteCommand`）
- [x] `src/api.ts`：`pushAutomationBoardMirror`、`subscribeAutomationBoardCommands`
- [x] `src/App.tsx`：看板命令执行器（复用真实 handler，禁止捷径）
- [x] `tests/automation-board-mcp.test.ts` + 注册

## Slice 9 — 收口

- [x] `pnpm test`（全量，绿）
- [x] `pnpm test:quality`（ESLint + 四个 tsconfig 全绿）
- [~] 真实 Electron 手动驱动走一遍 requirements 的 11 条验收 —— 自动化已覆盖大部分：
      `tests/electron-automation-board-admin-runtime.test.ts`（真实 Electron 里的超管权限边界）、
      `tests/automation-board-absorb-back.spec.ts` / `automation-board-compose-paste.spec.ts`
      （拖出/拖回、组合器粘贴图片的端到端）、`tests/automation-board-mcp.test.ts`（5 个 MCP 工具）。
      剩下**纯手动**的是"监工真的叫起一轮并被防自触发挡住第二轮"这条长时行为，只能实机观察。
- [x] `pnpm electron:build` —— v0.19.0 前已出过打包产物并实机跑起来（asar 内
      `dist/electron/backend-host.js` 出现在 main.log 的栈帧里，0 条 `Backend process exited.`）。
      发版本身走服务端 `release-zip.yml` 构建，那次构建就是这条的最终证据。
- [x] `AGENTS.md` 补 pitfall 行

## 实施记录（2026-08-11）

全部切片已实现并合入 `feat/automation-board`。与设计文档的偏差已回写 design.md：

- 桥接工厂是 `createAutomationBoardBridge(deps) → { start, stop, status }`，不是一次性的 start 函数。
- `automationBoardSupervisor` 请求字段带 `columnId`（两个字段都必填）。
- 镜像随身带 `recentEntries`，`read_board_item` 因此不需要另开请求/应答通道；预算在渲染端与 server 各执行一遍。
- 新增 `server/automation-board-session.ts` 作为 providers.ts 的唯一入口（懒启动 + 镜像表 + dispatcher 登记）。

过程中发现并修掉的两个真实缺陷（已进 AGENTS.md pitfall 256/257/258）：

1. **离层卡片对记忆化不可见** —— 项卡片不在 `pane.tabs` 里，`arePaneViewPropsEqual` 因此看不到它们变化，流式的项在界面上是静止的。
2. **计划唤醒的"上方需求"从未接线** —— `armWakeTimerBatch` 拿的仍是 `pane.tabs`，看板项在里面找不到自己，`left-tab` 模式永远判定"上方没有可等待的对象"。已抽 `resolveWakeTimerNeighbourIds` 统一两种语境。

MCP 端到端实测（一次性探针，非注册测试）：起真实桥接 → 用 `process.execPath` spawn 真实的
`automation-board-mcp.js` → 走 Content-Length JSON-RPC 对话，实测结果：

- `initialize` 返回 `chill-vibe-automation-board`，`tools/list` 返回全部 5 个工具。
- `list_board_items` 输出泳道计数、**原始需求原文**、`Started at`、`silent for N minutes`。
- `read_board_item` 返回该项的最近转录。
- `send_board_item_message` / `move_board_item` 投递出的命令形状与 `automationBoardCommandSchema` 完全一致；非法 lane 被拒。
- **不带 `automationBoardSupervisor` 标记的普通回合拿到 `null`** —— 权限边界成立。

未覆盖（明确留给后续）：

- Playwright 视觉回归快照。本机 Playwright 当前不可靠（pitfall 25/34/252），新表面的双主题快照等 harness 修好后再补。
- Web（非 Electron）模式没有看板 MCP —— 桥接与 remote-monitor 一样是桌面端专属；`publishAutomationBoardMirror` 在 Web 下静默 no-op。

---

# v2 — 监工模板化 + 超管权限

目标见 requirements FR6/FR7/FR10 与 design 的「v2 一致化」章。切片顺序按依赖：契约先落地，UI 与 server 并行叠。

## Slice V1 — shared 契约

- [x] `shared/schema.ts`：删 `automationBoardSchema.supervisorCardId/supervisorExpanded`、删 `automationBoardAutoTriggerSchema` 与 `workspaceState.autoTrigger`；加 `item.templateId`、`template.{adminAccess,builtIn,trigger,instanceCardId}`、`chatCardSchema.adminAccess?`、`chatRequestSchema.adminAccess?`；镜像/命令 schema 换工作区语义
- [x] `shared/default-state.ts`：`createDefaultAutomationBoardSupervisorTemplate()`；`createDefaultAutomationBoardWorkspaceState()` 默认带它
- [x] `server/state-store.ts`：旧存档迁移（`autoTrigger` → 内置模板 `trigger`；丢弃 supervisor 指针；补种内置模板）
- [x] `shared/i18n.ts`：删监工区文案，加模板配置面板 / 触发器 / 超管权限文案
- [x] 测试：`tests/automation-board-persistence.test.ts` 迁移用例（红先）

## Slice V2 — 纯函数与 reducer

- [x] `automation-board-auto-trigger.ts` → `resolveAutomationBoardTemplateTriggerDecisions`（五条规则，含 `self-triggered`）
- [x] `automation-board-transitions.ts`：`automationBoardHasActiveRun` 去 supervisor 分支
- [x] `src/state.ts`：删 `ensureAutomationBoardSupervisor` / `setAutomationBoardSupervisorExpanded` / `updateAutomationBoardAutoTrigger`；加 `updateAutomationBoardTemplate`（含 trigger patch）/ `setAutomationBoardTemplateInstance`；`createAutomationBoardItem` 接 `templateId` 与 `adminAccess`
- [x] 测试：`automation-board-auto-trigger.test.ts` 改写（自触发防护必须红先）、`automation-board-state.test.ts` 增补

## Slice V3 — server MCP 工作区化

- [x] 镜像键 `boardCardId` → `columnId`；镜像内容含 tab 卡与看板项，排除工具卡
- [x] 工具改名与语义：`list_sessions` / `read_session` / `send_session_message` / `move_session_to_lane` / `set_session_wake_timer`
- [x] `automation-board-runtime.ts`：env 加 `SELF_CARD_ID`；系统提示改 `getWorkspaceAdminInstruction`
- [x] `server/providers.ts`：判定改 `request.adminAccess`
- [x] 测试：`automation-board-mcp.test.ts` / `automation-board-mirror.test.ts` 改写

## Slice V4 — UI

- [x] `AutomationBoardCard.tsx`：删监工区；模板条加可展开配置面板（名称/需求/模型/超管权限/触发器/恢复默认）；触发器开启显示闪电角标
- [x] `ChatCard.tsx`：composer 设置菜单加「超管权限」开关 + 卡片头部盾牌角标
- [x] `src/index.css`：删 supervisor 样式，加模板配置面板与超管标识（双主题）

## Slice V5 — App 编排

- [x] 删 `runAutomationBoardSupervisor`，加 `fireAutomationBoardTemplateTrigger`（复用实例 / 否则走 `instantiateTemplate`）
- [x] `lastFiredAt` ref 改为按 templateId
- [x] 请求构建处按 `card.adminAccess` 带 `adminAccess: { columnId }`（唯一必经点，不散到调用方）
- [x] 镜像推送改列级；命令执行器改工作区语义

## Slice V6 — 收口

- [x] 相关 Node 测试全绿 + `pnpm test:quality`
- [x] AGENTS.md 补 pitfall（260 隐式免疫消失 / 261 触发语义 ≠ 搬运语义 / 262 拖拽前的兜底激活 / 263 工具卡名单手抄四份）
- [x] `pnpm electron:build`

## v2 实施记录（2026-08-11）

设计与实现的偏差，已回写 design.md：

- 命令只带 `columnId` 不带 `boardCardId`，目标看板由渲染端解析。补充了设计里没写的一条：目标若还是个**普通 tab**，就走 `absorbTab` 把它吸收进看板，语义与用户手动把 tab 拖进泳道相同。
- 实例复用判定抽成了 `resolveAutomationBoardTemplateInstanceCardId`：`instanceCardId` 失效时回退认项自带的 `templateId`（取最后一张），而不是直接新建。
- 触发的复用路径**刻意绕开** `resolveAutomationBoardTransition` 的发送分支（见 pitfall 261）。
- 旧存档迁移的补种条件收窄成"entry 没有 `templates` 键"或"仍带待迁移的 `autoTrigger`"，这样用户删掉内置监工模板后不会每次加载又被种回来。

端到端实测（一次性探针，非注册测试）：起真实桥接 → `process.execPath` spawn 真实 `automation-board-mcp.js` → Content-Length JSON-RPC 对话。实测结果：

- `serverInfo` 为 `chill-vibe-workspace-admin`，`tools/list` 返回全部 5 个工具。
- `list_sessions` 同时列出**看板项**（带泳道 + 原始需求 + `silent for 42 minutes`）与**普通 tab 会话**（标注 standalone tab）—— 这正是"操作其他会话"的核心。
- **请求方自己被过滤掉**（`SELF_CARD_ID`），模型不会把自己列出来再给自己发消息。
- 三个写工具投递出的命令形状与 `workspaceAdminCommandSchema` 完全一致；非法 lane 被拒。

未覆盖（明确留给后续）：Playwright 视觉回归快照（本机 harness 不可靠，pitfall 25/34/252）；Web 模式没有工作区 MCP（桥接是桌面端专属，Web 下 publish 静默 no-op）。
