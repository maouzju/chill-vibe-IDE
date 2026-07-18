# Provider Run Resource Guard — Requirements

## Context

2026-07-18 的一次打包版闪退没有留下 `before-quit`、`process exit`、`render-process-gone`、Windows WER 或 dump；旧主进程在多路 Codex 任务运行时直接消失。重启后的同类工作负载显示：9 个流会拉起约 5 GB 的 Electron/Codex/MCP 后代进程。现有多窗性能契约只验证到 6 个并行 Codex 卡片，但后端会无上限地同时启动 provider 进程。

## User goal

继续支持多卡并行工作，同时避免一批重任务把 Electron 主进程和整棵子进程树推到无保护的资源尖峰。

## Functional requirements

1. Electron/web 后端的 `ChatManager` 必须对**实际运行中的 provider turn**设置有界并发；默认上限为 6，与现有多窗压力验收场景一致。
2. 超出上限的新流必须保持 FIFO 排队，不能丢用户消息、伪造失败或提前启动 provider 子进程。
3. 排队流必须通过现有 `log` 事件给卡片一条简短可见提示；获得槽位后自动开始，无需用户重试。
4. provider 正常结束、报错、启动失败或用户停止时必须可靠释放槽位并启动下一条队列。
5. 用户停止尚未启动的排队流后，该流永远不能在后续槽位释放时被启动。
6. `closeAll()` 必须清空排队项并停止已启动子进程，不能在窗口关闭后继续补启动 provider。
7. 保留环境变量逃生口 `CHILL_VIBE_MAX_CONCURRENT_PROVIDER_RUNS`，允许高级用户/测试把上限调整为正整数；非法值回退默认值。
8. 不新增持久化字段。崩溃后仍沿用现有 interrupted-session 恢复流程。
9. Electron 主进程日志必须定期记录轻量资源心跳（系统剩余内存、主进程内存、Electron 进程总内存/数量），这样即使主进程被硬终止，最后一条心跳仍可区分资源压力与普通 JS/renderer 异常；心跳不得阻止进程退出。

## Non-goals

- 不限制单个 Codex 会话内部自行启动的子代理或工具进程。
- 不实现完整的 Windows Job Object / 每进程内存配额。
- 不改变 provider 的会话语义、消息上下文或恢复协议。

## Acceptance

- 上限为 2 时创建 3 条流，前两条启动，第三条只排队；任一运行流结束后第三条自动启动。
- 排队流在启动前被停止，释放槽位后也不会启动。
- 默认上限为 6，环境变量可覆盖，非法值安全回退。
- 资源心跳的单位换算和 Electron 多进程聚合有纯函数测试，定时器使用 `unref()`。
