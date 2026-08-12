# 后端进程隔离 — 任务

进度标记：`[x]` 完成 · `[~]` 进行中 · `[ ]` 未开始

## 第 0 步 — 可行性探针（错了就得推翻方案）

- [x] `server/` 与 `electron/backend.ts` 是否依赖 Electron → **零依赖**
- [x] 是否有原生模块（ABI 风险）→ **无**，asar 里 0 个 `.node`，`npmRebuild: false`
- [x] utility 里 `process.versions.electron` 是否可见 → **可见 36.9.5**，MCP/超管的 `ELECTRON_RUN_AS_NODE` 判断不变
- [x] fork 的 `env` / `cwd` 行为 → env 默认继承；cwd 路径存在即可，**不存在则子进程静默死亡**
- [x] 子进程内 `process.chdir()` → 可用且失败会抛错，优先用它
- [x] asar 内 ESM 能否被 fork → **PASS，无需 asarUnpack**
- [x] 隔离收益量化 → 主线程单次最长停摆 6827ms → **58ms**（`scripts/bench-main-thread-isolation`）

## 第 1 步 — 接口形状改造（同进程内，不引入进程边界）

- [x] B1 `subscribeChatStream` 改 subscriptionId 协议（`tests/chat-stream-subscription-protocol.test.ts`）
- [x] B2 `watchFile` 改同款协议（`tests/file-watch-protocol.test.ts`）
- [x] B3 两个 dispatcher 同步布尔 → async（`server/remote-monitor.ts` / `server/automation-board-bridge.ts`，保持 503/202 语义）
- [x] B4 消除主进程对 `automation-board-session` 模块级 Map 的直接读写（`tests/desktop-backend-workspace-mirror.test.ts`）
- [~] 独立复核：形状一致性、订阅泄漏、行为等价、测试是否真能捕获问题
      —— 发版前扫过 `main.ts` 全部 98 处 `desktopBackend.` 调用点，**没有一处**把返回值
      用在 `if`/`&&`/`??`/属性访问上（这正是 pitfall 270/272 那类"boolean 跨进程变恒真
      Promise"的唯一触发形状）；两个已知形变点分别走 `isFileWatchArmed` 与
      `toAmbientAudioBuffer`。剩下未复核的是订阅泄漏的长时压测。

## 第 2 步 — 传输层与 utility host 骨架

- [x] `electron/backend-rpc-protocol.ts` — 消息编解码 + **错误封送**（ZodError 的 name/message/stack/issues 必须能还原，否则跨进程退化成 `{}`）
- [x] `electron/backend-rpc-client.ts` — 同形状 JS Proxy + pending 表 + 超时 + 断开时批量 reject
- [x] `electron/utility-host.ts` — 进程入口、deps 回调转事件、**自带崩溃日志**、工作目录校验后 chdir
- [x] `scripts/build-electron.mjs` 加第二个 tsc 入口（不加则新文件根本不会被编译）
- [x] ~~把 `electron/` 纳入 `pnpm check`~~ → **已证伪**：`tsconfig.test.json` 本来就含 `electron/**/*.ts`。真正的缺口是 **lint**：`eslint.config.js` 三段 files 都不覆盖 `electron/**`，报 "File ignored because no matching configuration was supplied"。**已补上**，实测零成本（28 文件 0 error 0 warning）

## 定案证据（2026-08-12，用新装的取证链抓到）

真实使用中捕获两次冻结（49.6s / 10.2s），三条独立证据把根因锁死在**主进程主线程**：

- **全天 0 次渲染进程 `unresponsive` 事件、0 次帧停滞告警** —— 8 秒看门狗在 49.6 秒冻结里本该触发却没有，说明渲染进程主线程始终健康，不是 React/JS 卡
- **冻结时主进程 minidump：主线程停在内核 Wait**（`ntdll+0x161a74` via `KERNELBASE+0x8591c`），而空闲时它停在 `win32u`（正常取消息）
- 窗口响应性由主进程消息泵负责 → Windows 判无响应，判的就是这条

