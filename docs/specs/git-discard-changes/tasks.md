# Git 回退改动（Discard Changes）— Tasks

1. [x] SPEC：requirements / design / tasks。
2. [ ] 红测试：`tests/git-workspace.test.ts` 新增 `discardGitWorkspaceChanges` 用例（tracked 修改、staged 修改、untracked、staged 新增、删除恢复），确认失败。
3. [ ] `shared/schema.ts`：`gitDiscardRequestSchema` + 类型导出。
4. [ ] `server/git-workspace.ts`：实现 `discardGitWorkspaceChanges`。
5. [ ] 桥接：`server/index.ts` `/api/git/discard`、`electron/backend.ts`、`electron/preload.ts`、`electron/main.ts`、`src/electron.d.ts`、`src/api.ts`。
6. [ ] `shared/i18n.ts`：中英文案。
7. [ ] `GitFullDialog.tsx`：单文件回退按钮 + 全部回退 + 内联确认。
8. [ ] tests/electron-bridge.ts mock 增加 discard 转发。
9. [x] 验证：单测绿 + `pnpm test:quality`；合并回 main；重启用户运行时。

## 第二期：多选 + 右键丢弃

10. [ ] SPEC 增补（requirements 11–18、design 选择模型与菜单）。
11. [ ] 红测试：`tests/git-selection.test.ts`（单击/Ctrl/Shift/prune/右键目标解析），确认失败。
12. [ ] `src/components/git-selection.ts`：纯函数实现，测试转绿。
13. [ ] `shared/i18n.ts`：`discardSelected(count)`、`multiSelectTitle(count)`、`multiSelectCopy` 中英文案。
14. [ ] `GitFullDialog.tsx`：多选状态接线、行级 onContextMenu、右键菜单、diff 面板多选占位。
15. [ ] `src/index.css`：菜单与多选行样式（两主题 token）。
16. [ ] 验证：单测绿 + file-scoped lint/类型；合并回用户分支；打包。
