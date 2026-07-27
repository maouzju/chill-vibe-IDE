# 工作区便签库与历史版本 — 任务

1. [x] 更新需求与设计：冻结多便签、本地文件、无应用内删除、重命名和历史恢复方案。
2. [x] 红：新增 store、schema、reducer 与组件的窄测试并确认失败。
3. [x] 绿：实现 `server/sticky-note-store.ts` 及 Web/Electron API 链路。
4. [x] 绿：为卡片补 `stickyNoteId`、独立视图状态与旧数据迁移。
5. [x] 绿：重做 `StickyNoteCard` 工具栏、已有便签入口与历史版本面板，移除删除操作。
6. [x] 更新双语文案与主题样式，补明暗主题/窄窗口视觉覆盖。
7. [x] 运行窄测试、`pnpm test:quality`、相关 Playwright/主题验证。
8. [x] 重启当前 Electron 开发运行时并执行 `pnpm electron:build`，报告可运行产物路径。
9. [x] 红：新增工作区便签搜索 store 与组件入口测试并确认失败。
10. [x] 绿：实现搜索 schema、store、Web/Electron API 与搜索 UI。
11. [x] 验证搜索交互、双主题、质量检查，重启 Electron 并重新打包。
