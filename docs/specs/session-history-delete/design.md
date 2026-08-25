# Design — 右键删除历史会话

## 为什么要三处一起删

历史列表里的一条其实由三份数据共同决定可见性（见 `docs/specs/history-sidecar-storage/`、`docs/specs/deep-session-history-search/`）：

| 数据 | 位置 | 不处理的后果 |
|------|------|--------------|
| 轻量索引 | `state.json` 的 `sessionHistory` | 条目继续显示在本地列表 |
| 全文正文 | `session-history/<base64url(entryId)>.json` | 条目消失但磁盘不释放；深搜仍能命中 |
| catalog 索引 / 分段摘要 | `session-history/catalog.json`、`maintenance/session-history-catalog/` | 已删条目被重新索引回列表 |

所以删除动作 = 索引移除（renderer reducer）+ sidecar 删除（server）+ 写入 `catalog-hidden.json` 隐藏名单（server）。
隐藏名单是既有机制（恢复会话时已在用），比重写 catalog 便宜且幂等；catalog 维护切片会在后续轮次自然收敛。

## 后端

新增 `deleteInternalSessionHistoryEntry`（`server/session-history-catalog.ts`）：

1. `rm(getSessionHistoryEntryFilePath(entryId), { force: true })` 删除 sidecar（`force` 让「文件已不在」成为成功）。
2. 复用 `hideInternalSessionHistoryEntries` 写入 `entryId` 与 `provider:sessionId` 隐藏键。
3. 清空进程内 catalog 缓存，避免同一进程里紧接着的搜索仍返回旧条目。

请求体沿用已有形状，新增 `internalSessionHistoryDeleteRequestSchema`（等价于 hide 的 `{entryId, provider, sessionId?}`）。

暴露路径与 hide 完全同构，五处：
`server/index.ts`（`POST /api/session-history/delete`）、`electron/backend.ts`、`electron/main.ts`、`electron/preload.ts`、`src/api.ts`（+ `src/electron.d.ts` 类型）。

### 为什么删 sidecar 不会被保存路径复活

普通保存路径 `mergePersistedSessionHistory` 只用**进程内全量缓存**按 id 补全正文，不会枚举磁盘 sidecar，
因此一个已从 `sessionHistory` 移除的 id 不会被重新写回。唯一会做「磁盘并集」的是崩溃捕获路径
`mergeMissingPersistedHistoryEntries`，它读的是 `state.json` 索引——删除后索引里也没有这一条，同样不会复活。

## 前端

- `WorkspaceColumn` 内新增局部上下文菜单状态 `{ entry, x, y }`，绑定在内部历史条目的 `onContextMenu` 上。
  右键沿用现有 `event.button !== 0` 早退，所以不会误触发恢复。
- 菜单复用 `pane-tab-context-menu` 样式与 `clampFilePathContextMenuPosition` 视口夹取，通过 `createPortal` 挂到 `document.body`。
- **历史菜单的 outside-mousedown 关闭逻辑必须放行上下文菜单节点**：菜单被 portal 到 body 之后，
  点击菜单项的 `mousedown` 落在 `historyMenuRef` 之外，不放行会先把整个历史下拉关掉，菜单项永远点不到。
- 删除走 `window.confirm` 二次确认（与 `FileTreeCard` 删除文件一致）。
- 确认后：本地把该条从 `catalogSessions` 过滤掉（组件内 state，不经 reducer），再调用父级 `onDeleteSessionHistoryEntry(entry)`。
- `App.tsx` 的 handler：`dispatch({ type: 'removeSessionHistory', entryIds: [id] })` → `persistAfterActions`（该 action 已在
  `persistence-queue` 的队列名单里）→ `deleteInternalSessionHistoryEntry({...})`，失败只 `console.error`。

## 风险控制

- `tests/critical-click-actions.test.ts` 对历史条目 JSX 做正则断言，改动 JSX 时保持 `className` 与 `onMouseDown` 相邻关系。
- 新增纯函数 `removeSessionHistoryEntryById` 放 `workspace-column-history.ts`，便于无 DOM 单测。
- server 侧新增测试：删除后 sidecar 文件消失且深搜不再返回该条。
