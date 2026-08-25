# Tasks — 右键删除历史会话

1. **红测试（server）** — `tests/session-history-search.test.ts` 新增：写入两条 sidecar，删除其一后
   sidecar 文件不存在且 `searchInternalSessionHistory` 只返回另一条。先跑，确认因 `deleteInternalSessionHistoryEntry` 不存在而失败。
2. **红测试（renderer 纯逻辑）** — `tests/workspace-column.test.ts` 新增 `removeSessionHistoryEntryById` 用例。
3. **实现后端** — `shared/schema.ts` 加 `internalSessionHistoryDeleteRequestSchema`；
   `server/session-history-catalog.ts` 加 `deleteInternalSessionHistoryEntry`；`server/index.ts` 加 `POST /api/session-history/delete`。
4. **打通桥接** — `electron/backend.ts` / `electron/main.ts` / `electron/preload.ts` / `src/electron.d.ts` / `src/api.ts`。
5. **UI** — `WorkspaceColumn.tsx` 上下文菜单 + outside-click 放行；`shared/i18n.ts` 中英文案；`src/index.css` 危险项样式（若缺）。
6. **接线** — `App.tsx` `handleDeleteSessionHistoryEntry` 并传给 `WorkspaceColumn`。
7. **验证** — 跑第 1、2 步的测试文件 + `tests/critical-click-actions.test.ts` + `pnpm test:quality`；确认明暗主题。
8. **打包** — `pnpm electron:build`，报告产物路径。
