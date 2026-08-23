# 任务拆分

## 切片 1：工具与命令契约（red → green）

- [x] T1.1 改 `tests/automation-board-mcp.test.ts`：工具数 6 → 7，断言 `wake_me_when_sessions_finish`
      的封闭输入 schema（必填只有 `note`，参数只有 `cardIds` / `note` / `timeoutMinutes`）。**先跑，确认红。**
- [x] T1.2 加解析用例：合法参数生成的 `admin-await-sessions` 能过 `workspaceAdminCommandSchema`；
      省略 `cardIds` 得到空数组、省略 `timeoutMinutes` 得到 60；`cardId` 取自 `selfCardId` 而非入参。
- [x] T1.3 加错误用例：缺 `note`、`note` 全空白、`timeoutMinutes` 越界、`cardIds` 含空串、
      拿不到 `selfCardId`，各自报错且不投递命令。缺 `note` 那条额外断言错误文案**不含**
      `cardId is required` —— 只断言"报错了"挡不住 pitfall 294，它确实会报错，只是理由是错的。
- [x] T1.4 加 `callWorkspaceAdminTool` 用例：正常投递；等一个不存在的 cardId 当场报错且不投递；
      工作区没有别的会话时同样报错。
- [x] T1.5 `shared/schema.ts` 新增 `admin-await-sessions` 分支。
- [x] T1.6 `server/automation-board-mcp.js` 新增工具定义 + 解析分支（在 `cardId` 必填检查**之前**分流）
      + 目标存在性校验 + 「投递成功就该闭嘴」的返回文案；`.d.ts` 同步 `selfCardId`。
- [x] T1.7 `server/automation-board-runtime.ts` 中英文提示改成 7 个工具，写清"派活 → 登记等待 → 闭嘴"。
- [x] T1.8 跑测试确认绿。

**红阶段实测**：6 条精确失败，覆盖工具清单、两条解析用例、三条 `callWorkspaceAdminTool` 用例。

## 切片 2：唤醒条件（red → green）

- [x] T2.1 `tests/wake-timer.test.ts` 新增 8 条：显式名单不按忙闲过滤、省略名单等全部其它 agent、
      剔除自己/工具卡/幽灵 id、环检测、空名单拒绝注册、rearm 早退、无关忙碌 peer 不再压住显式名单、
      `wakeAt` 对所有模式生效、owner 停在 error 仍能超时。**先跑，确认红（8 条）。**
- [x] T2.2 `shared/schema.ts` 加卡片字段 `wakeTimerExplicitTargets`；`src/state.ts` 的 `updateCard`
      patch 白名单同步。
- [x] T2.3 `src/components/wake-timer.ts`：新增 `resolveSupervisorWakeTargets`、
      `isWakeTimerConditionReady` 改成"先判上界再按模式分流"、`rearmWakeTimerBatchForPatch` 对显式名单早退、
      `WakeTimerCardSnapshot` 加 `pendingWakeTargetIds`。
- [x] T2.4 跑测试确认绿。

**第一版设计被推翻**：原计划新增 `wakeTimerMode: 'sessions'`，红队核对后发现枚举成员会顺着
`wakeTimerDefaultMode`（每张新卡）与看板模板泄漏出去，且两个模式下拉是硬编码三 option 的
`<select>`（值对不上会渲染成空白选中项，用户一点就擦名单）。改成纯附加的布尔标记后，
UI / i18n / 快照基线一处都不用动。

## 切片 3：渲染进程落位

- [x] T3.1 `src/App.tsx` 执行器新增 `admin-await-sessions` case：解析目标 → 解析不出就当场把 note
      送回去 → 否则 `enqueueWakeTimerSend` 带显式名单。
- [x] T3.2 `enqueueWakeTimerSend` 新增 `explicitTargets` 入口：直接 seed arm 数据、写死
      `wakeTimerMode: 'workspace-agents'`（`duration` 分支完全忽略 pendingTargetIds，卡上残留的旧模式
      会把"等这几张卡"悄悄变成"干等 N 分钟"）；用户自己攒着的批次不被劫持。
- [x] T3.3 三处批次结束一并清掉 `wakeTimerExplicitTargets`。
- [x] T3.4 `validTargetIds` 改为按整个 state 算（跨列拖拽不等于目标完成）。
- [x] T3.5 拓扑签名加入所有卡的 `status` / `backgroundWorkPending`；`nextWakeTimerTimestamp` 覆盖所有批次且只收未来时间戳，避免兜底时间已过后后台完成边界不再触发重扫。
- [x] T3.6 三条终态路径（stopped / `Stream not found.` / 不可恢复错误）补发 forceRelease 放行。
- [x] T3.7 `set_session_wake_timer` 执行器补 `wakeTimerAutoActivated`。
- [x] T3.8 `ChatCard` 待唤醒状态行加显式名单文案。
- [x] T3.9 `pnpm test:quality`（lint + 四份 tsconfig）通过。

## 切片 4：端到端证明

- [x] T4.1 新增真子进程用例：spawn MCP server + 真 loopback bridge，`tools/call` 一路走到
      `dispatchCommand`，断言命令过共享 schema、文案含 `END YOUR TURN`、不含 `undefined`。
      这条覆盖纯函数单测覆盖不到的东西 —— 默认超时与参数名在 `automation-board-mcp.js` 里是抄写的字面量。
- [x] T4.2 全量 `pnpm test` 绿。
- [x] T4.3 新增真实 Electron 运行时用例：派发命令 → 断言 state.json 上的批次/名单/上界/
      **`wakeTimerActive` 未被打开** → 断言待唤醒 UI 出现 → 关掉目标卡让条件满足 →
      断言批次释放且 note 作为一条 user 消息进了超管自己的对话。

**这一条抓到了两个只有真实运行时才暴露的缺陷**：

1. `server/state-store.ts` 的卡片归一化是逐字段重建的白名单，`wakeTimerExplicitTargets`
   落盘即丢 —— 内存与 UI 全对，重启后显式名单退化成"等全列没人在跑"。已修，记入 pitfall 332。
2. `ensureElectronRuntimeBuild()` 只检查产物文件存不存在，于是前两轮跑的其实是**上一次构建的
   renderer**，新命令看起来"完全没反应"。改 `src/` 后必须先 `node scripts/run-vite.mjs build`。
   记入 pitfall 331。
