# 设计：超管 MCP 等待会话结束

## 复用计划唤醒，不新造完成事件总线

本仓库里「唤醒」的定义已经很具体：**把一条排队的消息按条件释放出去**
（`flushReadyWakeTimers`，`src/App.tsx:3010`）。超管想要的「子节点跑完叫醒我」，
在这个定义下就是一条 note 入队 + 一组等待目标 —— 与用户右键「延后发送」是同一台机器。

所以这条命令走的仍是超管写命令的既有 7 段链路，唯一新增的是渲染端的一个 case：

```
CLI 子进程 (automation-board-mcp.js)
  → POST /command            server/automation-board-bridge.ts:216
  → workspaceAdminCommandSchema.safeParse
  → dispatchCommand          server/automation-board-session.ts:108
  → utilityProcess RPC       electron/utility-host.ts:139
  → broadcastToLiveRenderers electron/main.ts:207
  → CustomEvent              electron/preload.ts:51
  → 渲染进程执行器            src/App.tsx:5514（新增 admin-await-sessions）
  → enqueueWakeTimerSend     src/App.tsx:2927（新增 explicitTargets 入口）
```

**被否决：新造一条「超管订阅完成事件」的机制。** 它会逐条重新发明
`wakeTimerQueuedSends` / `wakeTimerPendingTargetIds` / 完成广播 / owner-idle 门 /
取消回填草稿 / 重启恢复 / 待唤醒 UI 这七件已经存在、且已被真实回归打磨过的东西
（左邻链式接力、待唤醒卡不算完成、autoActivated 关开关……），用户可见效果却完全相同。
而且「直接给超管发一条系统消息」违反唤醒链的既定约束：释放走的是
`origin: 'wake-timer-release'` 的普通 user 消息，刻意不注入任何系统文案。

## 关键设计决定

### 1. 等待名单用一个布尔标记，**不是**第四种 `wakeTimerMode`

第一版设计是给 `wakeTimerModes` 加 `'sessions'`。否决，因为枚举成员会顺着三条路泄漏：

| 泄漏路径 | 后果 |
|---|---|
| `wakeTimerDefaultMode`（`shared/schema.ts:776`，每张新卡都盖这个章） | 普通卡拿到一个自己永远算不出等待名单的模式 → 第一条延后消息立刻发车，右键「延后发送」当场失效 |
| 看板模板的 `wakeTimerMode`（`shared/schema.ts:883`，卡↔模板互抄） | 超管卡恰恰是最可能被存成模板的那张，模式会复制到每一个未来实例 |
| 两个硬编码三 `<option>` 的 `<select>`（`WakeTimerStatus.tsx:76`、`WakeTimerSettingsPanel.tsx:81`） | `value` 对不上任何 option → 渲染成空白选中项，用户随手一点就把名单擦了 |

改用 `wakeTimerExplicitTargets?: boolean`（`shared/schema.ts:266` 附近）：纯附加字段，
旧包读到只是忽略它、退回原有的拓扑判据，不会像未知枚举值那样让归一化改写或校验失败。
表达上界用的是已存在的 `wakeTimerWakeAt`，表达目标用的是已存在的
`wakeTimerPendingTargetIds` —— 两条都已经有持久化、有 UI、有释放逻辑、有取消路径。

### 2. `wakeTimerWakeAt` 从 `duration` 独占提升为**所有批次的硬上界**

`isWakeTimerConditionReady`（`src/components/wake-timer.ts`）原本只在 `duration` 分支读
`wakeAt`。现在改成先判上界、再按模式分流。另外三种条件的 `wakeAt` 恒为 `undefined`，
所以这一步对它们是空操作。

**这不是可选的保险**：完成广播 `scheduleStableWakeTimerCompletion` 只挂在**正常终态**上
（`src/App.tsx:5004`），被打断、报错、或从没开跑（standby 泳道）的目标永远不会报告完成。
没有上界就是一次永久挂起。配套的两处：

- `nextWakeTimerTimestamp`（`src/App.tsx:3221`）去掉 `mode === 'duration'` 过滤，
  否则这条上界没有任何定时器去触发它；
- 同一个 memo 只收**未来**的时间戳。一个已经过期却仍不满足释放条件的批次会把它永久钉在
  同一个过去的值上，effect 依赖不变 → 此后再也不排任何定时器，**别人的兜底超时被它一起拖死**。

### 3. 目标进入终态时显式放行等待方

只有上界还不够：一小时的空等在体感上就是"这功能坏了"。所以在三条终态路径上补发
`buildWakeTimerTargetReleaseActions(cardId, { forceRelease: true })`：被用户停止
（`donePlan.kind === 'stopped'`）、`Stream not found.`、以及不可恢复错误。

语义与既有的 `cancelWakeTimerBatch`（`src/App.tsx:2855`）完全一致：那张卡不会再自己跑，
下游继续等它就是永久卡死。最讽刺的组合是超管在等 B、用户看不下去把 B 停了，超管从此醒不过来。

### 4. 等待名单**不按忙闲过滤**

