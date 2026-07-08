# 便签按工作区记忆 — 任务

1. [x] schema：`stickyNoteArchiveEntrySchema` + `appStateSchema.stickyNoteArchive`；
   `createDefaultState()` 补默认空档。
2. [x] 红：`tests/sticky-note-workspace-memory.test.ts` 写失败测试并注册进
   `tests/index.test.ts`，确认失败。
3. [x] 绿：`updateCard` 便签分支同步写档（截断/上限/空串删条目）；新增
   `clearStickyNoteArchive` action；`state-store` sanitize 路径补
   `normalizePersistedStickyNoteArchive`（加载不走 zod parse，必须手动 normalize）。
4. [x] UI：`StickyNoteCard` 恢复条（恢复/删除记录）+ 卸载 flush；prop 链
   App → WorkspaceColumn → LayoutRenderer → PaneView → ChatCard。
5. [x] i18n 双语文案；恢复条样式用主题 token（`--accent-soft`/`--accent-line`/
   `--ink-*`/`--danger-soft`），双主题自动适配。
6. [x] 验证：窄测试绿（10 项新测试 + 130 项受影响既有测试）+ `pnpm test:quality`；
   `pnpm electron:build` 打包。
