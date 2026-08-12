# 后端进程隔离 — 设计

## 目标形态

```
改造前                              改造后
┌──────────────────────┐            ┌──────────────┐   ┌────────────────────┐
│ 主进程（主线程）      │            │ 主进程        │   │ utilityProcess      │
│  ├ 窗口 / 消息泵      │            │  ├ 窗口/消息泵│◄─►│  ├ backend.ts       │
│  ├ 108 个 IPC handler│            │  ├ IPC 转发   │   │  └ server/ 28k 行   │
│  ├ backend.ts        │            │  └ ~20 个真正 │   │     git spawn       │
│  └ server/ 28k 行    │            │     需要      │   │     大 JSON/Zod     │
│     git spawn ← 卡这 │            │     Electron  │   │     同步 fs         │
└──────────────────────┘            │     的 handler│   └────────────────────┘
                                    └──────────────┘
                                            ▲
                                            │ 热路径直连（见「热路径」）
                                    ┌───────┴──────┐
                                    │ 渲染进程      │
                                    └──────────────┘
```

## 前提（已实证，2026-08-12）

| 前提 | 实测结果 |
|---|---|
| `server/` 是否依赖 Electron | **零依赖**（`grep "from 'electron'" server/ shared/` 为空） |
| `electron/backend.ts` 是否依赖 Electron | **零依赖** |
| 是否有原生模块（ABI 风险） | **无**，shipped asar 里 0 个 `.node`，`npmRebuild: false` |
| utility 里 `process.versions.electron` | **可见（36.9.5）** → MCP/超管的 `ELECTRON_RUN_AS_NODE` 判断不变 |
| fork 的 `env` | 默认继承主进程，也可显式覆盖 |
| fork 的 `cwd` | 路径存在即可（正反斜杠都行）；**路径不存在 = 子进程静默死亡，无异常无 exit 事件** |
| 子进程内 `process.chdir()` | 可用，且失败会抛出可捕获的错误 —— **优先用它** |

隔离收益（`scripts/bench-main-thread-isolation`，20 次 git 调用）：

| 跑在哪 | 单次最长停摆 | >1s | >5s |
|---|---|---|---|
| 主进程 | 6827ms | 11 次 | 2 次 |
| utilityProcess | **58ms** | 0 | 0 |

## 核心手法：同形状代理

`createDesktopBackend()` 返回的是一个纯方法对象，`main.ts` 的 108 个 handler 各调其中一个方法。因此用一个 JS `Proxy` 生成同形状对象，把方法调用转成 port 上的 RPC，**~85 个 handler 一行不用改**。

```
main.ts:  const desktopBackend = createBackendProxy(port)   // 唯一替换点
          ipcMain.handle('x', () => desktopBackend.foo(a))  // 原样不动
```

## 分步落地（每步可独立发版验证）

### 第 1 步 — 接口形状改造（不引入进程边界）

有四类接口在同进程下正常、跨进程会**静默走错分支**（不是报错）。先在同进程内改掉，改完 backend 对象即为"纯可克隆"。

| # | 位置 | 问题 | 跨进程后的静默故障 |
|---|---|---|---|
| B1 | `backend.ts:467` `subscribeChatStream` | 回调入参 + 返回 unsubscribe 函数/null | 返回值变 Promise 恒真 → "流不存在"分支永久不可达 + 幽灵订阅泄漏 |
| B2 | `backend.ts:628` `watchFile` | 回调入参 + 同步 boolean 返回 | 同上 → 监听失败也登记，渲染端永远收不到变化 |
| B3 | `remote-monitor.ts:357` / `automation-board-bridge.ts:161` | 同步布尔**直接决定 HTTP 状态码**（503/202） | 拿不到同步返回值。**唯一必须侵入 server/ 的地方** |
| B4 | `main.ts:927-938` 直接读写 `automation-board-session.ts:42` 的模块级 Map | 主进程与 utility 各持一份模块副本 | 超管桥接读到的镜像**永远为空** |

统一改成：调用方生成 subscriptionId + 可序列化返回值 + 独立事件通道 + 显式 unsubscribe。

**B1 已落地**（同进程等价改造，未引入任何进程边界）：

- `backend.subscribeChatStream(streamId, subscriptionId)` 返回可克隆的 `{ subscribed: boolean }`；退订句柄只留在 backend 内部的 Map 里，永不越过接口
- 流事件走新的 `deps.onChatStreamEvent`（载荷 = `StreamEnvelope & { subscriptionId }`，纯数据）
- 新增 `backend.unsubscribeChatStream(subscriptionId)`，幂等
- `subscriptionId -> WebContents` 的路由表和三处清理收进 `electron/chat-stream-subscriptions.ts` 的纯函数 registry（`unsubscribeOwner` / `unsubscribe` / `unsubscribeAll`）。**登记必须早于 subscribe**：`ChatManager.subscribe` 同步重放 backlog，先调用后登记会丢掉整段 backlog；跨进程后返回值是 Promise，这个顺序更是唯一可行的
- 渲染进程侧（`preload.ts` / `src/api.ts`）本来就已经是 subscriptionId 协议，零改动
- 回归：`tests/chat-stream-subscription-protocol.test.ts`

### 第 2 步 — utility host 骨架

