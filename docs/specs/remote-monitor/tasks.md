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
