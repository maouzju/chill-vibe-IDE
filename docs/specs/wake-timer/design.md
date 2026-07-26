# 计时唤醒 — 设计

## 数据模型

在 `shared/schema.ts` 增加：

- `wakeTimerMode`: `workspace-agents | left-tab | duration`
- `AppSettings.wakeTimerEnabled: boolean`，默认 `false`
- `ChatCard.wakeTimerActive: boolean`，默认 `false`
- `ChatCard.wakeTimerMode`，默认 `workspace-agents`
- `ChatCard.wakeTimerDurationMinutes: number`，默认 `30`，范围 `1..10080`
- `ChatCard.wakeTimerQueuedSends: QueuedSendRequest[]`
- `ChatCard.wakeTimerArmedAt?: ISO datetime`
- `ChatCard.wakeTimerWakeAt?: ISO datetime`
- `ChatCard.wakeTimerPendingTargetIds: string[]`

复用 `QueuedSendRequest` 保存提示词与附件元数据，但与 `queuedSends` 分开持久化，避免把现有 FIFO “延后发送”误当成整批计时唤醒。

`createDefaultSettings()`、`createCard()`、卡片复制/恢复与 `normalizeAppSettings()` / 卡片归一化都补齐默认值。非法模式、时长、时间戳和队列条目安全回退；目标 ID 去空、去重。

## 纯逻辑模块

新增 `src/components/wake-timer.ts`：

- 判断工具卡/Agent 卡；
- 找到卡所属 Pane 和直接左邻 Tab；
- 首次入队时生成冻结的 arm 数据；
- 合并同卡批次为一个 Provider 请求；
- 生成 UI 摘要；
- 判断时间条件和目标条件是否已满足；
- 从正常完成的目标卡中移除等待 ID。

合并规则：按入队顺序保留每条非空用户原文，使用空行组合为一个 prompt；不得向 Provider 注入“待唤醒消息 N”或“Scheduled message N”等 UI/内部标签。附件按原顺序平铺；只有附件的批次允许 prompt 为空。

## 发送与调度

`SendMessageOptions` 增加 `origin: user | auto-urge | wake-timer-release`。

`App.sendMessage()` 顺序：

1. 先处理本地斜杠命令；
2. ask-user 回答沿用现有立即停止/回答路径，不进入计时器；
3. 若总开关开启、卡片计时器开启、来源为普通用户，则上传完成后的消息进入 `wakeTimerQueuedSends` 并立即持久化；
4. 首条计时消息冻结模式：
   - workspace：记录同列中当时 `status=streaming` 的其他 Agent 卡 ID；
   - left-tab：记录同 Pane 直接左邻且当时 `status=streaming` 的 Agent 卡 ID；左邻已 idle 时目标数组为空，可立即释放；无有效左邻时拒绝武断排队并保留 composer 错误提示；
   - duration：写入 `wakeTimerWakeAt`；
5. 后续消息只追加队列，不改 arm 数据；
6. 来源为自动鞭策或计时器释放时绕过该分支。

释放过程先读取就绪批次。工作区模式除检查冻结的 `wakeTimerPendingTargetIds` 外，还要实时扫描同列所有非工具 Agent；只要存在其他 `status=streaming` 的 Agent 就继续等待，避免恢复旧数据、并发状态更新或漏记目标导致提前唤醒。确认就绪后，再通过一组 `updateCard` action 原子清空所有就绪卡的队列与 arm 数据，最后 `Promise.all` 调用 `sendMessage(..., { origin: 'wake-timer-release' })`。这样多卡同一轮检查可同时启动，并且重复 effect/timeout 不会二次发送。

## 完成判定与自动鞭策避让

只在 stream 的正常 `onDone` 路径安排“稳定完成检查”；手动停止和错误路径不安排。

稳定窗口取 `1200ms`，覆盖当前自动鞭策的 `800ms` 延迟：

1. 正常回答结束后安排检查；
2. 1200ms 后目标卡仍为 `idle`，才从所有等待它的 `wakeTimerPendingTargetIds` 中移除；
3. 若期间自动鞭策、普通队列或新用户消息启动了新 stream，卡片不再 idle，本次不计完成；
4. 后续 stream 正常结束后重新安排检查；最终没有再触发鞭策时才真正完成。

指定时长使用最近目标时间的单次 `setTimeout`。到时若拥有计时批次的卡仍在 streaming，则等待该卡稳定 idle 后再释放，避免中断自身正在进行的回答。

## UI 与数据流

设置页“实用功能”增加总开关和简短说明。

`App → WorkspaceColumn → LayoutRenderer → PaneView → ChatCard` 传递 `wakeTimerEnabled`。`PaneView` 额外为每张活动卡计算：

- 左邻 Agent 是否有效及显示标题；
- 同工作区其他 Agent 数量。

composer 设置菜单顶部增加一个安静的 `.composer-wake-timer-module`：

- 计时器 checkbox；
- 触发模式 select；
- duration 模式的分钟输入；
- 左邻不可用提示；
- 批次存在时禁用配置并说明“当前批次已锁定”。

composer 输入框上方增加待唤醒状态行，与现有延后发送状态并列但视觉层级保持克制：数量、条件/剩余时间、立即唤醒、取消。

所有颜色使用 `src/index.css` 现有 token；菜单不增加多余阴影/双重边框。窄屏下状态行允许换行，动作保持可点击。

composer 设置菜单使用 portal 固定定位，并在计时器开关、模式切换或卡片尺寸变化后重新测量。菜单高度受卡片与视口可用空间共同约束；内容放不下时仅菜单内部滚动，不能越过卡片或窗口底边。

## 验证

- 严格红绿测试：schema/default/normalize、冻结目标、左邻解析、批次合并、到时判定、正常完成清理。
- 现有状态 reducer 测试覆盖新字段 patch/reset/复制行为。
- `pnpm test:quality`。
- `pnpm test:theme`；若仓库已知 Playwright runner 噪声阻断，则记录真实失败并使用可运行的定向 UI harness/截图检查 light、dark、桌面、窄屏。
- 功能完成后 `pnpm electron:build`，并按当前开发面重启运行时。
