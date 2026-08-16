# 自动化看板 — Tasks

## 实验性开关收口（2026-08-14）

- [x] 默认设置与 schema 改为关闭自动化看板卡牌
- [x] 设置入口标注“实验性”，保留用户手动开启能力（走 i18n，中英各一份文案，不硬编码中文）
- [x] 默认状态回归测试
- [x] 快捷工具与设置组的 Playwright 断言/快照跟着默认值一起改

验证记录：

- `tests/default-state.test.ts` 新增「实验性看板默认关闭」用例：`createDefaultSettings` / `normalizeAppSettings({})` / `appSettingsSchema.parse({})` 三条入口都断言 `false`，并断言快捷工具列表里没有看板。
- `tests/tool-card-settings.spec.ts`：默认快捷工具由 4 个改为 3 个，且补了「勾上实验性开关后看板重新出现」这一步——只把 `toHaveCount(4)` 改成 `(3)` 的话，看板永远渲染不出来也会绿。
- 视觉：「卡片类型」设置组的 6 张快照（`card-type-settings-experimental-*`、`experimental-settings-group-*`）因勾选态与“（实验性）”后缀重新基线，属本次有意变更。
- 发布审计补漏（2026-08-14）：`tests/card-title-editing.spec.ts` 的 `createToolLauncherState` 也吃这个默认值——它经 `createPlaywrightState` → `appStateSchema.parse` 继承 settings，却从不提到该字段名，所以按字段名搜会漏掉它那两条 `toHaveCount(7)`。改法是在这个「工具入口全开」helper 里显式打开看板，而不是把 7 改成 6：这条用例盯的是最坏折行排版，少一个入口就测不到，且保持 7 也让它的快照不用重新基线。
- 回归证据：`theme-check.spec.ts` + `card-title-editing.spec.ts` + `tool-card-settings.spec.ts` 三个 spec 合跑 207 passed（4.2 分钟），含设置面板 grid/stack 两张整面板快照确认未受影响。
- 全量门禁又补出两处（2026-08-14）：`model-menu-short-pane-{dark,light}.png` 的背景里就有那块看板砖（差 2536 像素 / 4%），属默认值变更的有意重新基线，已单独 `--update-snapshots` 并确认只动这两张；`tests/electron-automation-board-restart-runtime.test.ts` 的种子状态走 `createDefaultState`，砖不出现导致按中文名点击超时 32s，已在种子里显式打开开关——这条用例盯的是"看板扛不扛得住重启"，不是开关本身。

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

## Slice V7 — 泳道宽度可调（v2.2 / FR11）

- [x] `shared/schema.ts` 加 `automationBoardLaneWidthsSchema` + `automationBoard.laneWidths?`
- [x] `server/state-store.ts` `normalizePersistedAutomationBoard` 显式带上 `laneWidths`（手抄字段，红先）
- [x] 新 `src/components/automation-board-lane-resize.ts`（resolve / tracks / toWidths，拖拽数学复用 `resizeColumnGroups`）
- [x] reducer `setAutomationBoardLaneWidths`（`null` = 删字段回均分）
- [x] `AutomationBoardCard` 渲染分隔条 + 指针拖拽（拖拽中只写 CSS 变量，松手才 dispatch）+ 双击重置
- [x] `src/index.css`：三层变量回落、三条泳道显式占格、分隔条样式、窄档 `display: none`
- [x] `tests/automation-board-lane-resize.test.ts` / `-state` / `-persistence` 三处单测
- [x] `tests/automation-board-layout.spec.ts` 加两条：拖完一条变宽另两条让位 + 双击回均分 + 轨数仍是 3；预置比例在宽档生效、窄档让位且分隔条隐藏
- [x] `pnpm test:quality` + `pnpm electron:build`

### v2.2 实施记录（2026-08-13）

三个只有真浏览器能抓到的坑，已回写 design.md 与 AGENTS.md：

- 分隔条作为显式定位的 grid item 会把自动放置的三条泳道整体挤位（→ pitfall 284，泳道也改成显式占格）。
- 改用 `position: absolute` + grid-area 的方案在 Chromium 里两条分隔条双双贴到容器最右边，点第一条实际拖第二条。
- 命令式写 React 内联管着的 CSS 变量会让 React 从此写不进该属性，双击恢复均分永久失效（→ pitfall 285，拆成拖拽层 / React 层两个变量）。

顺带两处与列分隔条刻意不同的取舍：pointerdown 不 `preventDefault`（否则 `dblclick` 收不到），以及"没动过就不提交"。

## Slice V8 — 执行参数在源头可设且记得住（v2.3 / FR12）

- [x] `shared/schema.ts` 加 `automationBoardComposeDefaultsSchema` + `automationBoard.composeDefaults?`
- [x] `server/state-store.ts` `normalizePersistedAutomationBoard` 显式带上 `composeDefaults`（手抄字段，红先）
- [x] reducer `setAutomationBoardComposeDefaults`（对 composeDefaults 浅合并，基底 = 当前值 ?? 列默认）
- [x] 抽 `AutomationBoardModelSettings` 受控组件（模型 / 思考 / 思考深度 / 计划模式 / 超管），导出供 SSR 单测
- [x] `AutomationBoardTemplateConfig` 换用该组件（模板 schema 早有这些字段，只缺入口）
- [x] 待命 composer：设置折叠区 + 值改为读写 `board.composeDefaults`，删掉「不落盘」那条已被推翻的注释
- [x] `App.tsx` `createItem` 转发 reasoningEffort / thinkingEnabled / planMode / adminAccess（之前在半路掉了）
- [x] `src/index.css`：composer 设置区样式，双主题
- [x] `tests/automation-board-render.test.tsx` / `-state` / `-persistence` 三处单测
- [x] `pnpm test:quality` + `pnpm electron:build`

