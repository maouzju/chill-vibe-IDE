# 手机远程监工模式 — Design

## 总体架构

```
手机浏览器 ── HTTP/SSE(0.0.0.0:8791?token=...) ──> RemoteMonitorManager (server/remote-monitor.ts)
                                                        │ deps 注入
                                    ┌───────────────────┼───────────────────────┐
                            loadSnapshot()        tapStreams(listener)    listActiveStreams()
                                    │                   │                       │
                        loadStateForRenderer()      ChatManager.tapAll     ChatManager.listActiveStreams
                                                        └── 同一个 ChatManager 实例（electron/backend.ts）

桌面 UI（App.tsx 顶栏按钮 + QR 弹窗）── IPC desktop:remote-monitor-* ──> electron/main.ts ──> backend
```

## 模块设计

### 1. `server/chat-manager.ts` 扩展

- `StreamRecord` 增加 `cardId?: string`（`createStream` 时从 `request.cardId` 记录；unsolicited 流用 `entry.key`）。
- `tapAll(listener: (event: ChatStreamTapEvent) => void): () => void` — 全局订阅。`emit()` 在通知 per-stream subscribers 之后广播 `{ streamId, cardId, envelope }`。`createStream` 时先广播一条 `{ streamId, cardId, envelope: null, created: true }`？——不引入特殊事件：tap 事件统一为 `{ streamId, cardId, envelope }`，新流的第一条真实事件天然携带 streamId，手机端据此建流。（快照里有 card.streamId 可对齐。）
- `listActiveStreams(): Array<{ streamId, cardId?, terminal, backlog: StreamEnvelope[] }>` — 直接暴露各流 backlog 的浅拷贝，供 SSE 连接时回放。
- 导出类型 `ChatStreamTapEvent = { streamId: string; cardId?: string; envelope: StreamEnvelope }`。

### 2. `server/remote-monitor.ts`（新）

```ts
type RemoteMonitorDeps = {
  loadSnapshot: () => Promise<RemoteMonitorSnapshot>
  tapStreams: (listener: (event: ChatStreamTapEvent) => void) => () => void
  listActiveStreams: () => ActiveStreamView[]
}
createRemoteMonitorManager(deps) => {
  start(options?: { port?: number; host?: string }): Promise<RemoteMonitorRuntimeInfo>
  stop(): Promise<void>
  getStatus(): { running: boolean; url?: string; port?: number; clientCount: number }
}
```

- `start()`：幂等（已运行直接返回现状）。`crypto.randomBytes(16).toString('hex')` 生成 token。`http.createServer` 监听 `0.0.0.0`；优先端口 `CHILL_VIBE_REMOTE_MONITOR_PORT` ?? 8791，`EADDRINUSE` 时回退 `listen(0)`。启动时 `tapStreams` 挂 tap，`stop()` 时解除。
- URL 构造：`http://<lanIPv4>:<port>/?token=<token>`；LAN IP 取 `os.networkInterfaces()` 第一个非 internal IPv4（找不到时回退 `127.0.0.1` 并在状态里标注）。
- 路由（全部先过 token 校验，非 GET 一律 405）：
  - `GET /` → `text/html` 手机页面（模板字符串，token 通过 URL query 带入页面 JS）。
  - `GET /api/snapshot` → `application/json`。
  - `GET /api/events` → SSE：先对 `listActiveStreams()` 的每个流回放 backlog（每条事件包一层 `{ streamId, cardId, event, data }`，SSE event 名统一 `stream`），再实时转发 tap 事件；15s 心跳注释行防中间设备断连。
- 只读保证：整个 server 没有任何会调用写路径的分支。
- SSE 客户端计数暴露在 `getStatus().clientCount`。

### 3. snapshot 形状（`RemoteMonitorSnapshot`）

从 `loadStateForRenderer()` 的 `response.state` 映射：

