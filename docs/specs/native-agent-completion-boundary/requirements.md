# 原生 Agent 完成边界 — 需求

## 背景

Claude Code 的后台子 Agent 默认允许主 Agent 先结束当前回复，随后通过
`task-notification` 在新 turn 中继续。Claude 原生 `Stop` Hook 会同时提供
`background_tasks` 与 `session_crons`，用于区分“整项工作完成”和“只是暂停等待后台工作”。

Chill Vibe 当前把每个干净的 provider `result` 都当成最终完成，导致等待子 Agent
期间错误播放完成音效、闪窗、释放计时唤醒、发送延后消息、触发 Auto-Urge、追加多条运行时长，
并可能把子 Agent sidechain 输出误当成主 Agent 的 unsolicited turn。

Codex 原生采用独立子线程与 `wait_agent`：子线程完成不等于根线程完成，根线程等待时应保持
同一逻辑 turn，最终只完成一次。

## 需求

1. Claude Electron keepalive 路径必须读取原生 `Stop` Hook 的 `background_tasks` 与
   `session_crons`，不得用回复文本猜测是否仍在等待。
2. 当任一数组非空时，本次 `result` 只表示**中间暂停**：卡片可暂时回到 idle 以等待原生
   task-notification，但不得触发最终完成回调。
3. 中间暂停不得播放单 Agent/全 Agent 完成音效、闪窗、显示完成呼吸光、释放计时唤醒目标、
   发送延后消息、触发 Auto-Urge或消费运行时长起点。
4. 最后一个后台任务结束、主 Agent 完成汇总且两个数组都为空时，以上最终完成回调只触发一次，
   并只追加一条覆盖整个逻辑运行周期的时长总结。
5. “全 Agent 完成”判定与计时唤醒忙闲判定必须把等待 Claude 原生后台工作的卡片视为未完成，
   即使其当前没有活动 stream。
6. 用户手动停止、显式发送新消息覆盖等待链、终端错误或卡片删除时，不得遗留虚假的后台等待状态。
7. Claude 空闲期只有真正的顶层 assistant `message_start` 才能创建 unsolicited stream；
   `system/init`、task bookkeeping 和子 Agent sidechain 本身不得提前唤醒主卡片。
8. 已附着 stream 仍必须过滤带非空 `parent_tool_use_id` 的子 Agent sidechain，避免一次误附着后
   将多个子 Agent 的命令、思考和回答混入主卡片。
9. Codex 路径保持原生根/子线程隔离：子线程 `turn/completed` 不触发根卡片完成；根线程使用现有
   `wait_agent`/mailbox 语义，不新增 Claude 式 unsolicited 唤醒。
10. 旧客户端/旧 Claude CLI 或 Hook 读取失败时必须兼容：缺少原生边界信息时保持当前 fail-open
    终止行为，不能把卡片永久留在等待状态。
11. 后台等待标记仅是运行时状态，不得持久化到 `state.json`，应用重启不得复活已经失去进程的等待链。

## 验收标准

- 一个 Claude 主 Agent 启动两个后台子 Agent 后先结束回复：卡片无完成音效/闪窗/唤醒释放/
  Auto-Urge/时长总结，且被全完成检测视为仍在工作。
- 第一个子 Agent 返回并触发主 Agent 续写后仍有一个后台任务：仍不触发最终完成回调。
- 最后一个子 Agent 返回并完成最终汇总：只触发一次最终完成回调，只出现一条总时长。
- 空闲期子 Agent sidechain 与 `system/init` 不会单独打开主卡 stream；真正顶层
  `message_start` 会正常打开并回放必要的原生前导事件。
- Codex 根/子线程完成隔离测试继续通过。

