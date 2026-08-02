# 原生 Agent 完成边界 — 设计

## 原生信号

### Claude

为 Electron keepalive CLI 注入一个安静的 `Stop` command hook。Hook 从 stdin 接收 Claude
原生 JSON，并把完整输入写入该卡片专属的小型 sidecar。每轮开始前删除旧 sidecar；因此
`result` 到达时，只有本轮成功运行的 Stop Hook 才能提供有效快照。

读取字段：

- `background_tasks`: `subagent | workflow | shell | teammate | monitor | cloud session | MCP task`
- `session_crons`: `CronCreate | ScheduleWakeup | /loop` 创建的会话级唤醒

任一数组非空即为 `background-pending`；两者都为空为 `terminal`。Sidecar 缺失、损坏或 Hook
不可用时返回 `unknown`，provider 按兼容策略把它当作 `terminal`。

Hook 只写 sidecar，不向 stdout 输出内容，不给 Claude 注入额外上下文。Windows 使用系统自带
PowerShell 非交互读取 stdin 并写 UTF-8；POSIX 使用 `umask 077; cat > file`。路径按 cardId
稳定生成并保存在 Claude pool entry meta 中，同一卡片复用进程时复用路径，换进程前清空旧文件。

### Codex

不增加新协议。Codex app-server 的根线程与子线程继续按 `threadId` 分流，`wait_agent` 在根 turn
内部等待 mailbox；子线程完成只更新 agent tracker，根完成仍由现有 deferred-root-completion
保护。本 SPEC 的共享完成字段对未提供值的 Codex流默认为 `terminal`。

## 流协议

扩展 `StreamEventMap.done`：

```ts
done: {
  stopped?: boolean
  completion?: 'terminal' | 'background-pending'
}
```

字段可选以兼容旧 backlog、旧 Electron bridge 和普通 web/Codex 路径。

Claude parser 在干净 `result` 时读取 Stop sidecar，并通过 `sink.onDone({ completion })` 传给
ChatManager。ChatManager 原样写入 done envelope；renderer 缺失字段时按 `terminal` 处理。

## 卡片运行时状态

`ChatCard.backgroundWorkPending?: boolean` 是运行时字段，行为仿照 `completionGlow`：

- Claude 中间暂停：`true`
- unsolicited 续写期间：保持 `true`
- 最终完成、手动停止、用户新请求覆盖、不可恢复终端失败：清为 `false`
- 持久化归一化时丢弃，重启后为 `undefined/false`

pool entry 同步记录当前是否处于 `background-pending`。若 CLI 在无活动 stream 的等待期
意外退出，或到达 idle 回收期限，ChatManager 创建一次终端 error stream 通知 owning card，
从而清除等待标记并给出明确失败提示；普通已完成 idle entry 的退出仍保持静默。

中间暂停仍将 `status` 设为 `idle` 并清除 `streamId`，让 keepalive 的原生
task-notification 可以附着新 stream；`backgroundWorkPending` 负责表达“逻辑工作仍未结束”。

## 最终回调门控

renderer `onDone` 先区分：

- `stopped`: 现有停止路径，清理等待状态，不播放成功回调；
- `background-pending`: 仅结算当前 transport stream，保留逻辑运行起点与排队任务；
- `terminal`: 执行现有成功完成路径。

`background-pending` 明确跳过：

- `getCompletionSoundPlan`
- `flashWindowOnce`
- `completionGlow: true`
- `consumeRunDurationMessage`
- `scheduleStableWakeTimerCompletion`
- `dispatchNextQueuedSend`
- `scheduleAllAgentsDoneSound`

ChatCard 的 Auto-Urge effect 在 `backgroundWorkPending` 时跳过。全完成检测与 wake-timer 的
目标忙闲快照把该字段纳入判断，避免其他卡片的完成定时器从侧面误判。

## unsolicited 与 sidechain

Claude keepalive 空闲输出采用严格 turn-start gate：

- 只有 `type=stream_event` 且 `event.type=message_start`、同时顶层
  `parent_tool_use_id` 为空，才创建 unsolicited stream；
- `system/init` 只缓存为前导信息，不直接开流；
- 已知 bookkeeping 不开流；
- 非空 `parent_tool_use_id` 在 idle 和 turn-active 两种状态都直接丢弃。

真实 task-notification 会先产生 bookkeeping/init，随后产生顶层 `message_start`，因此仍能正常
唤醒并回放前导行；子 Agent sidechain 即使包含自己的 init，也不能提前获得 owner-card attachment。

## 测试策略

1. `buildClaudeArgs` 红测：Stop hook 与已有 PreToolUse hook并存，关闭安全 Hook不影响完成 Hook。
2. Stop sidecar 解析红测：后台任务、session cron、空数组、缺失/损坏快照。
3. Claude parser 红测：pending result 发 `background-pending`，最终 result 发 `terminal`。
4. renderer/helper 红测：pending 卡不算全完成、不释放 wake target、不触发 Auto-Urge。
5. pool 红测：system init不唤醒；顶层 message_start唤醒；active attachment 继续丢弃 sidechain。
6. Codex agent tracker回归：子线程完成不结束父流，最后子线程结算后只释放一次根完成。
7. 定向测试后运行 `pnpm test:quality`、`pnpm electron:build`，并重启当前 Electron dev runtime。
