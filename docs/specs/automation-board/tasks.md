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
- [ ] 真实 Electron 手动驱动走一遍 requirements 的 11 条验收
- [ ] `pnpm electron:build`
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

未覆盖（明确留给后续）：

- Playwright 视觉回归快照。本机 Playwright 当前不可靠（pitfall 25/34/252），新表面的双主题快照等 harness 修好后再补。
- Web（非 Electron）模式没有看板 MCP —— 桥接与 remote-monitor 一样是桌面端专属；`publishAutomationBoardMirror` 在 Web 下静默 no-op。