- 新增 `electron/utility-host.ts`，并在 `scripts/build-electron.mjs:90` 加第二个入口（当前只传 `electron/main.ts` 一个文件给 tsc，靠 import 图带出 server/；**不加就根本不会被编译**——现成反例：`server/index.ts` 至今没有产物）
- 打包侧零改动：`package.json:114` 的 `"dist/electron/**/*"` 已覆盖
- ~~待实测~~ **已实测 PASS：asar 内 ESM 可被 `utilityProcess.fork` 加载，无需 `asarUnpack`**（`scripts/bench-main-thread-isolation/probe-asar-esm.js`，用当前打包产物 release-20260812-101200 验过）。判据可靠性也做了对照：加载不存在的模块会 exit code 1，且 ESM 语义确认生效（`import.meta.url` 可用、`typeof require === 'undefined'`）。顺带实测到的坑：**Electron 把 `.asar` 当目录挂载，对它 `statSync` 取到的 mtime 不可信**，按它排序会选到前一天的旧包——要挑最新产物得 stat 真实的 release 目录
- 必须自带崩溃日志：`electron/crash-logger.ts` 依赖 `electron-log/main` + `app.isPackaged`，在 utility 里用不了。不补的话一次 unhandledRejection = 后端静默死亡、窗口还活着，**比现在的闪退更难查**
- fork 时机：必须在 `app.whenReady()` 且在 `configureDesktopEnvironment()`（`main.ts:269-286`，设置 `CHILL_VIBE_DATA_DIR` 等）之后。当前 `createDesktopBackend()` 在模块顶层（`main.ts:163`）执行，需改为 lazy proxy + `ensureBackend()` 门
- 工作目录：主进程 `process.chdir()`（`main.ts:271`）的效果不传给子进程，而 server 有 6 处依赖 `process.cwd()`，其中 `server/app-paths.ts:12` 是 `getAppDataDir` 的兜底 —— **搞错就是数据目录静默漂移，用户视角是"历史全没了"**。用子进程内 `chdir` + 存在性校验
- 退出握手：`proxy-stats-store.ts:322` 的 `process.on('exit')` flush 在 utility 被拆掉时不保证跑；挂靠已有的 `scheduleQuitAfterFlush`（`main.ts:540-575`，750ms 延迟 + 5s 预算）

### 第 3 步 — 切冷路径

先搬 git / file / sticky-note / history 等约 70 个 handler。验收基线是现成的：18 个 `electron-*-runtime.test.ts` 驱动真 Electron。

### 第 4 步 — 热路径直连（决定成败）

**如果流事件和 state 保存仍经主进程中转，等于把主进程从"跑后端"换成"跑一个 480 次/秒的转发器"，冻窗风险只是被稀释而非消除。**

- 聊天流事件：实测 ≈480 事件/秒，890ms 内 426 次 IPC / 6MB（`main.ts:211-214` 注释）
- state 保存：单次 1.2MB，实测每 25 秒一次全量往返

做法：用 `MessageChannelMain` + `webContents.postMessage` 把 port 直接交给渲染进程，让这两条链路**完全绕开主进程**。`electron/chat-stream-batcher.ts:20` 本来就是注入式、与传输无关，可原样搬进 utility。

## 需要专门处理的细节

- **错误跨进程会退化成 `{}`**：backend 里 60+ 处 `.parse()` 抛 `ZodError`。port 层必须显式打包/还原 name/message/stack（`backend.ts:592-597` 已有注释记录踩过一次）
- **同步 try/catch 失效**：`main.ts:1005-1017` 的 try/catch 是有血案的（畸形 wake-timer 让窗口每 20 秒消失一次）。`backend.ts:323` 的 `appStateSchema.parse()` 同步抛，Proxy 化后变 rejected Promise，必须补 `.catch()`
- **唯一的二进制返回值**：`backend.ts:554` `readAmbientAudioBuffer` 返回 `Buffer`，跨进程丢原型。改显式 `Uint8Array` + transferable
- **崩溃恢复语义全新**：今天后端死 = 整个 app 死（可见）；以后 utility 独立退出，ChatManager backlog 和 Claude 进程池都在子进程里，必须决定重启后如何告知渲染端所有 streamId 失效
- **混合 handler 需拆两半**：`desktop:sync-runtime-settings`（`main.ts:1030`，同时设主进程窗口关闭行为 + 转发后端）、`desktop:reveal-sticky-note-location`（`main.ts:1245`，解析路径 + `shell.openPath`）
- ~~**electron/ 不在任何 typecheck 里**~~ **已证伪**：`tsconfig.test.json` 实际包含 `electron/**/*.ts`，这些文件在 `strict` 下受检（2026-08-12 实测，新增的 3 个 RPC 文件 `pnpm check` 全绿）。**但 `eslint.config.js` 的三个 files 段确实完全不覆盖 `electron/**`** —— 核心目录有类型守门、没有 lint 守门，108 个 handler 大搬家之前值得补上

## 可复用的现成样板

- `server/providers.ts:1729-2034` 的 Codex JSON-RPC 客户端：id 工厂 + pending-promise map + 超时 + 拆解时 mass-reject，形状正是 port RPC 要的
- `server/claude-session-pool.ts` 的生命周期硬化：stdin `'error'` 监听（`:379`，注释记载缺它造成过 7 次整窗崩溃）、generation 计数器、drain 超时再硬杀、有界重放缓冲

## 不做

- 不重写 `server/` 内部实现
- 不解决 9195 个 sidecar / 1.1GB 数据目录体积问题（另立）
