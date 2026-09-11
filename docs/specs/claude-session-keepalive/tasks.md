# Claude 长驻会话进程 — 任务切片

## 软中断保留会话（2026-09-11，仅方案 ②）

- [x] 重跑已有红测：终态标记、Claude reducer、收尾期间 acquire，共 5 个预期失败。
- [x] 在 done 信封携带软中断结果，覆盖普通 turn、自发 turn 与延迟 workspace diff 收尾。
- [x] reducer 仅凭 Claude 的明确软中断标记保留会话；硬杀、Codex、无 done 兜底不放宽。
- [x] 池等待匹配进程的中断收尾；退出、超时、dispose、并发替换均释放等待，旧请求不得抢占新进程。
- [x] 聚焦 Node 与发送中断 Playwright 回归、质量检查，Windows zip 打包；仅按运行面安全重启开发实例。

不改左键/回车/右键发送语义；不承诺恢复被 CLI 中断的子代理。不新增持久化字段。

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

## 子代理 sidechain 误唤醒修复（2026-07-27）

- [x] 红测复现：父回合结束后，带 `parent_tool_use_id` 的 Explore/Agent sidechain 行会错误创建 unsolicited stream。
- [x] turn-start gate 忽略所有非顶层 sidechain stdout，同时保留真实 task-notification 主 Agent 回流。
- [x] 完成聚焦测试、质量检查、Windows 打包与开发运行时重启。

验证记录：

- 红测：`node --import tsx --test tests/claude-unsolicited-real-wake.test.ts` 新增用例稳定失败，实际值 `true`（sidechain 被误判为 turn start）。
- 绿测：`node --import tsx --test tests/claude-unsolicited-real-wake.test.ts tests/claude-session-pool.test.ts tests/claude-keepalive-run.test.ts`：20/20 通过。
- 隔离 worktree `pnpm test:quality`：通过；合并后主工作区复跑被并行中的 `server/sticky-note-store.ts` 既有 `no-control-regex` lint 错误阻断，与本修复文件无关。
- `pnpm electron:build`：通过，产出 `dist/release-20260727-100706/Chill Vibe-0.18.19-win.zip` 与 `win-unpacked/Chill Vibe.exe`。
- `pnpm dev:restart`：退出码 0；开发 Electron 已重启，renderer `http://localhost:5173` 健康检查返回 200，运行命令指向 `D:\Git\chill-vibe`。
- [x] 真 claude CLI 协议冒烟：`ALIVE_AFTER_TURN1= true`，同进程第二轮 stdin turn 成功（CLI 2.1.158）
- [x] `pnpm test:quality` 绿（eslint + 4×tsc）
- [x] 全量单测按用户工作流移交 release-pipeline 发布验证环节执行（日常交付以窄测试 + quality 为门槛）
- [x] 合并 main、清理 worktree
