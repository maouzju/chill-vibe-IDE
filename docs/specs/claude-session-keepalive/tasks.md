# Claude 长驻会话进程 — 任务切片

## 切片 1：池核心（红 → 绿）✅
- [x] `tests/claude-session-pool.test.ts`（已注册进 `tests/index.test.ts`）：
  - 复用判定：同 card+signature+session → 复用；任一变化 → 杀旧起新
  - turn 路由：活跃 attachment 收事件；endTurn 后进程保留
  - 自发输出：idle 收到 stdout → onUnsolicited 一次 + 迟到 attachment 回放缓冲行
  - 进程 exit：turn-active 通知 attachment；idle 静默清理；pending 场景回放后报告关闭
  - stdin 写入、空闲回收（输出重置计时）、closeAll
- [x] 红确认（模块不存在）→ 实现 `server/claude-session-pool.ts` → 12/12 绿

## 切片 2：providers 接入 ✅
- [x] `buildClaudeArgs` 增加 `streamingInput` 选项（`--input-format stream-json`；prompt 改走 stdin）
- [x] turn 状态机抽成 `createClaudeTurnParser`（watchdog/stripper/empty-tool-call recovery 原语义搬移），单次路径与 keepalive 路径共用
- [x] `launchClaudeKeepaliveRun`：池 acquire → beginTurn → stdin 写 user 消息；effort/stale-session fallback 与单次路径对称
- [x] `createClaudeUnsolicitedTurnAttachment`：自发 turn 的 parser 装配（含 watchdog）

## 切片 3：chat-manager + Electron 桥 + renderer ✅
- [x] `chatRequestSchema.cardId` 可选字段；App.tsx 三处 `requestChat` 调用带 cardId
- [x] ChatManager 构造注入池（仅 Electron backend 启用）、`handleUnsolicitedClaudeTurn` 创建 unsolicited stream、stop 走 `stopHook`、closeAll 纳入池
- [x] `electron/main.ts` 广播 `chat:unsolicited-stream`；`preload.ts` 桥成 `chill-vibe:unsolicited-stream`；`src/api.ts` `subscribeUnsolicitedStreams`
- [x] `src/App.tsx` 收通知 → 卡片置 streaming + attachStream；卡片已 streaming 则忽略；卡片已删则 stopChat 兜底

## 切片 4：验证 ✅
- [x] fake CLI 端到端（`tests/claude-keepalive-run.test.ts`）：真子进程上 turn → 保活 → 自发唤醒 → unsolicited 流 → stdin 复用，一次通过
- [x] 真 claude CLI 协议冒烟：`ALIVE_AFTER_TURN1= true`，同进程第二轮 stdin turn 成功（CLI 2.1.158）
- [x] `pnpm test:quality` 绿（eslint + 4×tsc）
- [x] 全量单测按用户工作流移交 release-pipeline 发布验证环节执行（日常交付以窄测试 + quality 为门槛）
- [x] 合并 main、清理 worktree