`armWakeTimerBatch` 的两种拓扑模式都只冻结"当时真忙"的卡，这里刻意反着来：刚被
`create_session` 建出来的卡还没进 `streaming`，按忙闲筛会让名单当场为空 →
本轮一结束就自唤醒 → 这个工具就废了。

`resolveSupervisorWakeTargets`（`src/components/wake-timer.ts`）只剔四类：自己、工具卡、
已经不存在的 id，以及**正在等 owner 的卡**。

最后一类是环检测。`workspace-agents` 靠"不把待唤醒算作忙"规避成环、`left-tab` 靠严格更小的
Tab 索引天然无环，而显式名单是任意集合，两条护栏都没有：A 等 B、B 等 A 时两边都不再产生回合、
也就都不会广播完成，只有兜底超时能拆开。与其让两个超管互相钉住一小时，不如在这里把对方摘掉。

名单解析后为空时**不注册**，执行器当场把 note 送回去 —— 与其留下一个 0 秒等待，
不如让超管立刻醒来发现工作区是空的。MCP 侧还有一道更早的闸（见第 6 条）。

### 5. 不写 `wakeTimerActive`

`shouldQueueWakeTimerSend` 只看 `cardActive`：一旦超管卡上这个开关是开的，
**用户自己发给超管的每一条消息**都会被吞进同一个批次，直到所有目标跑完才一起投递。
那正是 2026-08-16「streaming 久了消息自动变延后」那条回归的形状，只是这次是 Agent 替用户拧的开关。

而释放判据（`flushReadyWakeTimers`）根本不读 `wakeTimerActive`，待唤醒 UI 也只看
`wakeTimerQueuedSends.length > 0`。所以只写批次和 arm 数据：功能一样全，用户消息照常立即发送。

### 6. `cardIds` 的存在性校验放在 MCP 侧

命令是**单向投递**的，渲染端没法把"这个 cardId 没有对应会话"回传。而工作区镜像就在
MCP 进程手边（`context.fetchWorkspace()`），所以在 `postCommand` 之前先核一遍：
写错的 id、或者根本没有别的会话，都当场以工具错误返回。否则超管会以为自己在等，
实际是空等到超时。

### 7. `set_session_wake_timer` 顺手补上来源标记

这条既有命令只 patch `wakeTimerActive`，且**不写** `wakeTimerAutoActivated`，于是批次释放后
开关永远不关回去 —— 那张卡从此把每一条普通消息都吞进待唤醒队列，**包括超管自己随后发过去的
「鞭策」**（`sendToItem` 走的是 `origin: 'user'`）。一行修复，与新工具同批交付，
否则超管手里会同时握着一个真工具和一个会把另一个工具打瘸的假工具。

（把它改成"真能唤醒别人"不在本次范围：那需要超管能往任意会话塞一条未来消息，
与「谁被唤醒必须可预测」这条边界正面冲突。）

### 8. 归一化白名单改成按枚举判定

`server/state-store.ts` 的 `normalizeWakeTimerMode` 原本是硬编码的
`'left-tab' | 'duration'` 字面量白名单 —— 任何新模式一读盘就被静默改写成
`workspace-agents`。本次虽然最终没有新增模式，这个坑仍然照修：它是"配置写进去了但产物不同步"
那一类最难查的 bug，而 TypeScript 对 `unknown` 归一化一个字都管不到。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `shared/schema.ts` | `admin-await-sessions` 命令 + 卡片字段 `wakeTimerExplicitTargets` |
| `server/automation-board-mcp.js` | 工具定义、`selfCardId` 入参与分流、目标存在性校验、投递文案 |
| `server/automation-board-mcp.d.ts` | 解析函数新增 `selfCardId` |
| `server/automation-board-runtime.ts` | 中英文系统提示：6 个工具 → 7 个，并写清"注册完就结束回合" |
| `server/state-store.ts` | `normalizeWakeTimerMode` 改为按 `wakeTimerModes` 判定 |
| `src/components/wake-timer.ts` | `resolveSupervisorWakeTargets`、通用上界、rearm 早退、owner-error 放行 |
| `src/state.ts` | `updateCard` patch 白名单加新字段 |
| `src/App.tsx` | 执行器 case、`enqueueWakeTimerSend` 显式名单入口、全局 `validTargetIds`、签名加 status、定时器覆盖所有批次、三条终态放行 |
| `src/components/ChatCard.tsx` | 待唤醒状态行的显式名单文案 |
| `tests/automation-board-mcp.test.ts` | 工具契约、命令契约、错误路径、真子进程端到端 |
| `tests/wake-timer.test.ts` | 目标解析、环检测、通用上界、owner-error、rearm 早退 |

## 验证策略

- Tier 1，`red → green`。两批测试都先跑出精确失败（MCP 侧 6 条、wake timer 侧 8 条）再实现。
- 命令 schema 的正确性由「真子进程生成的命令过一次共享 zod schema」这条端到端用例保证 ——
  `automation-board-mcp.js` 里的默认超时与参数名都是**抄写**的字面量，
  纯函数单测断言的两边是同一份抄写，抓不住漂移。
- 渲染进程执行器不在 Node 单测覆盖内（依赖 React 运行时），按仓库既有惯例由
  `pnpm test:quality` 的类型检查保证 discriminated union 的 case 完备性。
