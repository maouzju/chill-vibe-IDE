# 手机远程监工模式 — Tasks

## Slice 1 — ChatManager tap（TDD 红→绿）
- [ ] `tests/chat-manager-tap.test.ts`：tapAll 广播 / listActiveStreams backlog / 退订，先确认红
- [ ] `server/chat-manager.ts`：StreamRecord.cardId、tapAll、listActiveStreams，测试转绿
- [ ] 注册进 `tests/index.test.ts`

## Slice 2 — RemoteMonitorManager（TDD 红→绿）
- [ ] `tests/remote-monitor.test.ts`：鉴权/只读/snapshot/SSE 回放+实时/stop，先确认红
- [ ] `server/remote-monitor.ts`：http server + token + 路由 + SSE + LAN IP
- [ ] 手机页面模板（同文件或 `server/remote-monitor-page.ts`）
- [ ] 注册进 `tests/index.test.ts`

## Slice 3 — Electron 接线
- [ ] 加 `qrcode` + `@types/qrcode` 依赖，`pnpm legal:generate`
- [ ] `electron/backend.ts` 三方法 + dispose 关停
- [ ] `electron/main.ts` IPC handlers；`electron/preload.ts`；`src/electron.d.ts`
- [ ] `src/api.ts` 桥接函数

## Slice 4 — 桌面 UI
- [ ] `shared/i18n.ts` 文案（zh-CN + en）
- [ ] App.tsx 顶栏按钮 + QR 弹窗（structured-preview 套件）
- [ ] `src/index.css` 按钮/弹窗样式（双主题 token）

## Slice 5 — 验证交付
- [ ] 窄测试全绿 + `pnpm test:quality`
- [ ] 真机烟测：dev Electron 开监工 → 桌面浏览器模拟手机访问验证流式/改动卡/done 提醒
- [ ] AGENTS.md 补充（若发现新 pitfall）
- [ ] 合并回 main，`pnpm electron:build`

## V2 — 手机端互动（2026-07-10）

- [ ] shared/schema.ts: remoteMonitorCommandSchema
- [ ] tests/remote-monitor.test.ts: POST /api/actions 校验/转发/503（先红）
- [ ] server/remote-monitor.ts: 写端点 + snapshot 附模型/档位选项
- [ ] electron: backend dispatchCommand deps + main.ts remote:command 广播 + preload + api.ts
- [ ] App.tsx: 远程命令执行器 useEffect（复用现有 handlers）
- [ ] 手机页面: composer/停止/模型档位选择/新建会话
- [ ] i18n 安全文案升级；验证 + 合并 + 打包

## V2.1 — 详情页活动渲染补全（2026-07-10）

实机截图暴露：tool 活动掉进 `⚙️ kind` 兜底，详情页满屏光板 "tool"，信息量为零。

- [x] tests/remote-monitor.test.ts: 页面必须渲染各活动 kind 的真实内容（先红）
- [x] remote-monitor-page.ts renderActivity 补分支：tool（summary + 可展开 toolInput）、todo（进度+清单）、agents（子代理状态）、ask-user（问题+选项，黄边高亮）、compaction
- [x] 顺手修 reasoning 字段错读：schema 是 `text`，原读 `content||summary` 恒空白
- [x] buildRemoteMonitorSnapshot 列标题与电脑端同源：workspacePath 末段目录名，空路径回退 column.title
- [x] Playwright headless 实测截屏验证所有 kind 渲染

## V2.2 — 详情页历史转录（2026-07-10）

用户反馈：手机端只能看实时输出，看不了会话历史。

- [x] server/remote-monitor.ts: buildRemoteMonitorCardHistory（transfer 压缩 → 轻量条目，activity 直接复用 StreamActivity 形状）+ GET /api/history?cardId=（token 守卫/400/404）
- [x] electron/backend.ts: loadCardHistory 接线（loadStateForRenderer 找卡）
- [x] 手机页面: openDetail 先拉历史渲染（user 蓝边/assistant/system 样式区分，活动走 renderActivity），实时流按 itemId + 文本内容与历史去重
- [x] Playwright 实测：历史与 backlog 重叠内容只渲染一次

## V2.3 — 工具活动折叠成组（2026-07-10）

用户要求：工具调用默认省略，对齐 PC 端 tool-group 折叠表现。

- [x] 手机页面：历史+流式归一成统一块列表，连续 command/tool/edits 聚合为 details.tool-group（先红测试钉摘要文案）
- [x] 摘要与 PC 端同款文案：执行了 N 条命令，改动 N 个文件，调用了 N 次工具 + 计数徽标
- [x] 默认折叠；流式中的尾部组保持展开，agent 继续输出后自动折叠；用户手动展开跨重渲染记住（程序性展开的首次 toggle 不计入）
- [x] Playwright 实测折叠/展开/摘要计数

## V2.4 — 手机端混合模型与吸顶返回（2026-07-15）

- [x] 红测：快照模型选项必须同时包含 Codex/Claude provider；页面命令必须读取选中项 provider；返回按钮必须位于 sticky header。
- [x] 快照改为下发混合 provider 模型列表，手机端按选项自身 provider 切换。
- [x] 返回按钮移入吸顶页头，详情/列表切换时同步标题与显隐。
- [x] 定向测试、质量检查、手机窄视口验证、Electron 打包与运行时重启。