同时排除的两个错误方向：
- ~~天气环境光遮罩的 30 秒全窗口重绘~~ —— **证伪**：`weatherCity` 为空字符串，从未配置城市，遮罩层不会渲染
- ~~外部程序抢 GPU~~ —— **反相关反证**：外部占 3D 引擎 27% 那次冻结 49.6s，占 91% 那次只冻 10.2s

renderer/GPU 高 CPU 是**伴随现象**（它们还在画，只是主进程不处理输入）。另注：硬件加速开启时 renderer→gpu 管道传的是 Skia 显示列表而非像素，所以"49.6 秒只流过 7MB"意味着数据量极低，不是批量纹理上传。

## "用久了才卡、重启就好"≠ 内存泄漏（2026-08-12）

用户报的是渐进式：刚开流畅，用久了卡，重启又好。最顺手的解释是内存泄漏，但
`scripts/analyze-resource-heartbeat.mjs` 解析 main.log 里 6481 条 Resource heartbeat 后
**反证掉了**：

| 运行段 | 时长 | 主进程 RSS 斜率 | 全进程私有内存 |
|---|---|---|---|
| 08-03 → 08-12 | **198.9h（8 天连续）** | **-1MB/h** | **-3MB/h**（峰 2066MB → 终 581MB） |
| 08-12 01:34 → 18:12 | 16.6h | +5MB/h | +34MB/h（峰 1039MB → 终 666MB，同样回落） |

八天连续运行内存**净下降**，第二段的上涨也在结束前回落 —— 没有单调爬升，不存在泄漏。

那重启清掉的到底是什么：**是负载，不是泄漏**。重启后卡片少、会话短、被监视的 git 仓库少；
用久了这些只增不减（`state.json` 已 1.4MB，比设计文档记的 1.2MB 又涨了），而每次全量保存和
每次 git spawn 都压在主进程主线程上。所以"越用越卡"= **负载增长 × 单线程结构**，
正是本规格要拆的那个结构，不需要另找一个泄漏点。

推论（影响验收方式）：**短时间"感觉还行"证明不了任何修复** —— 刚重启本来就不卡。
只能靠 `logs/app-unresponsive.log` 的 `[FROZEN]` 频率在**同等使用强度、长时间运行**下对比。

## 第 3 步 — 接线与切冷路径

- [x] `createDesktopBackend()` 从模块顶层改为 lazy + `ensureBackend()` 门（`main.ts:1627`）
- [x] fork 时机排在 `configureDesktopEnvironment()` 之后（`main.ts:1602` → `1627`）
- [x] 子进程崩溃恢复策略（`backend-host.ts` 的 restarts / maxRestarts / `deadClient.close`）
- [x] `main.ts` 的同步 try/catch 补 `.catch()` → `runBackendSideEffect`，已接线 6 处
- [x] `readAmbientAudioBuffer` 的 `Buffer` 返回值 → `toAmbientAudioBuffer`（`main.ts:1342`）
- [x] ~~切换约 70 个冷路径 handler~~ → **不是逐个切**：`main.ts:271` 把 `desktopBackend`
      整体换成 `backendHost.proxy`，全部方法一次性走 RPC。18 个 electron runtime 测试全绿
- [x] 退出握手：`scheduleQuitAfterFlush` 里 `await flushStateWrites()` → `await dispose()` →
      `backendHost.shutdown()` → `app.quit()`（`main.ts:678-704`）。RPC 客户端默认不设超时，
      挂死时兜底是 5s `quitTimer`（`main.ts:670`），那条路径跑不到 `finally`，所以
      `will-quit` 里保留一份幂等的 `shutdown()`（`main.ts:1672`）是必需的、不是冗余。
