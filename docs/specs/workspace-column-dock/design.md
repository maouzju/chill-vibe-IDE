# 工作区列停靠到顶栏 — 设计

## 数据模型（shared/schema.ts + shared/default-state.ts）

`boardColumnSchema` 新增：

| 字段 | 类型 | 含义 |
|------|------|------|
| `docked` | `z.boolean().optional()` | `true` = 已收起到顶栏。未停靠时字段不写入（保持旧存档 / 测试 fixture 的形状不变）。 |

选 optional 而不是 `.default(false)`：这个字段只在 true 时有意义，`createColumn` / `duplicateColumn` / 各类 deepEqual 断言都不用为它改动；恢复时直接删掉键而不是写 `false`。

`createColumn(overrides)`：只有 `overrides.docked === true` 时才带上 `docked: true`。`duplicateColumnState` 不复制 `docked`（复制出来的新列应当立刻可见）。

## reducer（src/state.ts）

`IdeAction` 新增：

```ts
| { type: 'dockColumn'; columnId: string }
| { type: 'undockColumn'; columnId: string }
```

- `dockColumn`：找不到列或已 `docked === true` → 返回原 state；否则写 `docked: true` 并 `touchState`。
- `undockColumn`：找不到列或 `docked !== true` → 返回原 state；否则去掉 `docked` 键并 `touchState`。
- 两者都不改数组顺序。

## App 层（src/App.tsx）

### 看板

`appState.columns.filter((column) => column.docked !== true)` 后再 map 渲染 `WorkspaceColumn`。停靠列整棵子树卸载：流结束广播、自动鞭策、断线续传、草稿同步都已经在 App 层或 reducer 里，不依赖 `ChatCard` 挂载（参见 `docs/specs/global-urge-topbar/design.md` 里"未挂载的后台 tab 也能处理"）。

### 顶栏

`.app-tab-list` 内、`app-topbar-add-column` 之后：

1. 停靠标签：`appState.columns.filter(docked)` → `<button className="app-topbar-docked-column">`，文案 `getColumnDisplayLabel(column)`（路径末段，否则标题），`title` 为路径，`onClick` → `undockColumn`。
2. 停靠落区：仅当 `columnDragInFlight` 为 true 时渲染 `<div className="app-topbar-dock-zone">`，`onDragOver` 校验 `readDragPayload(event)?.type === 'column'` 后 `preventDefault` 并置 `is-over`；`onDrop` → `dockColumn` + `clearDragPayload()`。

`columnDragInFlight` 由一个 App 内 effect 维护：

- `document` 的 `dragstart`（冒泡阶段，此时 `WorkspaceColumn` 已经 `writeDragPayload`）→ `peekDragPayload()?.type === 'column'` 则置 true；
- `document` 的 `dragend` / `drop`（捕获阶段）→ 置 false；
- 为 true 期间每 500ms 调一次 `releaseDragPayloadIfStale(Date.now())`，返回 true（payload 已不在）就置 false。这是为了 pitfall 132（Electron 丢 `dragend`）不把落区永久留在顶栏上。看门狗只在有列拖拽时跑，闲时零开销。

为什么不直接把 `.app-topbar-frame` 当落点：自定义窗框下它整块是 `-webkit-app-region: drag`，Windows 会把它当作非客户区标题栏。HTML5 drop 是否稳定送达存疑，而且没有可见落区用户也不知道能放。所以做一个仅拖列期间出现、`no-drag` 的显式落区，同时在 frame 上挂同样的 `onDragOver/onDrop` 作为兜底（能收到就收，收不到也不影响）。

## 样式（src/index.css）

- `.app-topbar-docked-column`：和 `.app-topbar-add-column` 同一族——透明底、`--ink-3` 文字、hover 到 `--ink-1`、`no-drag`；额外一条 `1px solid var(--line)` 细边和 `999px` 圆角把它和页签区分开；`max-width: 9rem` + 省略号。
- `.app-topbar-dock-zone`：`1px dashed color-mix(in srgb, var(--accent) 55%, transparent)`，文字 `--ink-3`，`is-over` 时背景 `color-mix(in srgb, var(--accent) 14%, transparent)`、边框实线 `--accent`。`no-drag`。
- 全部走 token，不写 `:root[data-theme='dark']` 覆盖。

