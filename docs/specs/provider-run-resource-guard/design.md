# Provider Run Resource Forensics — Design

## ChatManager behavior

恢复 `ChatManager` 的直接启动语义：`createStream()` 创建 stream/backlog 后，对每条流独立调用 `startProvider()`，不维护 active count、slot 或 FIFO 队列。

保留一个必要的可靠性改进：`startProvider()` 的 Promise 必须有 `.catch()`。启动前的 workspace snapshot、CLI 解析或 spawn 若抛错，catch 将其转换成当前 stream 的本地化 `error` 事件。这样不限制并发，也不会让启动异常变成 Electron 主进程的未处理 rejection。

测试继续允许注入 `workspaceSnapshotter` / `workspaceDiffer`，避免并发测试被真实 Git 扫描速度污染。

## Hard-exit forensics

保留 `electron/resource-heartbeat.ts`：聚合 Node `process.memoryUsage()`、`os.freemem()/totalmem()` 和 `app.getAppMetrics()`。`electron/crash-logger.ts` 初始化后立即记录一次，随后每 2 分钟记录一次并对 timer 调用 `unref()`。

心跳只记录客观资源数据，不自动推断原因。若再次硬退出，应结合最后心跳、当时流量、子进程树和 Windows 事件再选择修复切片。

## Rollback

- 移除此前的 `maxConcurrentProviderRuns`、`activeProviderRuns`、`providerStartQueue`、slot 生命周期和排队文案。
- 删除 `CHILL_VIBE_MAX_CONCURRENT_PROVIDER_RUNS`，避免留下看似可调、实则违背产品定位的行为。
- 保留资源心跳和启动异常收束，两者不改变正常会话并发能力。