- [x] 拆分混合 handler：`desktop:sync-runtime-settings`（`main.ts:1165`，主进程只留窗口状态，
      其余转 RPC，**必须 `await`**，否则 renderer 在后端应用新设置之前就 settle → pitfall 137 复发）；
      `desktop:reveal-sticky-note-location`（`main.ts:1367`，不再在主进程二次 import
      `sticky-note-store` —— 那模块有模块级写队列 Map，两份副本等于绕过序列化）

## 第 4 步 — 热路径直连（决定成败）

> **发版范围（v0.19.0）：本次只发 第 0–3 步，第 4 步整片显式推迟到下一片。**
> 冷路径（≈70 个 handler，含每次发消息前的 git 快照）已经全部离开主线程，这本身就是
> 实测里最长那几次停摆的来源（单次 git spawn 最坏 6910ms）。第 4 步要搬的是流事件与
> state 保存的**转发**成本，量级不同、风险也不同（`MessageChannelMain` 要把 port 直接
> 交给渲染进程），不该和结构改造挤在同一次发版里。

> 若流事件与 state 保存仍经主进程中转，主进程只是从"跑后端"变成"每秒转发 480 次"，冻窗风险被稀释而非消除。

- [ ] `MessageChannelMain` + `webContents.postMessage` 把 port 直接交给渲染进程
- [ ] 聊天流事件绕开主进程（≈480 事件/秒），`chat-stream-batcher.ts` 随之搬进 utility
- [ ] state 保存绕开主进程（单次 1.2MB，实测每 25 秒一次全量往返）

## 验收

- [x] `scripts/bench-main-thread-isolation` 口径：后端跑 ≥20 次 git spawn 期间，主进程单次最长停摆 **< 500ms 且无一次 ≥ 5000ms** —— 实测 6827ms → **58ms**（第 0 步）
- [ ] `pnpm test:quality` + `pnpm test` + 18 个 electron runtime 测试全绿 —— 由 v0.19.0 的 `pnpm test:release` 门证（证据在仓库外的验证目录，不回写本文件）
- [x] 打包产物实机验证（结构层）：`pnpm smoke:packaged-backend` 对 `release-20260812-181312`
      实跑通过 —— 独立数据目录未漂移，且打包实例 fork 出**恰好 1 个 `node.mojom.NodeService`**
      子进程。红绿对照是实测的：同一时刻用户在跑的旧包子进程里该 sub-type **0 个**。
      （原脚本的就绪判据 `Resource heartbeat` 是假阳性 —— 那行由 `initCrashLogger()` 写出、
      排在 `ensureBackend()` 之前，fork 全废它照样出现；已改成看进程表。）
- [ ] 打包产物实机验证（功能层）：流式输出、超管镜像非空、远程监工 —— 仍需手动走一遍
- [ ] 交付后观察 `logs/app-unresponsive.log`：`[FROZEN]` 记录应显著减少或消失 —— **只能靠同等使用强度下的长时间运行对比**，短时间"感觉还行"证明不了任何事（见上文"用久了才卡"一节）

### 已知缺口（v0.19.0 带着发，非阻塞）

- `flushStateBeforeUpdate()`（`main.ts:707`）只 `flushStateWrites()`、不 `dispose()`，而
  `updater.ts` 的 `app.exit(0)` 绕过 `before-quit`/`will-quit` —— 更新安装那一刻会丢掉
  最多一个 2s 节流窗口的**代理统计**（不碰会话/state，state.json 走原子写）。
- 后端独立崩溃会带走 state-store 里 debounce 中的 pendingState。实际窗口很窄：renderer
  内存里仍持有完整 state，退出时 `app:flush-state-before-quit` 会重推给新子进程。
- 退出握手的**顺序**没有端到端钉住：`tests/electron-runtime.test.ts` 只正则断言了
  `await flushStateWrites()`，把 `shutdown()` 挪到 flush 前面现有测试抓不到。
