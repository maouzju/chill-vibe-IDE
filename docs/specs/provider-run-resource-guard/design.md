# Provider Run Resource Guard — Design

## Placement

资源闸门放在 `server/chat-manager.ts`，而不是 React：web 与 Electron 共用同一条 provider 启动路径，且只有后端知道子进程何时真正启动/结束。

## Model

`ChatManager` 新增：

- `maxConcurrentProviderRuns`：构造参数优先，否则读取环境变量，最终默认 6。
- `activeProviderRuns`：当前已占槽位且尚未收到终止信号的流数。
- `providerStartQueue`：FIFO 保存 `{ stream, request }`。

`createStream()` 仍同步创建 stream/backlog 并返回 stream id，但改为调用 `scheduleProviderStart()`：

- 有空槽：占槽后异步执行现有 `startProvider()`。
- 无空槽：入队，并发出本地化 `log` 提示。

## Slot lifecycle

每个 `StreamRecord` 记录 `providerSlotHeld`，释放函数幂等：

- `onDone` / `onError` 收到 provider 终止信号时先释放槽位，再做工作区 diff 和最终事件。
- provider 启动抛错时释放槽位并把流以普通错误收束，避免未处理 Promise rejection。
- `stop()` 对运行流杀子进程并释放；对排队流只标记终止，队列 drain 时跳过。
- `closeAll()` 先进入 closing 状态并清空队列，防止释放槽位时补启动。

槽位释放后用 microtask/直接 drain 启动 FIFO 下一条；drain 会跳过已 terminal / stopRequested 的记录。

## UX

复用现有 `log` stream event，中文提示为“并行任务已达上限（N），此会话已排队，将在有空位时自动开始。”；英文提供对应文案。这样无需新增 schema/UI，消息会按现有 system log 样式进入卡片。

## Hard-exit forensics

新增纯函数 `electron/resource-heartbeat.ts` 聚合 Node `process.memoryUsage()`、`os.freemem()/totalmem()` 和 `app.getAppMetrics()`。`electron/crash-logger.ts` 初始化后立即记录一次，随后每 2 分钟记录一次并对 timer 调用 `unref()`。心跳只进现有 `main.log`，不跨 IPC、不写应用状态。

## Risk and rollback

- 行为变化仅发生在第 7 条及以上并行 provider turn；前 6 条与现状一致。
- 环境变量可临时调高或关闭实际约束（设置足够大的正整数）。
- 不触碰保存数据，回滚只需移除 ChatManager 调度层。
