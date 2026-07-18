# Claude 长驻会话进程 — 设计

## 核心架构决策

### D1：保持"一个 stream = 一个 turn"不变量
现有 `ChatManager` 的 stream 生命周期（backlog、terminal、5 分钟 cleanup）与持久化（`card.streamId`）全链路都假设 stream 终结即终结（pitfall #113 重灾区）。本设计**不改动**这一不变量：

- 进程生命周期与 stream 解耦：**进程按卡片长驻**（新模块 `server/claude-session-pool.ts`），stream 仍然一 turn 一个。
- turn 结束（`result`）→ 当前 stream 照常 `onDone()` → terminal → 卡片回 idle。进程保留在池里。
- **自发输出**（task-notification 唤醒的新 turn）→ 池回调通知宿主 → `ChatManager.createUnsolicitedStream(cardId)` 创建**新的** stream → Electron 桥广播 `chat:unsolicited-stream { cardId, streamId }` → renderer 把卡片 attach 到新 stream（置 streaming）→ 走完全现成的事件渲染路径。

与 Codex 的 thread 模型同构（进程长驻、turn 短命），renderer 侧"未经请求的推送"仿照 file-watcher 先例（`electron/main.ts` 的 `file:changed` 转发模式）。

### D2：池键控与复用条件
池按 `cardId` 键控。复用必须**全部满足**：

- `request.sessionId` 非空且 === 进程当前 sessionId（CLI `system/init` 事件回报的 id）
- model、reasoningEffort/thinkingEnabled、workspace（cwd）、planMode（permission-mode）一致 —— 这些都是进程级参数
- 进程存活且无活跃 turn

任一不满足：kill 旧进程（若存在），按 keepalive 模式 spawn 新进程（带 `-r sessionId` 恢复历史）。用户打断（stop）由 ChatManager `child.kill()` 杀进程，池在 exit 处理中清掉注册表项 —— 下次请求自然不复用（满足 pitfall #118）。

### D3：CLI 启动形态（keepalive 变体）
```
claude -p --verbose --output-format stream-json --include-partial-messages \
  --input-format stream-json \
  [-r <sessionId>] --permission-mode ... --settings ... --model ... --effort ... \
  --append-system-prompt ...
```
与现有 `buildClaudeArgs` 的差异只有两点：**追加 `--input-format stream-json`**、**不带位置 prompt 参数**。首条及后续用户消息都写 stdin，一行一个 JSON：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<getClaudePrompt() 输出>"}]}}
```

注意：keepalive 模式不能同时把 prompt 放进 argv。长对话恢复会把完整用户原文写入 replay prompt，若再作为 positional 参数传给 Claude CLI，会在 Windows 上撞命令行长度限制；stdin 是唯一的用户消息通道。

`spawnProvider` 的 stdio 需要 stdin: 'pipe'（现为 'ignore'，加参数开关）。

### D4：turn 路由状态机（池内每进程）
```
状态：idle（无活跃 sink）⇄ turn-active（有活跃 sink）

sendTurn(request, sink)：写 stdin → 状态 turn-active，事件按现有 stream-json 解析折叠路由到 sink
result 事件        ：sink.onDone()（或恢复分类）→ 状态 idle，进程保留
idle 状态收到输出   ：触发 onUnsolicited(cardId) → 宿主创建 unsolicited stream 返回新 sink → 状态 turn-active，该 turn 事件路由到新 sink
进程 exit：
  - turn-active：走现有 close 处理（stderr 解析 → recovery 分类 → sink.onError）
  - idle：静默清理注册表（下次请求自然 -r 起新进程）
