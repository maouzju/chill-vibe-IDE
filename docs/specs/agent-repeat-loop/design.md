# Agent 循环重复 — 设计

## 数据模型

在共享状态中增加两个布尔字段：

- `AppSettings.repeatLoopEnabled`：功能总开关，默认 `false`；`normalizeAppSettings()` 对旧数据补 `false`。
- `ChatCard.repeatLoopActive`：当前聊天是否参与循环，默认 `false`；服务端持久化恢复显式归一化。
- `ChatCard.repeatLoopRemaining`：当前循环链剩余自动重跑次数；省略表示不限次数，设置为 `0` 时停止。每次完成生成下一 Tab 时递减 1。

`updateSettings` 与 `updateCard` action 的可更新字段同步加入这两个值。复制工作区、导入会话、普通 fork 等创建“另一份任务”的路径不继承活动循环；只有循环专用的新 Tab 明确继承为 `true`。

## 纯逻辑判定

新增 `src/components/repeat-loop.ts`：

- `getEarliestRepeatLoopPrompt(messages)`：按消息顺序找第一条 `role=user` 且文本非空的原文；不读取附件、不使用标题或 assistant 文本猜测提示词。
- `resolveRepeatLoopCompletion(...)`：只有总开关开启、卡片勾选、普通 Agent、完成类型为 `terminal`、且 `queuedSends` / `wakeTimerQueuedSends` 都为空时返回重放提示，否则返回 `null`。

完成判定直接消费现有 `getStreamDonePlan()` 的 `terminal | background-pending | stopped` 结果，不能重复发明文本启发式。

## 新 Tab 状态变更

`ideReducer` 新增 `spawnRepeatLoopTab` action，参数只包含 `columnId`、`sourceCardId` 和预生成的 `cardId`。Reducer 在执行时重新定位来源卡所在 Pane，并原子完成：

1. 以 `createCard()` 创建空白新会话；
2. 复制来源卡的 provider、model、reasoningEffort、thinkingEnabled、planMode；
3. 保持 session、消息、草稿、附件、延后队列和计时队列为空；
4. 写入 `repeatLoopActive: true`，并将有限的 `repeatLoopRemaining` 递减 1；
5. 把新卡追加到同 Pane，但保留当前 active tab，让循环在后台开始，避免抢走用户正在使用的输入框。

显式 `cardId` 让重复 done/重入保护可保持幂等；Reducer 若找不到来源卡、Pane 或发现目标 id 已存在则不修改状态。

## 完成后的调度顺序

`App.tsx` 的 stream `onDone` 继续先结算当前卡消息、运行时长、完成状态和持久化动作。随后在同一批 action 中加入 `spawnRepeatLoopTab`，并在 `appStateRef` 已同步更新后调用现有 `sendMessage()`：

```text
terminal done
  -> 读取最新 liveCard 与全局设置
  -> resolveRepeatLoopCompletion
  -> 结算旧卡 + spawnRepeatLoopTab（一次持久化）
  -> sendMessage(newCardId, earliestPrompt, [])
```

不为循环建立第二套 Provider 请求路径；自动发送复用普通聊天发送逻辑，因此 CLI 路由、模型规则、权限、stream 恢复和标题生成保持一致。

断线恢复若通过 provider 原生落盘记录确认旧 turn 实际已经 `completed`，也走同一套 terminal 判定与新 Tab 调度；`unknown` / `incomplete` 仍只恢复原任务，不能误开循环。

若延后发送或计划唤醒批次仍存在，判定返回空：现有队列先在旧卡继续执行；最终一次完成时队列已空，循环才生成新 Tab。

## 自动鞭策互斥

`ChatCard` 计算有效 Auto-Urge 时，把 `repeatLoopEnabled && card.repeatLoopActive` 视为更高优先级，并同时屏蔽卡片级与全局鞭策。这样旧卡完成后只会产生“新 Tab 重跑”这一条自动链。取消循环勾选后，原有鞭策配置可再次生效。

## UI

- 设置页“实用”增加总开关与一句说明。
- 普通 Agent 聊天的输入框右侧设置按钮打开的 `composer-settings-menu` 中增加 `repeat-loop` 设置行，包含 checkbox、标签和现有提示文案；工具卡不渲染该行。
- 当总开关和当前卡的 `repeatLoopActive` 同时为真时，在聊天正文顶部、消息列表之前显示 `repeat-loop-status`：使用强调色、循环图标和“循环重复已开启”文案，并补充“本轮完成后会自动新建 Tab / 重跑首条提示”的说明。状态提示不是操作控件，取消操作仍从输入框设置菜单完成。
- 勾选循环后在设置菜单显示“重复次数”数字输入框；留空表示不限，输入正整数后按剩余次数递减并在耗尽时自动停止。
- 控件在 streaming 时仍可操作，保证用户能停止下一轮。
- 使用现有 surface / seam / muted / focus token，不增加阴影或装饰；状态提示可以比普通辅助条更醒目，但不覆盖消息内容；窄屏允许说明换行。
- 中英文文案都由 `shared/i18n.ts` 提供。

## 验证

1. 红测：设置默认值与旧数据归一化；卡片默认与持久化恢复。
2. 红测：纯判定仅接受 terminal、找到最早非空用户文本，并受队列/工具卡/总开关保护。
3. 红测：`spawnRepeatLoopTab` 在同 Pane 后台新建、不改变当前 active tab，并正确继承 Agent 配置，同时保持会话与历史为空。
4. UI 定向测试/主题快照覆盖总开关开启后的设置菜单 checkbox 与正文状态提示；检查 light、dark、桌面、窄屏。
5. 运行定向 Node 测试、`pnpm test:quality`、`pnpm test:theme`；随后执行 `pnpm electron:build` 并重启当前开发运行时。
