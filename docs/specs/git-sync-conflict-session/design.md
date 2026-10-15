# Git 同步冲突交给显式会话 — 设计

## Hub（`src/components/git-operation-hub.ts`）

- `GitOperationContext` 新增可选 `openAgentSession(request)`，`request` 为
  `{ title, prompt, provider: 'codex', model?, reasoningEffort? }`。
- 删除 `resolveConflicts` 后台流及 `syncStep: { kind: 'conflict' }`、`conflictStream`。
- `runSyncPipeline` 检测到 `hasConflicts`：
  - 有 `openAgentSession`：用 `buildConflictSessionPrompt(language, paths)` 组装提示词，
    model / reasoningEffort 由 `gitAgentModel`（`"<model> <effort>"`）拆出；调用后
    `syncPanelOpen=false`、`syncStep=idle`，飘字 `syncConflictHandedOff`（info）。
  - 没有：`syncStep=error`，提示手动解决；不 push。

## 接线

`App` → `WorkspaceColumn` → `LayoutRenderer`（透传）→ `PaneView` → `ChatCard` → `GitToolCard`，
与 `onOpenFile` 同一条路径；`PaneView` 补上自己的 `pane.id`。

`App.openAgentSessionTab(columnId, paneId, request)`：

1. 列不存在则放弃；pane 已不存在（卡片在 pull 期间被拖走）回退到列内记住的 pane / 第一个 pane。
2. `addTab`（预生成 cardId、显式 provider/model/reasoningEffort/title，不带 `spawnedByAgent`，
   因此新 tab 成为活动 tab）并持久化。
3. `sendMessageRef.current(columnId, cardId, prompt, [])` —— 与超管 `admin-create-session`
   的 running 路径相同，`applyAction` 已同步刷新 `appStateRef`，不存在渲染时序竞态。

memo 比较器不比较回调 prop，回调只捕获 `column.id` / `pane.id` 这类稳定值，状态一律从 ref 读。

## 文案

`syncConflictResolving` 替换为 `syncConflictHandedOff`、`syncConflictSessionTitle`、
`syncConflictNoSession`。`GitSyncPanel` 去掉 conflict 分支。