```ts
{
  generatedAt: number,
  columns: Array<{
    id, title,
    cards: Array<{
      id, title, provider, model, status, streamId?,
      lastMessagePreview?: string   // 最后一条 assistant/user 消息文本前 200 字符
    }>
  }>
}
```

注意：**不发 messages 全量**（pitfall 183 的教训——不把整段转录发出去）。

### 4. Electron 接线

- `electron/backend.ts`：`ChatManagerLike` 增加 `tapAll`/`listActiveStreams`；懒加载 `remoteMonitorManager`（模仿 MusicManager 模式，pitfall 79：构造保持惰性），deps 用真实 `loadStateForRenderer` + `getChatManager()`。新方法：
  - `startRemoteMonitor(): Promise<{ url, port, token, lanFallback }>`（内部同时用 `qrcode` 生成 `qrDataUrl` 一并返回）
  - `stopRemoteMonitor(): Promise<void>`
  - `getRemoteMonitorStatus()`
  - `dispose()` 里追加 remote monitor 关停。
- `electron/main.ts`：三个 `ipcMain.handle('desktop:remote-monitor-start|stop|status', ...)`。
- `electron/preload.ts` + `src/electron.d.ts`：暴露 `startRemoteMonitor/stopRemoteMonitor/fetchRemoteMonitorStatus`。
- `src/api.ts`：`requireDesktopAction` 模式（无 web fallback——web 模式本来就是浏览器，不需要监工服务）。

### 5. 手机页面（内联模板）

单 HTML：顶部状态条（连接状态/通知开关）＋卡片列表；点卡片进入流视图（delta 累积文本 + assistant_message 覆盖 + edits activity 渲染文件列表，`<details>` 折叠 patch）。
通知：SSE `done`/`error` → `navigator.vibrate([200,100,200])` + WebAudio 短提示音（首次 touch 解锁 AudioContext）+ `document.title = '✅ ...'` + 尽力 `Notification`。
纯 vanilla JS，无依赖；深色配色手写（不进主题 token 体系——独立页面）。

### 6. 桌面 UI

- App.tsx 顶栏 `app-topbar-frame` 内、`app-titlebar-controls` 前加 `app-topbar-remote-monitor` 按钮（手机图标 SVG，`title`/`aria-label` 走 i18n）。运行中时按钮加 `is-active` 状态色。
- 弹窗模仿 Codex Fast Mode 弹窗（`structured-preview-layer/backdrop/dialog/card/header/body` + `AppButton`）：显示 QR `<img>`（data URL）、URL 文本（点击复制）、客户端连接数、"停止监工"按钮。
- i18n：`LocaleText` 增加 `remoteMonitor*` 键，zh-CN + en 同步补齐。

## 安全考量

- token 随机 128-bit，启动即生成，停止即失效；URL query 携带（局域网 HTTP 场景的现实折中，QR 码即物理授权）。
- 服务只读，最坏泄露面为会话输出内容本身；监听 0.0.0.0 需要用户显式点击开启（默认关闭、不持久化）。
- 对 token 比较使用 `crypto.timingSafeEqual`。

## 测试设计（先红后绿）

`tests/remote-monitor.test.ts`（fake deps 注入，`listen` 后用 fetch 打真实端口——仿 `tests/resilient-proxy.test.ts`）：
1. 无 token / 错 token → 401；POST → 405。
2. `/api/snapshot` 返回注入的快照 JSON。
3. `/api/events` 连接后先收到 backlog 回放，再收到 tap 实时事件（含 done）。
4. `stop()` 后端口拒绝连接、tap 解除。
5. `/` 返回含 token 引导的 HTML。

`tests/chat-manager-tap.test.ts`：
1. `tapAll` 收到 emit 的事件（带 streamId/cardId）。
2. `listActiveStreams` 返回 backlog；terminal 流被剔除或标注。
3. 退订后不再收到。

（ChatManager 测试需要 fake provider——检查现有 `tests/chat-manager-backlog.test.ts` 怎么做，复用其手法。）

注册进 `tests/index.test.ts`（pitfall 3）。
