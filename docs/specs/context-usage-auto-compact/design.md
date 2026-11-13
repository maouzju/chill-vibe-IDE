# 上下文占用显示 + 快满自动压缩 — 设计

## 数据：新流事件 `context_usage`

```ts
type StreamContextUsageEvent = { used?: number; size?: number; reset?: true }
```

- `used`：最近一次主线程请求的占用。`size`：上下文窗口。`reset`：刚压缩过，占用清成未知。
- 服务端出口：`StreamSink.onContextUsage?` → `chat-manager` 的 `emit(stream, 'context_usage', …)`。
  backlog 里用固定合并键（只留最后一条），否则长回合会把 2000 条 backlog 挤满。
- Electron 桥是通用转发，不用改；`src/api.ts` 的分发链加一个分支。

### Claude（实测 CLI 2.1.233）

| 事件 | 取值 |
| --- | --- |
| `stream_event` / `message_start` | `event.message.usage`，请求一发出就有输入侧 |
| `stream_event` / `message_delta` | `event.usage`（不是 `delta.usage`），补上最终输出 |
| `result` | `modelUsage[*].contextWindow` → `size` |
| `system` / `compact_boundary` | `reset`；`trigger !== 'manual'` 时另发 `compaction` 活动 |

只认 `parent_tool_use_id` 为空的事件（主线程）。`message_delta` 没带输入侧字段时不报，避免占用骤降成只有输出。
手动 `/compact` 回合**不发** `compaction` 活动：渲染端已经为用户敲的 `/compact` 建了边界，再发会重复。

被否决：把阈值传给 CLI（`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`）——实测 `-p` 模式下不生效。
被否决：用 `compact_metadata.post_tokens` 当压缩后占用——实测 891，而下一次请求真实输入侧 45261
（它不含系统提示和工具定义）。

### Codex（协议 0.147.0 `codex app-server generate-ts`）

`thread/tokenUsage/updated`：`used = tokenUsage.last.totalTokens`，`size = tokenUsage.modelContextWindow`。
只认根线程（`threadId === emittedSessionId`）。手动压缩请求期间不上报用量，压缩活动完成时发 `reset`。
未实测真实线上载荷（本机中转站 401），按「乱序也安全」写。

## 渲染端

- **外部 store**（`src/components/context-usage-store.ts`，模块级 Map + `useSyncExternalStore`）。
  被否决：放进 reducer / 卡片字段——每个 token 更新都会走持久化队列和整条 memo 链（pitfall #265/#256/#317）。
- **持久化**：回合结束时把 store 里的值写进 run-duration 消息的 `meta`（`contextUsageUsed` / `contextUsageSize`）。
  store 没有这张卡的条目时（重启后）从消息里读最后一条带这两个键的。不新增卡片字段。
- **指示器**：`ContextUsageIndicator` 放在 `.composer-actions` 最前面。SVG 圆环，≥ 阈值的 7/8 变警示色，
  ≥ 阈值变危险色。无数据不渲染。无无限动画。
- **悬停说明**：复用 `HoverTooltip`。它默认的气泡以锚点为中心向两边展开，而圆环贴着卡片右下角，
  2026-11-12 Playwright 实测右缘伸出卡片约 50px，被 `.card-shell` 的 `overflow: hidden` 裁掉。
  只改这一个气泡的定位（`src/index.css`）：锚点退回 `position: static`，气泡以 `.composer` 为包含块，
  贴右缘、浮在输入区上方、宽度不超过输入区（窄卡里折行，不出卡片）；小箭头对不准圆环，不画。
  被否决：改通用的 `.git-hover-tooltip`——发送按钮和 Git 卡也在用；portal 到 `body` 再手写夹紧——
  一个纯文字气泡不值得再抄一遍斜杠菜单那套定位。

## 自动压缩

判定是纯函数 `shouldAutoCompactBeforeSend`，由 `App.tsx` 的 `sendMessage` 空闲分支调用（pitfall #351：
「回合边界自动做点什么」不挂在 `ChatCard` 的 effect 上）。

流程：命中 → 用户消息进延后队列 → 以 `origin: 'auto-compact'` 发一轮 `/compact` → 该回合 `done` / `error`
都会 `dispatchNextQueuedSend`，用户消息自动发出。

- 边界消息：隐藏的 `/compact` user 消息，`trigger: 'auto'`，并带 `compactRunStreamId = 本回合 streamId`。
  后面跟一条可见的系统日志行说明「占用 N%，先压缩」。
- **等待而不打断**：`shouldWaitForCompactionBeforeSending` 多认一种情况——最新 user 消息是带
  `compactRunStreamId` 的边界，且它等于卡片当前 `streamId`。回合一结束 `streamId` 就变，不会像
  2026-08-16 那次一样把后续所有发送都卡成排队。
  被否决：新增运行期 ref——清理点有 8 处以上，漏一处就是永久排队。
- **防连环**：`autoCompactAttemptedRef`（Set）记「刚尝试过」，紧跟的下一次发送消费掉它且不触发；
  store 记压缩后第一次占用为 `baselineUsed`，占用增长不足窗口 10% 不触发。