## Slice V9 — 项的计划唤醒复用 composer 那块完整面板（v2.4 / FR5）

- [x] 抽 `src/components/WakeTimerSettingsPanel.tsx`（受控组件，`context: 'tab' | 'board'` 只切文案）
- [x] `ChatCard` 换用它（行为、DOM 结构与文案保持不变，只是搬家）
- [x] `shared/i18n.ts`：`automationBoardWakeAboveLabel` 改成"上方需求完成"（下拉选项语气）、新增 `automationBoardWakeModeHint`，把 composer 里硬编码的中英"本工作区有 N 个其他 Agent"提成 `wakeTimerWorkspaceAgentCount`
- [x] 导出 `AutomationBoardItemDrawer`，抽屉里的"上方需求"复选框换成整块面板；`workspaceAgentCount` 从 `cards` 现算（工具卡不算，与 `PaneView` 同口径）
- [x] `src/index.css`：`.automation-board-item-wake-panel` 把面板压到抽屉的 10px 字号档，只改尺寸不动颜色 token
- [x] `tests/wake-timer-settings-panel.test.tsx`（9 条）+ `tests/automation-board-render.test.tsx` 的 `AutomationBoardItemDrawer`（5 条）
- [x] `pnpm test:quality` + `pnpm electron:build`

## Slice V10 — 看板内容的生命周期长于承载它的那张卡（v2.5 / FR13）

- [x] `shared/schema.ts`：`automationBoardWorkspaceStateSchema.board?`、`automationBoardSchema.draft?`
- [x] `server/state-store.ts`：`normalizePersistedAutomationBoard` 带上 `draft`；`normalizePersistedCard` 补 `automationBoardTemplateId`（两处手抄白名单）
- [x] `src/state.ts`：`ideReducer` 拆薄 wrapper + `mirrorAutomationBoardsToWorkspaces`（白名单 action、no-op 短路、消失时回落 previous）
- [x] `src/state.ts`：`restoreAutomationBoardForColumn`（交回 + 逐项校验 + 孤儿收编），接在 `selectCardModel`
- [x] `src/state.ts`：`setAutomationBoardDraft` reducer；host / PaneView / App.tsx 接出 `setComposerDraft`
- [x] `AutomationBoardCard`：草稿初值取自 `board.draft`，失焦与卸载两处落盘，提交后清空
- [x] `tests/automation-board-state.test.ts` 六条 + `tests/automation-board-persistence.test.ts` 两条（全部红先）
- [x] `tests/electron-automation-board-restart-runtime.test.ts`（新）+ 注册进 `scripts/run-electron-runtime-tests.ps1`
- [x] `pnpm test:quality`

### v2.5 实施记录（2026-08-13）

定位过程本身值得记：Node 层往返测试是绿的，拿用户手上的 v0.19.1 打包版跑完整 UI 动线也是绿的 ——
**存储层从来没坏过**。真正说明问题的是磁盘现场的形状：项卡活着、看板卡一张没有。能造出这个形状的
只有 `closeTab`（`moveTab` 是搬走，别的列就该有；`removeAutomationBoardItem` 删的是项卡）。

两个一次性取证脚本留在 `scripts/`：`repro-automation-board-persistence.ts`（Node 层往返）、
`probe-packaged-board-ui-restart.mjs` + `repro-packaged-board-restart.ps1`（拿打包版跑真实动线）、
`inspect-board-state.mjs`（把任意 state.json 的列 / tab / 孤儿卡打出来）。下次再报"看板没了"，
先跑最后一个看形状。

## Slice V11 — 模板配置真的作用到它跑的那张卡（v2.6 / FR14）

- [x] `src/components/automation-board-template-sync.ts`（新）：`resolveAutomationBoardTemplateInstanceSync`
      —— 模型走 `selectCardModel`、其余走一次浅 patch、全没变返回 `null`；深度按将要生效的模型归一化
- [x] `src/App.tsx`：`fireAutomationBoardTemplateTrigger` 复用分支在换道与投递之前跑一次同步
- [x] 模板配置面板补齐执行参数入口（执行方式分组：思考 / 思考深度 / 计划模式），`shared/i18n.ts`
      新增 `automationBoardTemplateExecutionLabel`（zh + en）
- [x] 面板按语义分三组，双栏用 `grid-template-areas` 整组落位；超管说明只在开着时常驻
- [x] 模板胶囊改名从 `window.prompt` 换成就地输入框（改名时停掉拖拽，空名不提交）
- [x] 思考深度不再被"思考"复选框 disable：`shared/reasoning.ts` 的
      `shouldEnableThinkingForDepthChange`，看板面板与 chat composer 两处共用
- [x] `tests/automation-board-template-sync.test.ts`（红先）+ `tests/automation-board-render.test.tsx` 扩充
- [x] `tests/thinking-depth-selectable.spec.ts` + `tests/automation-template-config-persistence.spec.ts`（新，均已进
      `scripts/run-playwright-specs.ps1` 的 smoke 桶）
- [x] `pnpm test:release` 全量闸门

### 留给后续

- [ ] 待命 composer 粘贴的图片仍是本地 state（`draftImages`），切 tab 即失。要落盘得复用 ChatCard 那套
      "粘贴即后台上传 → 存 `draftAttachments`"，涉及异步上传时序，单独一条 slice 配红先测试。
