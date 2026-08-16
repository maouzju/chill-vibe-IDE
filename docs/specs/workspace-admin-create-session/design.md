# 设计：超管 MCP 新建会话

## 复用既有链路，不新增通道

这条命令完全复用超管写命令的既有 7 段链路，没有任何新的进程边界或端点：

```
CLI 子进程 (automation-board-mcp.js)
  → POST /command            server/automation-board-bridge.ts:216
  → workspaceAdminCommandSchema.safeParse
  → dispatchCommand          server/automation-board-session.ts:108
  → utilityProcess RPC       electron/utility-host.ts:139
  → broadcastToLiveRenderers electron/main.ts:207
  → CustomEvent              electron/preload.ts:51
  → 渲染进程执行器            src/App.tsx:5235
```

唯一新增的是：一个工具定义、一条命令 tag、一个执行器 case、两份系统提示文案。

## 关键设计决定

### 1. lane 收窄为 `standby | running`，不复用 `automationBoardLaneSchema`

`automationBoardLaneSchema` 是三值 `standby | running | done`。新建会话时 `done` 无意义
（一张刚建出来、一句话没说的卡不可能"已交付"）。

被否决的替代方案：**收到 `done` 时静默降级为 `standby`**。否决理由是超管的每一条写命令都是
不可见后果 —— 模型不会看到 UI，只能靠返回文本理解发生了什么。静默纠正会让模型带着
"我建了一张已完成的卡"的错误世界模型继续决策。报错让它当场改正。

因此在 `shared/schema.ts` 新增：

```ts
export const workspaceAdminCreatableLanes = ['standby', 'running'] as const
export const workspaceAdminCreatableLaneSchema = z.enum(workspaceAdminCreatableLanes)
```

`server/automation-board-mcp.js` 因为不能 import TS，照既有惯例再抄一份字面量
（文件顶部已有 `boardLanes` / `wakeTimerModes` 的同类抄写），唯一防线仍是测试把生成的 command
拿去过 `workspaceAdminCommandSchema`。

### 2. 没有看板卡时降级为普通 tab 会话，而不是失败

用户实测的失能现场就是「这个工作区现在一张卡都没有」—— 那种工作区里**必然也没有看板卡**。
如果 `create_session` 沿用 `move_session_to_lane` 的「没有看板就失败」策略，
这个工具在最需要它的场景下恰好是坏的。

所以执行器分两条路：

| 本列状态 | 落位 | 复用的 handler |
|---|---|---|
| 有看板卡 | 该看板的看板项 | `automationBoardActions.createItem`（`src/App.tsx:3725`） |
| 无看板卡 | 第一个 pane 里的普通 tab | `applyAction({ type: 'addTab', ... })`（`src/state.ts:2170`） |

两条路都不是新写的落位逻辑 —— 前者是看板 composer「加入待命」用的那个，
后者是手机监工 `add-tab` 和界面上「＋」按钮用的那个。

### 3. `lane` 在两条路径上的统一语义

`lane` 表达的其实是**"要不要立刻开跑"**，只是在看板上它同时也是泳道位置：

- `running` → 建卡 + 把 requirement 作为第一条消息发送。
  看板路径由 `createItem` 内部完成（它在 `lane === 'running'` 时调 `sendMessageRef` 并打 `startedAt`）；
  tab 路径由执行器显式调 `sendMessageRef.current?.(...)`。
- `standby` → 建卡 + requirement 只进 `draft`，不发送。
  看板路径由 `createAutomationBoardItemCard` 完成（它本来就把 requirement 落在 `draft`）；
  tab 路径由执行器补一条 `setCardDraft` 把 `draft` 写上（`updateCard` 的 patch 类型不含 `draft`，
  草稿有独立 action —— 见 AGENTS.md pitfall 295）。

### 4. 不暴露 `adminAccess`

`createItem` 的 options 支持 `adminAccess`，但本工具**刻意不透传**。

否决理由：超管权限一旦可以由超管自己授予，就形成了自我复制的权限扩散链 ——
一个超管能建出 N 个超管，每个又能再建 N 个，而用户在界面上只授权过一次。
超管权限的授予点必须保持在用户手上（`card.adminAccess` 由界面开关写入，`src/App.tsx:6273` 读取）。

### 5. `cardId` 前置校验必须为这条命令让路

`resolveWorkspaceAdminCommandFromToolCall`（`server/automation-board-mcp.js:268`）
在分发到具体工具之前统一做了 `cardId` 必填检查。`create_session` 是唯一一个
**目标卡还不存在**的写工具，必须在那道检查之前分流出去，否则它永远返回
"cardId is required"。这是本次改动里最容易踩空的一处，测试直接钉这一条。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `shared/schema.ts` | 新增 `workspaceAdminCreatableLane*` + `admin-create-session` 命令分支 |
| `server/automation-board-mcp.js` | 新增工具定义、命令解析分支、`callWorkspaceAdminTool` 放行 |
| `server/automation-board-runtime.ts` | 中英文系统提示：5 个工具 → 6 个 |
| `src/App.tsx` | 执行器新增 `admin-create-session` case（看板 / tab 两条路） |
| `tests/automation-board-mcp.test.ts` | 工具契约、命令契约、错误路径 |

## 验证策略

- Tier 1，`red → green`。先改测试断言（工具数 5→6、新增解析用例），确认红，再改生产代码。
- 命令 schema 的正确性由「生成的 command 过 `workspaceAdminCommandSchema`」这条既有断言方式保证。
- 渲染进程执行器不在 Node 单测覆盖内（依赖 React 运行时），按仓库既有惯例，
  由 `pnpm test:quality` 的类型检查保证 discriminated union 的 case 完备性 —— 
  新增 tag 后如果执行器漏了 case，TypeScript 会在 `command.type` 上报未覆盖。
