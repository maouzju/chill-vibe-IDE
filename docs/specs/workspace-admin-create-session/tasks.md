# 任务拆分

## 切片 1：工具与命令契约（red → green）

- [x] T1.1 改 `tests/automation-board-mcp.test.ts`：工具数 5 → 6，断言 `create_session` 的封闭输入 schema
      与必填/可选字段。**先跑，确认红。**
- [x] T1.2 加解析用例：合法参数生成的 `admin-create-session` 命令能过 `workspaceAdminCommandSchema`；
      省略 `lane` 时默认 `running`；`provider` / `model` 省略时不出现在命令里。
- [x] T1.3 加错误用例：缺 `requirement`、`requirement` 全空白、`lane: 'done'`、非法 `provider`
      各自报错且不投递命令。
- [x] T1.4 加 `callWorkspaceAdminTool` 用例：`create_session` 走 `postCommand`，返回「已投递非已生效」文案。
- [x] T1.5 `shared/schema.ts` 新增 `workspaceAdminCreatableLanes` / `...LaneSchema` 与
      `admin-create-session` 分支。
- [x] T1.6 `server/automation-board-mcp.js` 新增工具定义 + 解析分支（注意：在 `cardId` 必填检查**之前**分流）
      + `callWorkspaceAdminTool` 放行。
- [x] T1.7 跑测试确认绿。

**红阶段实测**：4 条失败，其中 `resolveWorkspaceAdminCommandFromToolCall rejects bad create arguments`
返回的正是 `cardId is required. Call list_sessions to get the cardId of each session.` —— 设计里预判的
那处坑当场被证实，不是假想。

## 切片 2：渲染进程落位

- [x] T2.1 `src/App.tsx` 执行器新增 `admin-create-session` case：有看板 → `createItem`；
      无看板 → `addTab` + (`running` ? 发送 : 写草稿)。
- [x] T2.2 `pnpm test:quality` 确认类型检查通过（discriminated union case 完备）。

**实现期发现**：`updateCard` 的 patch 不接受 `draft`，草稿有独立的 `setCardDraft` action
（`src/state.ts:343`）。已记入 AGENTS.md Known Pitfalls。

## 切片 3：系统提示与收尾

- [x] T3.1 `server/automation-board-runtime.ts` 中英文提示改成 6 个工具并描述 `create_session`
      的落位规则。
- [x] T3.2 既有的 `getWorkspaceAdminInstruction names every tool` 测试自动覆盖（它遍历工具定义，
      加了工具就必然要求提示里提到它）。
- [x] T3.3 跑 `tests/automation-board-mcp.test.ts` 全绿 + `pnpm test:quality`。
- [x] T3.4 按 AGENTS.md 打包默认：`pnpm electron:build`。

## 切片 4：端到端证明（超出原计划）

- [x] T4.1 新增 `create_session travels from a real stdio client through the bridge into a
      schema-valid command`：真子进程 spawn MCP server + 真 loopback bridge，`tools/call` 一路走到
      `dispatchCommand`。这条覆盖了纯函数单测覆盖不到的东西 —— `automation-board-mcp.js` 里的 lane
      白名单是**抄写**的字面量，单测断言的两边是同一份抄写，只有让命令真的过一次共享 zod schema
      才能抓住漂移。
