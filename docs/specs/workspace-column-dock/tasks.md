# 工作区列停靠到顶栏 — 任务

1. [x] Tier 1 红：`tests/column-dock.test.ts` 加 `dockColumn` / `undockColumn` 与 schema / factory 用例。跑一次确认红。
2. [x] `shared/schema.ts` 加 `docked`；`shared/default-state.ts` 的 `createColumn` 透传。
3. [x] `src/state.ts` 加两个 action 与 reducer 分支。跑步骤 1 的测试确认绿。
4. [x] `shared/i18n.ts` 加两条文案（zh-CN + en）。
5. [x] `src/App.tsx`：看板过滤停靠列；顶栏渲染停靠标签与落区；`columnDragInFlight` effect。
6. [x] `src/index.css`：标签与落区样式（仅 token）。
7. [x] Tier 2：`tests/column-dock.spec.ts` Playwright 用例（点击恢复 + 拖拽停靠），亮暗主题各跑一次。
8. [x] `pnpm test:quality`。
9. [x] `pnpm electron:build` 出包，交付路径。

## 增补（2026-11-03）右键收起 + 动效

10. [x] i18n `dockColumnToTopbar`；`WorkspaceColumn` 项目名右键菜单。
11. [x] `column-dock-animation.ts` 幽灵飞行 + chip 弹入 + 兄弟列 FLIP；App `dockColumnWithAnimation` 接右键与拖拽两条路径。
12. [x] `tests/column-dock.spec.ts` 新增右键 / Esc 用例与菜单快照，逐帧截图人工核对亮暗主题。
