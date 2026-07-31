# 工作区便签库与历史版本 — 设计

## 总体方案

保留 `card.stickyNote` 作为渲染器内的即时内容缓存，新增稳定的 `card.stickyNoteId` 和卡片级 `card.stickyNoteViewState`。真正可人工管理的副本写入本地数据目录，由新的 `server/sticky-note-store.ts` 统一负责文件命名、原子写入、历史检查点和旧文件容错。

## 本地目录

```text
<appData>/sticky-notes/<workspace-key>/
  workspace.json
  <可读标题>--<note-id>.md
  .history/<note-id>/<version-id>.json
```

- `workspace-key` 由规范化后的绝对工作区路径做 SHA-256 得到，避免路径字符和大小写差异。
- 当前文件使用可读标题加稳定 ID，重命名只改变可读标题部分。
- `workspace.json` 保存 `noteId -> title/fileName/createdAt/updatedAt` 索引；若用户在系统中删除 Markdown 文件，列表和加载逻辑把它视为已删除，不在应用内重建，除非仍打开的卡片再次产生保存。
- 索引和历史 JSON 使用临时文件 + rename 原子替换。

## 数据与 API

`shared/schema.ts` 新增：

- `chatCardSchema.stickyNoteId?: string`
- `chatCardSchema.stickyNoteViewState?: StickyNoteViewState`
- 便签列表、加载、保存、历史加载、历史恢复的请求/响应 schema。

服务端与 Electron bridge 提供：

- `listStickyNotes(workspacePath)`
- `loadStickyNote(workspacePath, noteId)`
- `saveStickyNote(workspacePath, noteId, title, content, checkpoint)`
- `loadStickyNoteVersion(workspacePath, noteId, versionId)`
- `restoreStickyNoteVersion(workspacePath, noteId, versionId)`
- `searchStickyNotes(workspacePath, query)`
- `revealStickyNoteLocation(workspacePath)`（Electron 主进程直接打开系统文件管理器）

服务端 Web 路径复用同一 store；“打开本地位置”仅在 Electron 可执行，浏览器模式显示不可用提示但不出现删除入口。

## 历史策略

- 普通 500ms 内容保存只更新当前 Markdown 与索引，不生成版本，避免每次按键都污染历史。
- 5 秒无输入、失焦/卸载时发送 `checkpoint: true`；仅当内容或标题与最新检查点不同才新增版本。
- 恢复版本前先把当前内容强制写成检查点，再用目标版本覆盖当前文件，因此恢复操作可逆。
- 每份便签保留最近 50 个版本；内容写入前截断到 64KB。

## 渲染器流程

1. 便签卡使用 `card.stickyNoteId || card.id` 作为默认 ID。
2. 首次挂载加载本地文档：
   - 文件存在：以磁盘内容和标题为准并回写卡片缓存；
   - 文件不存在且卡片有旧内容：保存为迁移后的新本地便签；
   - 文件不存在且卡片为空：暂不创建文件，同时列出该工作区已有便签供打开。
3. 用户输入后更新本地 textarea 与卡片缓存，并异步保存本地文件。
4. 标题编辑继续走现有卡片标题入口；便签组件观察标题变化并调用保存，store 负责重命名文件。
5. 工具栏只包含“历史版本”和“打开本地位置”；没有删除动作。
6. 选择已有便签时，通过 `onBindNote` 一次性更新 `stickyNoteId/title/stickyNote`，避免跨字段中间态。
7. 工具栏增加安静的搜索框；输入 200ms 后调用本地搜索 API，按标题命中优先、更新时间次序返回。空查询回到已有便签列表。搜索读取当前 Markdown，不检索历史版本。
8. 便签标签页标题优先取当前正文第一行（去除首尾空白）；第一行为空时回退到卡片标题，再回退为“便签”。

## 状态迁移

- `createCard()` 新卡无需预创建文件；便签有效 ID 默认回退到卡片 ID。
- `normalizePersistedCard()` 保留旧内容，并为便签卡补齐缺失 ID（使用卡片 ID）。
- 新的视图状态写入 `card.stickyNoteViewState`；旧 `stickyNoteArchive[workspacePath].viewState` 只作为首次迁移回退。
- 工作区级 `stickyNoteArchive` 保留 schema 兼容，但新便签写入不再更新它。

## 测试

- `tests/sticky-note-store.test.ts`：目录隔离、多便签、重命名、检查点去重/上限、恢复前快照、手工删除文件后的列表行为。
- store 测试补标题/正文/大小写/中文/工作区隔离搜索。
- `tests/sticky-note-workspace-memory.test.ts`：ID/视图状态迁移、多个卡片互不覆盖、旧存档回退。
- 组件测试：无删除按钮、有本地位置与历史入口、已有便签选择、历史恢复回调。
- UI：扩展 `tests/theme-check.spec.ts` 覆盖明暗主题与窄视口。
