# 便签按工作区记忆 — 设计

## 数据模型（shared/schema.ts）

`appStateSchema` 顶层新增：

```ts
export const stickyNoteArchiveEntrySchema = z.object({
  content: z.string().default(''),
  updatedAt: z.string().datetime(),
  viewState: z.object({
    scrollTop: z.number().nonnegative().default(0),
    selectionStart: z.number().int().nonnegative().default(0),
    selectionEnd: z.number().int().nonnegative().default(0),
  }).optional(),
})
// workspacePath -> entry
stickyNoteArchive: z.record(z.string(), stickyNoteArchiveEntrySchema).default({})
```

- Zod `default({})` 保证旧 `state.json`（无此字段）解析后自动获得空档，
  满足 pitfall #5 的向后兼容要求。
- `shared/default-state.ts` 的 `createDefaultState()` 同步补 `stickyNoteArchive: {}`。

### 体积护栏

- 单条内容截断到 64KB（`STICKY_NOTE_ARCHIVE_MAX_CONTENT_LENGTH`）。
- 最多保留 50 个工作区条目（`STICKY_NOTE_ARCHIVE_MAX_ENTRIES`），超出时按
  `updatedAt` 淘汰最旧的。

## 写入路径（src/state.ts）

`updateCard` reducer 分支：当 patch 含 `stickyNote`、目标卡是便签卡
（`card.model === STICKYNOTE_TOOL_MODEL`）且所属列 `workspacePath` 非空时，
同步把内容写入 `state.stickyNoteArchive[workspacePath]`。

- 内容为空串 → 移除该工作区条目（避免出现"恢复空记录"的无意义入口）。
- 非便签卡（文本/图片编辑器复用 `stickyNote` 存文件路径）不触发存档。

新增 action：

```ts
{ type: 'clearStickyNoteArchive'; workspacePath: string }
```

用于"删除记录"入口，移除对应条目。

## 恢复入口（src/components/StickyNoteCard.tsx）

新增 props：`archivedContent: string`、`onDiscardArchive: () => void`。

- 显示条件：当前便签文本为空 且 `archivedContent` 非空。
- 恢复条内容：提示文案 + 存档首行预览 + 「恢复」「删除记录」两个按钮。
- 「恢复」：立即调用 `onChange(archivedContent)`（不经 500ms debounce），
  外层 wrapper 同步更新卡片标题。
- 「删除记录」：调用 `onDiscardArchive()`，App 层 dispatch
  `clearStickyNoteArchive`。
- 用户直接输入 → 文本非空，恢复条自然消失，新内容照常写档覆盖。
- textarea 的滚动位置与光标/选区在滚动、选择变化和卸载时回写到工作区存档；便签重新挂载时在布局完成后恢复，并将选区限制在当前文本长度内。

### 顺带修复：卸载丢输入

现有 `StickyNoteCard` 在卸载时 `clearTimeout` 直接丢掉尚未提交的 500ms
debounce 内容，关 tab 会丢最后半秒输入。改为卸载时 flush 待提交值。

## Prop 链

`App.tsx` 按列计算 `stickyNoteArchive[column.workspacePath]?.content ?? ''`，
经 `WorkspaceColumn → LayoutRenderer → PaneView → ChatCard → StickyNoteCard`
传递；`onDiscardStickyNoteArchive` 回调走同一条链。

## 主题 / i18n

- 恢复条使用 `src/index.css` 既有 token（背景、边框、按钮色），双主题检查。
- 新文案：`stickyNoteRestorePrompt` / `stickyNoteRestoreAction` /
  `stickyNoteDiscardAction`，zh-CN 与 en 各一份。

## 测试

Tier 1（schema + reducer + 持久化）红→绿：

- `tests/sticky-note-workspace-memory.test.ts`（注册进 `tests/index.test.ts`）：
  1. 便签卡 `updateCard(stickyNote)` 写入对应工作区存档；
  2. 非便签卡（编辑器卡）`stickyNote` patch 不写档；
  3. `workspacePath` 为空不写档；
  4. 清空内容移除条目；
  5. `clearStickyNoteArchive` 移除条目；
  6. 旧 state（无 `stickyNoteArchive` 字段）经 `appStateSchema.parse` 得到空档；
  7. 超过条目上限按 `updatedAt` 淘汰最旧。
- UI 恢复条与卸载 flush 用组件测试覆盖（若现有 tsx 测试基建可复用）。
