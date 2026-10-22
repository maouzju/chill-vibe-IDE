# 新模型自动发现 — Tasks
- [x] 1. `shared/model-discovery.ts` 纯函数 + `tests/model-discovery.test.ts`（解析、过滤、版本比较、标签）
- [x] 2. schema/default-state 新字段 `seenDiscoveredModels` + 归一化
- [x] 3. `server/model-discovery.ts` 端点解析（单测覆盖 profile / ~/.claude / ~/.codex 三条来源）+ HTTP 路由 + 桌面 IPC
- [x] 4. App 弹窗 + i18n + Playwright 截图（深浅两主题）