## i18n（shared/i18n.ts）

- `dockColumnZoneLabel`：`拖到这里收起` / `Drop here to tuck away`
- `restoreDockedColumn(name)`：`恢复工作区 ${name}` / `Restore workspace ${name}`（作为标签的 `aria-label`）

## 已知取舍

- 停靠列里若被自动化看板 / 超管新建了会话，用户看不到，需要自己点顶栏标签。首版不做自动恢复，避免"我刚收起它又自己蹦回来"。
- `removeColumn` 重新分配列宽时把停靠列也算进去，误差极小，不处理。

## 测试

- `tests/column-dock.test.ts`：`dockColumn` / `undockColumn` 四条（写 true、幂等短路、恢复保序、未知 id 短路）+ 旧存档缺 `docked` 解析通过 + `createColumn` 默认不带 `docked`。
- `tests/column-dock.spec.ts`（Playwright）：seed 一列 docked → 顶栏标签可见、看板列数少一 → 点击恢复 → 顺序正确；再从 `.column-headline` 发起拖拽到 `.app-topbar-dock-zone` → 列消失、标签出现。

## 增补（2026-09-10）：停靠标签的状态提示

### 状态从哪来

`selectDockedColumnStatus(column)`（`src/state.ts`）把一列的卡片聚合成两个**相互独立**的布尔量：

- `running` —— 任一卡片 `status === 'streaming'`。
- `hasNewResult` —— 任一卡片 `unread` 或 `completionGlow`。

刻意不合成单一枚举：一列完全可能"一张卡还在跑，另一张已经跑完没看"，压成一个状态就会把后者悄悄吞掉。

### 为什么这里可以用无限动画

仓库有一条硬规则：**streaming 态不许动画**（pitfall 216/218 —— 每个挂载但不可见的 pane 都在给合成器记账，最终 `BrowserWindow unresponsive` 且 JS 栈为空）。`.pane-tab.is-streaming` 正是当年的事故面，它按 pane 数乘。

顶栏 chip 不同的地方只有一个字：**基数**。

- 顶栏全局只有一个，chip 数 = 收起的列数（通常 0–3）。
- 只在该列真的有卡在跑时才附着。
- 不随 pane 数、也不随会话时长增长。

因此它进了 `tests/idle-animation-budget.test.ts` 的 allowlist 并写明理由。这条 allowlist 是**精确集合比对**，新增任何无限动画都会红，不会悄悄放行。

若换成有限次数（如完成光晕那样跑 8 次）反而不对：run 可能持续几十分钟，动画停了但任务还在跑，指示就变成了谎言。

### 停靠列必须退出"自动已读"

`getAutoReadCardIdsForVisiblePanes` 把每个 pane 的活动 tab 当作"用户正看着"。停靠列的卡片仍是它自己 pane 的活动 tab，但**整棵 layout 根本没渲染** —— 不拦的话蓝点会在出现的同一帧被清掉，功能等于没做。

拦截点放在 `App.tsx` 的调用处（`column.docked === true` 跳过），不放进 `pane-read-state`：那个模块只认 layout，不该知道列级的停靠状态。

### 已知取舍：dock/undock 不单独落盘

两个 action 都走裸 `applyAction`，没有跟 `persistAfterAction`。这与旁边的
`reorderColumn` / `setColumnWidths` 是同一种既有写法，不是本切片新引入的。

干净退出时 `flushPendingState`（`usePersistence.ts`）从 `appStateRef.current` 取当前
状态补存，所以正常关闭不丢。真正的风险窗口是「停靠后崩溃或被强杀，且中间没有任何
其他持久化动作」——这种情况下重启会回到未停靠状态。

本次没修的原因：`handleTopbarColumnDrop` 定义在 `persistAfterAction` 之前，直接引用会撞
TDZ，得改成 ref 转发；而且只改 dock 一处会让它和邻近两个同类 action 写法不一致。
要修就三个一起修，那是独立的一次改动，不该塞进发布候选。
