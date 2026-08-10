# 自动化看板 — Tasks

切片原则：每一片都能单独跑测试、单独回滚。结构层先落地并被测试钉住，再往上叠 UI，最后接 MCP。

## Slice 1 — 数据模型与归一化

- [ ] `shared/models.ts`：`AUTOMATIONBOARD_TOOL_MODEL`、`MODEL_OPTIONS` 条目、`MODEL_PICKER_HIDDEN_TOOL_MODELS`
- [ ] `shared/schema.ts`：lane / item / board / template / autoTrigger / workspaceState schema；`chatCardSchema.automationBoard?`；`appStateSchema.automationBoards`；`defaultAutomationBoardSupervisorRequirement`；`chatRequestSchema.automationBoardSupervisor?`
- [ ] `shared/default-state.ts`：`createAutomationBoardCard`、`createDefaultAutomationBoardWorkspaceState`、`createDefaultState` 带 `automationBoards: {}`
- [ ] `server/state-store.ts`：`normalizePersistedCard` 修补 `automationBoard` + 剔孤儿项；`normalizePersistedColumn` 空 layout 兜底排除 items 引用的 cardId；顶层 `automationBoards` 归一化
- [ ] 测试：旧存档（无新字段）加载不报错且补齐默认值；孤儿项被剔除；看板项不被塞进兜底 pane

## Slice 2 — 迁移决策纯函数（先红后绿）

- [ ] `src/components/automation-board-transitions.ts`：`resolveAutomationBoardTransition`
- [ ] `src/components/automation-board-state.ts`：`automationBoardHasActiveRun`、`getAutomationBoardLaneItems`、`hasAutomationBoardHistory`、`getAutomationBoardLaneCardIds`（唤醒用的有序 id 列表）
- [ ] `tests/automation-board-transitions.test.ts`：判定表逐格 + 两条重点断言
- [ ] 注册进 `tests/index.test.ts`

## Slice 3 — Reducer

- [ ] `src/state.ts` 新增 11 个 `IdeAction` 变体与实现
- [ ] 原子搬运：`moveAutomationBoardItemToPane` / `moveTabToAutomationBoard` 前置校验两端
- [ ] `tests/automation-board-state.test.ts`：原子性（两端任一失效整体不变）、lane 重排保序、派生函数
- [ ] 注册进 `tests/index.test.ts`

## Slice 4 — 看板 UI

- [ ] `src/components/AutomationBoardCard.tsx`：三泳道 + 项卡片 + 待命道输入 + 模板条 + 监工区
- [ ] `src/components/automation-board-item-window.ts`：末 N 条裁剪
- [ ] `src/components/ChatCard.tsx`：`isAutomationBoardCard` 分支 + `isToolCard` 归类 + `cardUsesComposer` 排除
- [ ] `src/components/PaneView.tsx`：tab 图标；`isStreaming` 改为含 `automationBoardHasActiveRun`
- [ ] 空态工具栅格 + 模型选择器 + 设置开关（照现有工具卡的 `*CardEnabled` 形状）
- [ ] `shared/i18n.ts`：zh-CN + en 全套新文案（含"上方需求"一套唤醒文案）
- [ ] `src/index.css`：看板布局 + 项卡片三态边框（复用现有 token，双主题）+ 唤醒条置顶变体

## Slice 5 — 拖放

- [ ] `src/dnd.ts`：两个新 payload 成员 + `readDragPayload` 校验分支
- [ ] `PaneView`：tab 栏 / 内容区接受 `automation-board-item`
- [ ] `AutomationBoardCard`：泳道接受 `tab` / `automation-board-item` / `automation-board-template`
- [ ] 跨列拒绝；watchdog 只清视觉提示；项头 draggable 且不 preventDefault mousedown

## Slice 6 — 运行编排

- [ ] `src/App.tsx`：`applyAutomationBoardTransition`（结构 → 中断 → 发送 → 打时间戳）
- [ ] 新需求项创建 / 模板实例化 / 项删除的 handler
- [ ] 唤醒在看板语境下传泳道 id 列表而不是 `pane.tabs`
- [ ] 看板卡片的 props 装配（沿用 ChatCard 现有 prop 传递路径）

## Slice 7 — 自动触发与监工

- [ ] `src/components/automation-board-auto-trigger.ts`：`resolveAutomationBoardAutoTriggerDecision`
- [ ] `tests/automation-board-auto-trigger.test.ts` + 注册
- [ ] `src/App.tsx`：挂到既有"卡片稳定完成"广播；`ensureAutomationBoardSupervisor` + 发送
- [ ] 监工配置 UI（在看板内，可改 provider/model/需求文本/开关/最小间隔），写 `automationBoards[workspacePath].autoTrigger`

## Slice 8 — 看板 MCP

- [ ] `server/automation-board-bridge.ts`：loopback HTTP + token + deps
- [ ] `server/automation-board-mcp.js`：stdio JSON-RPC + 5 个工具
- [ ] `server/automation-board-runtime.ts`：codex `-c` / claude `--mcp-config` 注入 + 系统提示补充
- [ ] `server/providers.ts`：监工回合识别与注入接线
- [ ] `electron/backend.ts` + `electron/main.ts`：镜像推送入口 + 命令广播（照 `dispatchRemoteCommand`）
- [ ] `src/api.ts`：`pushAutomationBoardMirror`、`subscribeAutomationBoardCommands`
- [ ] `src/App.tsx`：看板命令执行器（复用真实 handler，禁止捷径）
- [ ] `tests/automation-board-mcp.test.ts` + 注册

## Slice 9 — 收口

- [ ] `pnpm test`（新增文件 + 相邻受影响文件）
- [ ] `pnpm test:quality`
- [ ] 真实 Electron 手动驱动走一遍 requirements 的 11 条验收
- [ ] `pnpm electron:build`
- [ ] `AGENTS.md` 补 pitfall 行（若过程中撞到新坑）
