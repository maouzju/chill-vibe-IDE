# Git 回退改动（Discard Changes）— Tasks

1. [x] SPEC：requirements / design / tasks。
2. [x] 红测试：`tests/git-workspace.test.ts` 新增 `discardGitWorkspaceChanges` 用例（tracked 修改、staged 修改、untracked、staged 新增、删除恢复），确认失败。
3. [x] `shared/schema.ts`：`gitDiscardRequestSchema` + 类型导出。
4. [x] `server/git-workspace.ts`：实现 `discardGitWorkspaceChanges`。
5. [x] 桥接：`server/index.ts` `/api/git/discard`、`electron/backend.ts`、`electron/preload.ts`、`electron/main.ts`、`src/electron.d.ts`、`src/api.ts`。
6. [x] `shared/i18n.ts`：中英文案。
7. [x] `GitFullDialog.tsx`：单文件回退按钮 + 全部回退 + 内联确认。
8. [x] tests/electron-bridge.ts mock 增加 discard 转发。
9. [x] 验证：单测绿 + `pnpm test:quality`；合并回 main；重启用户运行时。

## 第二期：多选 + 右键丢弃

10. [x] SPEC 增补（requirements 11–18、design 选择模型与菜单）。
11. [x] 红测试：`tests/git-selection.test.ts`（单击/Ctrl/Shift/prune/右键目标解析），确认失败。
12. [x] `src/components/git-selection.ts`：纯函数实现，测试转绿。
13. [x] `shared/i18n.ts`：`discardSelected(count)`、`multiSelectTitle(count)`、`multiSelectCopy` 中英文案。
14. [x] `GitFullDialog.tsx`：多选状态接线、行级 onContextMenu、右键菜单、diff 面板多选占位。
15. [x] `src/index.css`：菜单与多选行样式（两主题 token）。
16. [x] 验证：单测绿 + file-scoped lint/类型；合并回用户分支；打包。
17. [x] 修复右键回退反馈断层：确认步骤留在菜单原位，并用 Electron 运行时测试覆盖确认与实际回退。