- **静默**：自动压缩回合的 `done` 不响提示音、不闪窗、不标未读、不亮完成光、不走循环发送和唤醒完成。
- **失败**：不安排兜底重试（重试只会再发一次 `/compact`）；用户消息照常由队列发出。
- **放弃时的收尾**：放弃的出口有两个（压缩回合出错 / 流丢了；压缩请求压根没发出去），都走
  `finishAbandonedAutoCompactRun`（`src/app-helpers.ts`）。后面还排着用户消息时，既不放行「等这张卡跑完」的
  其他卡，也不同步刷唤醒条件：排队的消息要到下一个微任务才把卡置回 streaming，此刻放行等于把一张马上要跑的卡
  当成闲着。那条消息的回合收尾时自然会广播完成（pitfall #422）。
  被否决：让唤醒判据把「有排队消息的卡」也算忙——「已延后 N 条」的队列可能一直挂着，等待方会被闲卡压到兜底超时。
- **挂着的边界不算压过**：带 `compactPending` 的边界只说明「发起过」，压没压成要等回合收尾
  （`settlePendingCompactBoundary`）才定。占用回扫跳过它（`isCompactBoundaryPending`），否则压缩回合进行中
  退出应用、重启后点了「不恢复」，这张卡就不再显示占用、也不再自动压缩（pitfall #424）。
  被否决：在关掉「中断会话」提示、停止请求发不出去这些出口逐个清标记——出口不止一处，漏一处就是一张再也不压的卡。

## 来源带到服务端（手机监工）

渲染端的 `SendMessageOrigin` 只活在 App 里，而手机监工看的是服务端的流，所以「这一回合是 App 替用户发的」
要一路带过去：

1. `App.tsx` 的 `requestChat` 只在 `isAutoCompactSend` 时带 `origin: 'auto-compact'`。
2. `chatRequestSchema.origin: z.literal('auto-compact').optional()`。必须进 schema：zod 默认剥掉没声明的键，
   请求在 `server/index.ts` 和 `electron/backend.ts` 两处解析，不进 schema 就在那里悄悄没了。
3. `ChatManager` 存进 `StreamRecord.requestOrigin`（不叫 `origin`：`ChatStopLogFields` 里已有一个意思不同的
   origin，是停止来源，只进日志）。
4. tap 广播事件、`buildActiveStreamViews` 的视图、`/api/events` 的 SSE 负载（重放和实时两条路径）都带 `origin`；
   普通回合没有这个键。
5. 手机页内联脚本按流记下 `entry.origin`。

手机端与电脑端同口径：

- 自动压缩回合不发 `user_message`，不镜像成用户气泡；历史转录和快照预览滤掉 `meta.compactHidden === 'true'`
  的用户消息（历史要在条数上限压缩之前滤，否则白占名额）。
- 压缩回合跑完 / 出错不响铃、不震动、不弹「跑完了」，详情页不落「本轮已完成 / 出错结束」；跑完 / 出错的压缩流
  不算卡片的最后状态，徽章退回快照里的状态，不闪一下「已完成」。被停照常显示「已停止」。
- 用户自己敲的 `/compact` 不带来源，照常镜像、照常提醒——那是用户的回合。

被否决：服务端看 prompt 是不是 `/compact` 来判断——分不出用户自己敲的 `/compact`（pitfall #425）。

## 压缩之后另开新会话

换 provider、硬打断后会话被清、恢复流时清了会话，都会「带着历史另开新会话」（`src/chat-request-seeding.ts`）。
CLI 的压缩摘要留在旧会话里带不过去；边界之前的原文只有 Codex 能靠归档回查再翻出来。所以「按不按压缩边界截断」
和「能不能归档回查」问同一个函数 `supportsArchiveRecall(provider)`（`src/archive-recall.ts`）：

- Codex：照旧按边界截断，边界之前的靠归档回查。
- 其它 provider：整段对话交给字数预算，和没压缩过的会话一样——开场需求必留，其余从新到旧挑。

自动压缩默认开着、用户往往不知道压过，这条路径从少见变成常见，所以 pitfall #226 记下的缺口在这里一并补上
（pitfall #421）。被否决：给 Claude 另接一套归档回查（服务端只有 Codex 那条 `-c mcp_servers…` 通路）；只放过自动
压缩的边界（手动 `/compact` 之后丢得一样）；文字不截、图片照截（回放里出现提到了却没带上的图）。

## 设置

`autoCompactEnabled`（默认 `true`）、`autoCompactThresholdPercent`（默认 80，50–95）。
`shared/schema.ts` 两处默认值 + `shared/default-state.ts` 归一化 + `src/state.ts` 的 patch 键 +
`settings-model.ts` 登记 `auto-compact` 条目。

这两个设置不住在 `column` 里：`WorkspaceColumn` → `PaneView` → `ChatCard` 的 memo 比较函数每一层都要比它们，
漏一层，下游的比较就是死代码——改了设置，已打开卡片的圆环档位和悬停说明不更新，和发送前的判定对不上
（pitfall #265 / #423）。
