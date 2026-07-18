# Provider Run Resource Forensics — Requirements

## Context

2026-07-18 的一次打包版硬退出没有留下 `before-quit`、`process exit`、`render-process-gone`、Windows WER 或 dump。现场虽然有多路 Codex 任务，但用户明确确认 VSCode Codex 插件长期同时运行十几个会话也没有问题，因此“并发数量本身导致闪退”的结论证据不足，不能以限制并发作为修复。

## User goal

Chill Vibe 必须继续发挥并行 IDE 的核心价值：十几个 Codex 会话可以同时立即运行，不得因为一次原因未明的闪退被强制排队。

## Functional requirements

1. `ChatManager.createStream()` 不得设置固定并发上限、资源槽位或 provider 启动队列。
2. 创建多条有效流时，每条流都必须立即进入既有 provider 启动路径；不得出现“并行任务已达上限”提示。
3. provider 启动 Promise 抛错时必须收束为该流的普通 `error` 事件，不能形成未处理 Promise rejection。
4. 保留 Electron 轻量资源心跳（系统剩余内存、主进程内存、Electron 进程总内存/数量），为下一次硬退出留下客观证据；心跳 timer 必须 `unref()`。
5. 后续资源优化必须针对已证明的 Chill Vibe 额外放大路径，不得用降低用户并发能力代替根因修复。

## Non-goals

- 不限制 Codex 会话数、子代理数或工具并行数。
- 不把本次无 dump 的硬退出武断标记为 OOM。
- 不改变 provider 会话语义、消息上下文、恢复协议或持久化 schema。

## Acceptance

- 同步创建 12 条流，12 条 provider launcher 均立即被调用。
- 任一 provider launcher 抛错，只终止自己的流，其他流仍正常启动。
- 旧的并发上限环境变量、排队提示和 FIFO 调度代码全部移除。
- 资源心跳聚合测试继续通过。

