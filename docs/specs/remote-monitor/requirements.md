# 手机远程监工模式 — Requirements

## 背景

用户在电脑上让 agent 跑长任务时希望离开工位（躺沙发/做别的事），用手机浏览器实时"监工"：看流式输出和改动卡，任务跑完时手机能收到提醒。

## 用户故事

1. **开启监工**：我在桌面顶栏点一个按钮，弹窗显示一个二维码；手机扫码即打开监工页面，无需装 App、无需登录。
2. **看板概览**：手机页面列出所有会话卡片（标题、provider/model、运行状态），一眼看出哪些在跑。
3. **盯流式输出**：点进一张卡，实时看到 agent 的流式文本输出（延迟秒级），包括中途加入也能看到本轮已产生的内容（backlog 回放）。
4. **看改动卡**：会话产生的文件改动（edits activity）以"文件路径 + 增删行数"列表展示，可展开看 patch。
5. **跑完提醒**：任一会话完成（done）或出错（error）时，手机端立即震动 + 提示音 + 页面/标题高亮，不用一直盯着屏幕。
6. **关闭监工**：桌面端可随时关闭，服务停止、token 失效。

## 功能需求

- R1: 主进程可启动一个 HTTP 服务，监听 `0.0.0.0`，端口默认 8791（可被 `CHILL_VIBE_REMOTE_MONITOR_PORT` 覆盖；被占用时自动落到随机可用端口）。
- R2: 每次启动生成随机访问 token；所有端点校验 token，缺失/错误返回 401。
- R3: 服务是**纯只读**的：只接受 GET；不暴露任何写操作（发消息、停止流、改状态一概没有）。
- R4: `GET /` 返回移动端自适应的单文件监工页面（内联 CSS/JS，无外部资源依赖，深色主题）。
- R5: `GET /api/snapshot` 返回看板轻量快照：各列/卡的 id、标题、provider、model、status、streamId、最近消息预览。不包含完整历史转录。
- R6: `GET /api/events` 是 SSE：先回放当前所有活跃流的 backlog（标注 streamId/cardId），之后实时转发所有流事件（delta/assistant_message/activity/done/error/session/stats/log）。新流创建也会广播。
- R7: 手机页面在收到 `done`/`error` 时触发：`navigator.vibrate`（支持的设备）、Web Audio 提示音（用户首次触摸页面后解锁）、`document.title` 前缀标记。尽力尝试 Notification API，但不依赖它（HTTP 非 secure context 下通常不可用——Web Push 需要 HTTPS，明确不做）。
- R8: 桌面端顶栏有开关入口；开启后弹窗显示二维码（编码 `http://<局域网IPv4>:<port>/?token=...`）、可复制的 URL、连接状态；再次操作可关闭服务。
- R9: 应用退出时服务自动关闭。
- R10: 监工服务的运行状态**不持久化**（重启应用后默认关闭，token 重新生成）——避免动 persisted schema 和 normalization。

## 非功能需求

- N1: 单测覆盖：token 鉴权、只读拒绝、snapshot 形状、SSE 回放+实时转发、done 转发、stop 关闭（Tier 1 TDD）。
- N2: 不引入重型依赖；QR 生成用 `qrcode`（MIT）。
- N3: 手机页面体量控制在一个模板字符串内，不进 Vite 构建管线。
- N4: 快照读取走 `loadStateForRenderer()` 轻量路径（pitfall 55/57：绝不用全量 `loadState()`）。
- N5: 桌面 UI 双主题可用（AGENTS.md Theme Safety）。

## V2 — 手机端互动能力（2026-07-10 追加）

用户要求手机端不止能看，还能操作，"和电脑端一致"：

- R11: 手机端可对任一卡片**输入需求并发送**（复用卡片当前的 provider/model/系统提示词/session 续传，与电脑端发送完全同一条代码路径）。
- R12: 手机端可**停止**正在运行的会话。
- R13: 手机端可在任一工作区列**新建会话 tab**（继承列/全局默认模型，与电脑端"+"行为一致）。
- R14: 手机端可**调整卡片模型与推理档位**，且必须走电脑端同一 handler（模型切换的 session 作废/保存恢复逻辑在 reducer `selectCardModel` 里，绕过会导致 session 与模型不一致）。
- R15: 写命令统一走 `POST /api/actions`（同一 token 鉴权 + zod schema 校验），由主进程转发给渲染进程执行——渲染进程是 state 唯一主人，主进程绝不直接改 state。
- R16: snapshot 扩充：每卡附可选模型列表与该模型的可用推理档位（含本地化标签），供手机端渲染选择器。
- R17: 无渲染窗口可接收命令时（如窗口正在重载），`/api/actions` 返回 503，手机端提示重试。
- R18: 安全文案升级：token 现在代表**操作权**而非只读，弹窗提示语与 SPEC 同步更新。

## 明确不做（本期）

- 回答 ask-user 选项卡、图片附件上传（手机端）。
- HTTPS / Web Push / Service Worker。
- 多用户、多 token、权限分级、只读/可写分离 token。
- 历史会话浏览（只看活跃流 + 卡片最近预览）。