```

stream-json 解析复用 providers.ts 现有折叠逻辑（事件类型、stripper、watchdog、openCommandCount），通过把现有 Claude 行处理器抽成可复用函数（按 turn 实例化）实现，不复制粘贴。

### D5：watchdog 适配
- turn-active：first-byte / stall / `openCommandCount>0` 时 disarm。
- **后台等待型工具豁免（Workflow / 子代理）**：headless `claude -p` 对 `Workflow`/`Task`/`Agent` 这类工具是**同步等待**的——结果是本 turn 最终输出的一部分，CLI 默认等到 10 分钟（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`，`0`=不限时），其间不吐 stdout。这类工具不会增加 `openCommandCount`，所以 120s 的 stall 看门狗会在 workflow 还没跑完时误杀 CLI（卡片表现为"卡住/回答中断"）。`createClaudeTurnParser` 现在用 `isClaudeBackgroundAwaitTool` 在解析到这类 tool_use 时**按 turn 锁存** `sawBackgroundAwaitTool`，`resolveLocalStreamStallTimeoutMs` 据此把 stall 窗口拉到 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS + 60s`（不限时则完全 disarm），让 CLI 自己的 cap / 进程关闭兜底，workflow 合成结果随后在**同一条 stream** 上正常续出。
- idle（turn 之间）：**完全 disarm** —— 静默是正常态。
- 自发 turn 开始：作为新 turn 布防 stall watchdog。

### D6：空闲回收
- 进程级空闲计时器：**任何 stdout 输出**或新 turn 开始都重置；超时（默认 30 分钟，`CHILL_VIBE_CLAUDE_KEEPALIVE_IDLE_MS` 可覆盖）且状态为 idle 时优雅退出（end stdin → 兜底 kill）。
- 后台任务完成会产生自发输出（重置计时器），所以"安静 30 分钟"≈ 无后台活动，可安全回收。
- 逃生门：`CHILL_VIBE_CLAUDE_KEEPALIVE=0` 完全禁用 keepalive，回退现状单次进程。

### D7：仅 Electron 启用
`ChatManager` 增加可选构造依赖 `claudeSessionPool` + `onUnsolicitedStream` 回调。`electron/backend.ts` 创建池并注入；Express 宿主（`server/index.ts`）不注入 → 走现状路径。web 模式零改动。

## 数据/接口变更

- `shared/schema.ts`：`chatRequestSchema` 加可选 `cardId: z.string().optional()` —— unsolicited 通知需要把进程归属到卡片。renderer `requestChat` 时带上。
- 新 IPC：main → renderer `chat:unsolicited-stream`（payload `{ cardId, streamId }`），preload 转成 window CustomEvent `chill-vibe:unsolicited-stream`，`src/api.ts` 暴露 `subscribeUnsolicitedStreams(handler)`。
- `src/App.tsx`：handler 反查卡片归属列 → `updateCard(status:'streaming', streamId)` → 复用现有 `attachStream` 订阅。卡片已在 streaming（竞态）时忽略通知。

## 触及文件

| 文件 | 改动 |
|------|------|
| `server/claude-session-pool.ts` | 新增：池 + turn 状态机 + 空闲回收 |
| `server/providers.ts` | buildClaudeArgs keepalive 变体；Claude 行处理器抽函数；launchProviderRun Claude 分支接池 |
| `server/chat-manager.ts` | 池注入、createUnsolicitedStream、closeAll/dispose 纳入池 |
| `shared/schema.ts` | chatRequest.cardId 可选字段 |
| `electron/backend.ts` / `main.ts` / `preload.ts` | 池启用 + unsolicited 广播桥 |
| `src/api.ts` / `src/App.tsx` | 订阅通知 + attach 卡片 |
| `tests/claude-session-pool.test.ts`（+ index 注册） | 池单测（红→绿） |

## 风险与对策

- **池/providers 循环依赖**：池为独立模块，providers 与 chat-manager 单向引用它；unsolicited 用回调注入，不反向 import。
- **stdin 写入与 CLI 兼容**：本机 CLI 2.1.158 已确认支持 `--input-format stream-json`；fake CLI 集成测试 + 真 CLI 手动冒烟双重验证。
- **自发 turn 与用户同时发送竞态**：池 sendTurn 仅在 idle 时接受；turn-active 时新用户请求按"不可复用"处理（杀进程起新进程会丢后台任务 —— 但该场景 = 用户在 agent 自发汇报中途发新消息，与现状打断语义一致，可接受）。
- **泄漏**：closeAll/dispose 必杀全部池进程；BrowserWindow close 清理沿用现有路径（pitfall #112/#136 不触碰）。

## 2026-07-18 lifecycle hardening

- Reuse identity includes the resolved runtime environment and every attachment authorization parent directory. Environment keys are sorted before serialization so equivalent profiles do not cause needless respawns.
- Every pool mutation may carry the expected child identity. Delayed callbacks from a replaced process are ignored and cannot end, rename, write to, or release the newer process.
- Concurrent acquisition for one card uses a monotonic generation. If an older spawn resolves after a newer acquisition, the older child is killed and is never installed in the pool.
- Stop requested before provider launch completes is sticky: a late child is killed immediately rather than escaping stream ownership.
