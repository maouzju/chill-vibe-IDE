# 工作区重开恢复标签页 — 任务

- [x] 写明需求、sidecar 设计和恢复边界。
- [x] 添加 reducer 与 state-store 红测并确认失败。
- [x] 实现关闭工作区快照的 schema、存储和 Electron bridge。
- [x] 实现精确恢复、旧历史兼容恢复和路径提交修正。
- [x] 更新总设计文档中的关闭/重开工作区约定。
- [x] 运行定向测试和 `pnpm test:quality`。
- [x] 运行 `pnpm electron:build`，并在 5174 隔离端口重启开发 Electron（避开正在占用 5173 的既有 Playwright）。
